import { WebSocketServer, WebSocket } from 'ws';

const DEFAULT_PORT = 9219;

export interface SidecarMessage {
  type: 'cursor' | 'selection' | 'highlight' | 'unhighlight' | 'status' | 'spinner' | 'layout';
  data: any;
}

export interface UserEvent {
  type: 'userSelection' | 'userCursor';
  cellIds?: string[];
  position?: { x: number; y: number };
}

type UserEventCallback = (event: UserEvent) => void;

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();
const drawioClients = new Set<WebSocket>();  // clients from draw.io plugin (path: /drawio)
const userEventCallbacks: UserEventCallback[] = [];

/** Start the WebSocket sidecar server */
export function startSidecar(port: number = DEFAULT_PORT): Promise<void> {
  return new Promise((resolve, reject) => {
    if (wss) {
      resolve();
      return;
    }

    wss = new WebSocketServer({ port, host: '127.0.0.1' });

    wss.on('listening', () => {
      console.error(`[drawio-mcp] Sidecar WebSocket server listening on ws://127.0.0.1:${port}`);
      resolve();
    });

    wss.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[drawio-mcp] Sidecar port ${port} in use, skipping sidecar`);
        wss = null;
        resolve();  // Don't fail — sidecar is optional
      } else {
        reject(err);
      }
    });

    wss.on('connection', (ws, req) => {
      const isDrawioPlugin = req.url === '/drawio';
      
      if (isDrawioPlugin) {
        drawioClients.add(ws);
        console.error(`[drawio-mcp] Draw.io plugin connected (${drawioClients.size} total)`);
      } else {
        clients.add(ws);
        console.error(`[drawio-mcp] Extension client connected (${clients.size} total)`);
      }

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          
          // Messages from draw.io plugin → broadcast to extension clients
          if (isDrawioPlugin && (msg.type === 'userSelection' || msg.type === 'userCursor')) {
            for (const cb of userEventCallbacks) {
              cb(msg as UserEvent);
            }
            // Also forward to extension clients
            for (const client of clients) {
              if (client.readyState === WebSocket.OPEN) {
                client.send(data.toString());
              }
            }
          }
          
          // Messages from extension → forward to draw.io plugin
          if (!isDrawioPlugin) {
            for (const drawioClient of drawioClients) {
              if (drawioClient.readyState === WebSocket.OPEN) {
                drawioClient.send(data.toString());
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
      });
    });
  });
}

/** Stop the sidecar server */
export function stopSidecar(): void {
  if (wss) {
    for (const client of [...clients, ...drawioClients]) {
      client.close();
    }
    wss.close();
    wss = null;
    clients.clear();
    drawioClients.clear();
  }
}

/** Send a message to all draw.io plugin clients */
export function sendToDrawio(msg: SidecarMessage): void {
  const payload = JSON.stringify(msg);
  for (const client of drawioClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
  // Also send to extension clients
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

/** Check if any clients are connected */
export function hasConnectedClients(): boolean {
  return clients.size > 0 || drawioClients.size > 0;
}

/** Get connected client count */
export function getClientCount(): { extensions: number; drawioPlugins: number } {
  return { extensions: clients.size, drawioPlugins: drawioClients.size };
}
