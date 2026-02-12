import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import {
  startSidecar,
  stopSidecar,
  sendToDrawio,
  hasConnectedClients,
  getClientCount,
  hasConnectedDrawioClient,
  sendToDrawioAndWait,
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
    expect(getClientCount()).toEqual({ extensions: 0, drawioPlugins: 0, relayMode: false, registeredFiles: [] });
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

describe('file-scoped routing', () => {
  it('should register file via query parameter', async () => {
    await startSidecar(TEST_PORT);
    const ws = await connectWs('/drawio?file=%2Ftmp%2Ftest.drawio');
    await new Promise(r => setTimeout(r, 50));

    const counts = getClientCount();
    expect(counts.drawioPlugins).toBe(1);
    expect(counts.registeredFiles.length).toBe(1);
    expect(counts.registeredFiles[0]).toContain('test.drawio');

    ws.close();
  });

  it('should register file via register message', async () => {
    await startSidecar(TEST_PORT);
    const ws = await connectWs('/drawio');
    await new Promise(r => setTimeout(r, 50));

    // No file registered yet
    expect(getClientCount().registeredFiles).toEqual([]);

    // Send register message
    ws.send(JSON.stringify({ type: 'register', filePath: '/tmp/my-diagram.drawio' }));
    await new Promise(r => setTimeout(r, 50));

    const counts = getClientCount();
    expect(counts.registeredFiles.length).toBe(1);
    expect(counts.registeredFiles[0]).toContain('my-diagram.drawio');

    ws.close();
  });

  it('should route filePath-scoped messages only to matching clients', async () => {
    await startSidecar(TEST_PORT);

    // Two draw.io clients for different files
    const wsA = await connectWs('/drawio?file=%2Ftmp%2Fa.drawio');
    const wsB = await connectWs('/drawio?file=%2Ftmp%2Fb.drawio');
    await new Promise(r => setTimeout(r, 50));

    // Send message scoped to file A
    const msgPromiseA = waitForMessage(wsA);
    sendToDrawio({
      type: 'highlight',
      data: { cellIds: ['node1'], color: '#FF0000' },
      filePath: '/tmp/a.drawio',
    });

    const receivedA = await msgPromiseA;
    expect(receivedA.type).toBe('highlight');
    expect(receivedA.data.cellIds).toEqual(['node1']);

    // B should NOT have received the message — give it a moment to be sure
    let bReceived = false;
    wsB.once('message', () => { bReceived = true; });
    await new Promise(r => setTimeout(r, 100));
    expect(bReceived).toBe(false);

    wsA.close();
    wsB.close();
  });

  it('should broadcast messages without filePath to all clients', async () => {
    await startSidecar(TEST_PORT);

    const wsA = await connectWs('/drawio?file=%2Ftmp%2Fa.drawio');
    const wsB = await connectWs('/drawio?file=%2Ftmp%2Fb.drawio');
    await new Promise(r => setTimeout(r, 50));

    const msgPromiseA = waitForMessage(wsA);
    const msgPromiseB = waitForMessage(wsB);

    // No filePath → broadcasts to all
    sendToDrawio({
      type: 'status',
      data: { message: 'hello everyone' },
    });

    const [recvA, recvB] = await Promise.all([msgPromiseA, msgPromiseB]);
    expect(recvA.type).toBe('status');
    expect(recvB.type).toBe('status');

    wsA.close();
    wsB.close();
  });

  it('should clean up file registration on disconnect', async () => {
    await startSidecar(TEST_PORT);
    const ws = await connectWs('/drawio?file=%2Ftmp%2Fcleanup.drawio');
    await new Promise(r => setTimeout(r, 50));

    expect(getClientCount().registeredFiles.length).toBe(1);

    ws.close();
    await new Promise(r => setTimeout(r, 50));

    expect(getClientCount().registeredFiles).toEqual([]);
    expect(getClientCount().drawioPlugins).toBe(0);
  });
});

describe('hasConnectedDrawioClient', () => {
  it('should return false when no clients are connected', async () => {
    await startSidecar(TEST_PORT);
    expect(hasConnectedDrawioClient()).toBe(false);
    expect(hasConnectedDrawioClient('/tmp/test.drawio')).toBe(false);
  });

  it('should return true when a matching file client is connected', async () => {
    await startSidecar(TEST_PORT);
    const ws = await connectWs('/drawio?file=%2Ftmp%2Ftest.drawio');
    await new Promise(r => setTimeout(r, 50));

    expect(hasConnectedDrawioClient()).toBe(true);
    expect(hasConnectedDrawioClient('/tmp/test.drawio')).toBe(true);
    expect(hasConnectedDrawioClient('/tmp/other.drawio')).toBe(false);

    ws.close();
  });
});

describe('request-response protocol', () => {
  it('should resolve sendToDrawioAndWait when draw.io plugin responds', async () => {
    await startSidecar(TEST_PORT);
    const drawioWs = await connectWs('/drawio?file=%2Ftmp%2Ftest.drawio');
    await new Promise(r => setTimeout(r, 50));

    // Simulate: draw.io plugin echoes back a result when it receives a graph-edit
    drawioWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'graph-edit') {
        drawioWs.send(JSON.stringify({
          type: 'graph-edit-result',
          requestId: msg.requestId,
          success: true,
          data: { id: 'node-1' },
        }));
      }
    });

    const result = await sendToDrawioAndWait({
      type: 'graph-edit',
      requestId: 'test-req-1',
      filePath: '/tmp/test.drawio',
      data: { operation: 'addNode', params: { label: 'Test' } },
    });

    expect(result.success).toBe(true);
    expect(result.data.id).toBe('node-1');
    expect(result.requestId).toBe('test-req-1');

    drawioWs.close();
  });

  it('should reject sendToDrawioAndWait on timeout', async () => {
    await startSidecar(TEST_PORT);
    const drawioWs = await connectWs('/drawio?file=%2Ftmp%2Ftest.drawio');
    await new Promise(r => setTimeout(r, 50));

    // Don't respond → should timeout
    await expect(
      sendToDrawioAndWait({
        type: 'graph-edit',
        requestId: 'test-timeout',
        filePath: '/tmp/test.drawio',
        data: { operation: 'addNode', params: { label: 'Test' } },
      }, 200) // short timeout for testing
    ).rejects.toThrow('Timeout');

    drawioWs.close();
  });

  it('should forward graph-edit-result from draw.io to extension clients', async () => {
    await startSidecar(TEST_PORT);
    const drawioWs = await connectWs('/drawio');
    const extWs = await connectWs('/');
    await new Promise(r => setTimeout(r, 50));

    const extMsgPromise = waitForMessage(extWs);

    // Draw.io plugin sends a result
    drawioWs.send(JSON.stringify({
      type: 'graph-edit-result',
      requestId: 'fwd-test',
      success: true,
      data: { id: 'x' },
    }));

    const received = await extMsgPromise;
    expect(received.type).toBe('graph-edit-result');
    expect(received.requestId).toBe('fwd-test');

    drawioWs.close();
    extWs.close();
  });
});
