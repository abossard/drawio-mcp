import * as vscode from 'vscode';
import { BridgeClient } from './bridge-client';
import { DrawioPluginProvider } from './plugin-provider';

let bridgeClient: BridgeClient | undefined;

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('drawioMcpBridge');
    const port = config.get<number>('websocketPort', 9219);
    const autoConnect = config.get<boolean>('autoConnect', true);

    // Register as draw.io extension plugin provider
    const pluginProvider = new DrawioPluginProvider(config);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('drawio-mcp-bridge.connect', async () => {
            if (bridgeClient?.isConnected) {
                vscode.window.showInformationMessage('Already connected to MCP sidecar');
                return;
            }
            bridgeClient = new BridgeClient(port);
            attachBridgeListeners(bridgeClient);
            try {
                await bridgeClient.connect();
                vscode.window.showInformationMessage(`Connected to drawio-mcp sidecar on port ${port}`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to connect: ${err.message}`);
            }
        }),
        vscode.commands.registerCommand('drawio-mcp-bridge.disconnect', () => {
            bridgeClient?.disconnect();
            bridgeClient = undefined;
            vscode.window.showInformationMessage('Disconnected from MCP sidecar');
        })
    );

    // Listen for bridge client messages (command/control channel)
    function attachBridgeListeners(client: BridgeClient) {
        client.on('message', (msg: any) => {
            // Log sidecar command/control messages for diagnostics
            if (msg.type === 'status') {
                vscode.window.setStatusBarMessage(`$(hubot) ${msg.data?.message ?? 'AI active'}`, 5000);
            }
        });
        client.on('connected', () => {
            vscode.window.setStatusBarMessage('$(plug) MCP sidecar connected', 3000);
        });
        client.on('disconnected', () => {
            vscode.window.setStatusBarMessage('$(debug-disconnect) MCP sidecar disconnected', 3000);
        });
    }

    // Auto-connect if configured
    if (autoConnect) {
        bridgeClient = new BridgeClient(port);
        attachBridgeListeners(bridgeClient);
        bridgeClient.connect().catch(() => {
            // Silently fail on auto-connect — server might not be running
        });
    }

    // Provide the draw.io extension API
    return {
        drawioExtensionV1: {
            getDrawioPlugins: async (_context: { uri: vscode.Uri }) => {
                return pluginProvider.getPlugins();
            },
        },
    };
}

export function deactivate() {
    bridgeClient?.disconnect();
}
