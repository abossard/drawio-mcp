import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface SidecarMessage {
    type: 'cursor' | 'selection' | 'highlight' | 'status' | 'spinner' | 'unhighlight';
    data: any;
}

export class BridgeClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private _isConnected = false;

    constructor(private readonly port: number) {
        super();
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const url = `ws://127.0.0.1:${this.port}`;
            this.ws = new WebSocket(url);

            const timeout = setTimeout(() => {
                this.ws?.terminate();
                reject(new Error('Connection timeout'));
            }, 5000);

            this.ws.on('open', () => {
                clearTimeout(timeout);
                this._isConnected = true;
                this.emit('connected');
                resolve();
            });

            this.ws.on('message', (data) => {
                try {
                    const msg: SidecarMessage = JSON.parse(data.toString());
                    this.emit('message', msg);
                } catch {
                    // ignore malformed messages
                }
            });

            this.ws.on('close', () => {
                this._isConnected = false;
                this.emit('disconnected');
                this.scheduleReconnect();
            });

            this.ws.on('error', (err) => {
                clearTimeout(timeout);
                this._isConnected = false;
                reject(err);
            });
        });
    }

    send(msg: object): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    disconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.ws?.close();
        this.ws = null;
        this._isConnected = false;
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch(() => {});
        }, 5000);
    }
}
