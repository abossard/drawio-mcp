import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'node:path';

const DEFAULT_PORT = 9219;
const RECONNECT_DELAY_MS = 3000;

/** Prefixed logger with PID for multi-instance disambiguation */
function log(msg: string): void {
  console.error(`[drawio-mcp pid:${process.pid}] ${msg}`);
}

export interface SidecarMessage {
  type: 'cursor' | 'selection' | 'highlight' | 'unhighlight' | 'status' | 'spinner' | 'layout' | 'graph-edit' | 'graph-read';
  data: any;
  /** Optional: scope this message to draw.io clients editing this file */
  filePath?: string;
  /** Sender process ID — prevents relay echo */
  pid?: number;
  /** Request ID for request-response protocol (graph-edit, graph-read) */
  requestId?: string;
}

export interface UserEvent {
  type: 'userSelection' | 'userCursor';
  cellIds?: string[];
  position?: { x: number; y: number };
}

type UserEventCallback = (event: UserEvent) => void;

// ── Server mode: this process owns the sidecar ──
let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();
const drawioClients = new Set<WebSocket>();  // clients from draw.io plugin (path: /drawio)
const userEventCallbacks: UserEventCallback[] = [];

/** Maps each draw.io WebSocket client to its registered file path (normalized) */
const drawioClientFiles = new Map<WebSocket, string>();

/** Pending request-response promises keyed by requestId */
interface PendingRequest {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingRequests = new Map<string, PendingRequest>();

// ── Relay mode: this process connects as a client to an existing sidecar ──
let relayWs: WebSocket | null = null;
let relayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let relayPort: number = DEFAULT_PORT;
let isRelayMode = false;

/** Normalize a file path for comparison */
function normalizePath(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

/** Get the draw.io clients that match a given file path (or all if no path specified) */
function getTargetDrawioClients(filePath?: string): Set<WebSocket> {
  if (!filePath) {
    return drawioClients; // broadcast to all
  }
  const normalized = normalizePath(filePath);
  const targets = new Set<WebSocket>();
  for (const [ws, registeredFile] of drawioClientFiles) {
    if (ws.readyState === WebSocket.OPEN && registeredFile === normalized) {
      targets.add(ws);
    }
  }
  return targets;
}

// ────────────────────────────────────────────────────
// Connection handler (shared between startSidecar & escalation)
// ────────────────────────────────────────────────────

function attachConnectionHandlers(server: WebSocketServer): void {
  server.on('connection', (ws, req) => {
    const isDrawioPlugin = req.url?.startsWith('/drawio');

    if (isDrawioPlugin) {
      drawioClients.add(ws);
      // Check if file path was passed as query param: /drawio?file=...
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const fileParam = url.searchParams.get('file');
      if (fileParam) {
        drawioClientFiles.set(ws, normalizePath(decodeURIComponent(fileParam)));
        log(`draw.io editor connected — file: ${path.basename(fileParam)} (${drawioClients.size} editor${drawioClients.size > 1 ? 's' : ''} total)`);
      } else {
        log(`draw.io editor connected — no file registered (${drawioClients.size} editor${drawioClients.size > 1 ? 's' : ''} total)`);
      }
    } else {
      clients.add(ws);
      log(`bridge extension connected (${clients.size} bridge${clients.size > 1 ? 's' : ''} total)`);
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Handle register message — draw.io plugin tells us which file it's editing
        if (msg.type === 'register' && isDrawioPlugin && msg.filePath) {
          const normalized = normalizePath(msg.filePath);
          drawioClientFiles.set(ws, normalized);
          log(`draw.io editor registered file: ${path.basename(msg.filePath)}`);
          return;
        }

        // Handle request-response: draw.io plugin sends back a result
        if (isDrawioPlugin && msg.requestId) {
          // Check if this process has a pending request for it
          const pending = pendingRequests.get(msg.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingRequests.delete(msg.requestId);
            pending.resolve(msg);
          }
          // Also forward to extension/relay clients so relay processes can match their pending requests
          const resultPayload = data.toString();
          for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(resultPayload);
            }
          }
          return;
        }

        // Messages from draw.io plugin → broadcast to extension clients
        if (isDrawioPlugin && (msg.type === 'userSelection' || msg.type === 'userCursor')) {
          // Tag with file path so extension can distinguish
          const registeredFile = drawioClientFiles.get(ws);
          if (registeredFile) {
            msg.filePath = registeredFile;
          }
          const tagged = JSON.stringify(msg);

          for (const cb of userEventCallbacks) {
            cb(msg as UserEvent);
          }
          for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(tagged);
            }
          }
        }

        // Messages from extension → forward to draw.io plugin (file-scoped)
        if (!isDrawioPlugin) {
          const targets = getTargetDrawioClients(msg.filePath);
          const payload = data.toString();
          for (const drawioClient of targets) {
            if (drawioClient.readyState === WebSocket.OPEN) {
              drawioClient.send(payload);
            }
          }
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      drawioClients.delete(ws);
      drawioClientFiles.delete(ws);
    });
  });
}

// ────────────────────────────────────────────────────
// Server mode — try to own the port
// ────────────────────────────────────────────────────

/** Try to bind a new WebSocketServer on the given port.
 *  Resolves if successful, rejects (with error) if port is in use or other error. */
function tryBindServer(port: number): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ port, host: '127.0.0.1' });

    server.on('listening', () => {
      resolve(server);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      server.close();
      reject(err);
    });
  });
}

/** Transition this process into server mode with the given WebSocketServer. */
function becomeServer(server: WebSocketServer, port: number): void {
  // Clean up any relay state
  if (relayWs) {
    relayWs.close();
    relayWs = null;
  }
  if (relayReconnectTimer) {
    clearTimeout(relayReconnectTimer);
    relayReconnectTimer = null;
  }
  isRelayMode = false;

  wss = server;
  attachConnectionHandlers(server);
  console.error(`[drawio-mcp pid:${process.pid}] sidecar listening on ws://127.0.0.1:${port} (server mode)`);
}

// ────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────

/** Start the WebSocket sidecar server, or fall back to relay mode if port is taken */
export function startSidecar(port: number = DEFAULT_PORT): Promise<void> {
  relayPort = port;

  if (wss || isRelayMode) {
    return Promise.resolve();
  }

  return tryBindServer(port)
    .then((server) => {
      becomeServer(server, port);
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log(`port ${port} already in use by another instance — switching to relay mode`);
        return connectRelay(port).catch(() => {
          log(`relay connection failed — will retry in ${RECONNECT_DELAY_MS / 1000}s`);
          scheduleReconnect(port);
        });
      }
      throw err;
    });
}

// ────────────────────────────────────────────────────
// Relay mode — connect as client to existing sidecar
// ────────────────────────────────────────────────────

/** Connect as a relay client to an existing sidecar on the given port */
function connectRelay(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}`;
    const ws = new WebSocket(url);

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('Relay connection timeout'));
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timeout);
      relayWs = ws;
      isRelayMode = true;
      log(`relay connected to primary sidecar at ${url}`);
      resolve();
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Check for pending request responses (graph-edit-result, graph-read-result)
        if (msg.requestId && pendingRequests.has(msg.requestId)) {
          const pending = pendingRequests.get(msg.requestId)!;
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.requestId);
          pending.resolve(msg);
          return;
        }
        // Forward user events from sidecar to local callbacks
        if (msg.type === 'userSelection' || msg.type === 'userCursor') {
          for (const cb of userEventCallbacks) {
            cb(msg as UserEvent);
          }
        }
      } catch {
        // ignore
      }
    });

    ws.on('close', () => {
      relayWs = null;
      log('relay lost connection to primary sidecar — attempting to become server or reconnect');
      scheduleReconnect(port);
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      relayWs = null;
      reject(err);
    });
  });
}

// ────────────────────────────────────────────────────
// Reconnect loop — escalates to server when possible
// ────────────────────────────────────────────────────

/** Shared reconnect: try to become server first, fall back to relay client.
 *  This handles the case where the previous server died and the port is now free. */
function scheduleReconnect(port: number): void {
  if (relayReconnectTimer) return;
  relayReconnectTimer = setTimeout(async () => {
    relayReconnectTimer = null;

    // 1️⃣ Try to claim the port as server (previous owner may have died)
    try {
      const server = await tryBindServer(port);
      becomeServer(server, port);
      return; // Success — we are now the server
    } catch {
      // Port still in use by someone else — stay in relay/client mode
    }

    // 2️⃣ Fall back to relay client
    try {
      await connectRelay(port);
    } catch {
      // Both failed — schedule another attempt
      log(`reconnect failed (server bind + relay) — retrying in ${RECONNECT_DELAY_MS / 1000}s`);
      scheduleReconnect(port);
    }
  }, RECONNECT_DELAY_MS);
}

/** Stop the sidecar server or relay connection */
export function stopSidecar(): void {
  if (wss) {
    for (const client of [...clients, ...drawioClients]) {
      client.close();
    }
    wss.close();
    wss = null;
    clients.clear();
    drawioClients.clear();
    drawioClientFiles.clear();
    // Reject any pending requests
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Sidecar stopped'));
    }
    pendingRequests.clear();
  }
  if (relayWs) {
    relayWs.close();
    relayWs = null;
  }
  if (relayReconnectTimer) {
    clearTimeout(relayReconnectTimer);
    relayReconnectTimer = null;
  }
  isRelayMode = false;
}

/** Send a message to draw.io plugin clients (or relay through existing sidecar).
 *  When msg.filePath is set, only sends to draw.io clients registered for that file.
 *  When msg.filePath is absent, broadcasts to all draw.io clients. */
export function sendToDrawio(msg: SidecarMessage): void {
  // Tag with sender PID for relay echo prevention
  msg.pid = process.pid;
  const payload = JSON.stringify(msg);

  if (isRelayMode && relayWs?.readyState === WebSocket.OPEN) {
    // In relay mode, send through the existing sidecar which will route appropriately
    relayWs.send(payload);
    return;
  }

  // Server mode: send to file-scoped draw.io clients
  const targets = getTargetDrawioClients(msg.filePath);
  for (const client of targets) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
  // Also send to extension clients (they can filter by filePath themselves)
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

/** Register callback for user events from draw.io */
export function onUserEvent(callback: UserEventCallback): void {
  userEventCallbacks.push(callback);
}

/** Check if any clients are connected (server mode) or relay is active */
export function hasConnectedClients(): boolean {
  if (isRelayMode) {
    return relayWs?.readyState === WebSocket.OPEN;
  }
  return clients.size > 0 || drawioClients.size > 0;
}

/** Get connected client count */
export function getClientCount(): { extensions: number; drawioPlugins: number; relayMode: boolean; registeredFiles: string[] } {
  if (isRelayMode) {
    return {
      extensions: 0,
      drawioPlugins: 0,
      relayMode: true,
      registeredFiles: [],
    };
  }
  const files = [...new Set(drawioClientFiles.values())];
  return { extensions: clients.size, drawioPlugins: drawioClients.size, relayMode: false, registeredFiles: files };
}

/** Check if a specific file has a connected draw.io editor (server mode only) */
export function hasConnectedDrawioClient(filePath?: string): boolean {
  if (isRelayMode) return false; // Can't check in relay mode
  if (!filePath) return drawioClients.size > 0;
  const normalized = normalizePath(filePath);
  for (const [ws, registeredFile] of drawioClientFiles) {
    if (ws.readyState === WebSocket.OPEN && registeredFile === normalized) {
      return true;
    }
  }
  return false;
}

/** Send a message to a draw.io plugin and wait for a response with matching requestId.
 *  Returns the full response message. Rejects on timeout. */
export function sendToDrawioAndWait(msg: SidecarMessage & { requestId: string }, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(msg.requestId);
      reject(new Error('Timeout waiting for draw.io editor response (is the diagram open?)'));
    }, timeoutMs);

    pendingRequests.set(msg.requestId, { resolve, reject, timer });
    sendToDrawio(msg);
  });
}
