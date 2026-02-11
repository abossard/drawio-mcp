import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import {
  startSidecar,
  stopSidecar,
  sendToDrawio,
  hasConnectedClients,
  getClientCount,
} from '../sidecar.js';

const TEST_PORT = 19219; // Use a non-default port to avoid conflicts

function connectWs(path: string = '/'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}${path}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

afterEach(() => {
  stopSidecar();
});

describe('sidecar lifecycle', () => {
  it('should start and stop without errors', async () => {
    await startSidecar(TEST_PORT);
    stopSidecar();
  });

  it('should be idempotent on start', async () => {
    await startSidecar(TEST_PORT);
    await startSidecar(TEST_PORT); // should not throw
    stopSidecar();
  });
});

describe('client connections', () => {
  it('should report no clients initially', async () => {
    await startSidecar(TEST_PORT);
    expect(hasConnectedClients()).toBe(false);
    expect(getClientCount()).toEqual({ extensions: 0, drawioPlugins: 0 });
  });

  it('should track extension client connections', async () => {
    await startSidecar(TEST_PORT);
    const ws = await connectWs('/');

    // Give server time to register the client
    await new Promise(r => setTimeout(r, 50));
    expect(hasConnectedClients()).toBe(true);
    expect(getClientCount().extensions).toBe(1);

    ws.close();
    await new Promise(r => setTimeout(r, 50));
    expect(getClientCount().extensions).toBe(0);
  });

  it('should track drawio plugin client connections', async () => {
    await startSidecar(TEST_PORT);
    const ws = await connectWs('/drawio');

    await new Promise(r => setTimeout(r, 50));
    expect(getClientCount().drawioPlugins).toBe(1);

    ws.close();
    await new Promise(r => setTimeout(r, 50));
    expect(getClientCount().drawioPlugins).toBe(0);
  });
});

describe('message routing', () => {
  it('should broadcast sendToDrawio messages to drawio clients', async () => {
    await startSidecar(TEST_PORT);
    const drawioWs = await connectWs('/drawio');
    await new Promise(r => setTimeout(r, 50));

    const msgPromise = waitForMessage(drawioWs);
    sendToDrawio({ type: 'highlight', data: { cellIds: ['a'], color: '#FF0000' } });

    const received = await msgPromise;
    expect(received.type).toBe('highlight');
    expect(received.data.cellIds).toEqual(['a']);

    drawioWs.close();
  });

  it('should broadcast sendToDrawio messages to extension clients', async () => {
    await startSidecar(TEST_PORT);
    const extWs = await connectWs('/');
    await new Promise(r => setTimeout(r, 50));

    const msgPromise = waitForMessage(extWs);
    sendToDrawio({ type: 'status', data: { message: 'hello' } });

    const received = await msgPromise;
    expect(received.type).toBe('status');

    extWs.close();
  });

  it('should forward extension messages to drawio clients', async () => {
    await startSidecar(TEST_PORT);
    const extWs = await connectWs('/');
    const drawioWs = await connectWs('/drawio');
    await new Promise(r => setTimeout(r, 50));

    const msgPromise = waitForMessage(drawioWs);
    extWs.send(JSON.stringify({ type: 'cursor', data: { x: 10, y: 20 } }));

    const received = await msgPromise;
    expect(received.type).toBe('cursor');
    expect(received.data.x).toBe(10);

    extWs.close();
    drawioWs.close();
  });

  it('should forward drawio user events to extension clients', async () => {
    await startSidecar(TEST_PORT);
    const extWs = await connectWs('/');
    const drawioWs = await connectWs('/drawio');
    await new Promise(r => setTimeout(r, 50));

    const msgPromise = waitForMessage(extWs);
    drawioWs.send(JSON.stringify({ type: 'userSelection', cellIds: ['x', 'y'] }));

    const received = await msgPromise;
    expect(received.type).toBe('userSelection');
    expect(received.cellIds).toEqual(['x', 'y']);

    extWs.close();
    drawioWs.close();
  });
});
