import * as vscode from 'vscode';
import { DrawioPluginProvider } from './plugin-provider';

let bridgeClient: any | undefined;

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('drawioMcpBridge');
    const port = config.get<number>('websocketPort', 9219);
    const autoConnect = config.get<boolean>('autoConnect', true);

    // Register as draw.io extension plugin provider
    const pluginProvider = new DrawioPluginProvider(config);

    // Register commands — lazy-load BridgeClient to avoid crash if 'ws' is missing
    context.subscriptions.push(
        vscode.commands.registerCommand('drawio-mcp-bridge.connect', async () => {
            if (bridgeClient?.isConnected) {
                vscode.window.showInformationMessage('Already connected to MCP sidecar');
                return;
            }
            try {
                const { BridgeClient } = await import('./bridge-client');
                bridgeClient = new BridgeClient(port);
                attachBridgeListeners(bridgeClient);
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
    function attachBridgeListeners(client: any) {
        client.on('message', (msg: any) => {
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

    // Auto-connect if configured — lazy-load to avoid crash
    if (autoConnect) {
        import('./bridge-client').then(({ BridgeClient }) => {
            bridgeClient = new BridgeClient(port);
            attachBridgeListeners(bridgeClient);
            bridgeClient.connect().catch(() => {
                // Silently fail — server might not be running yet
            });
        }).catch(() => {
            // 'ws' module not available — bridge won't connect but draw.io plugin still works
            console.warn('[drawio-mcp-bridge] ws module not available, bridge client disabled');
        });
    }

    // CRITICAL: Always return the draw.io plugin API — this must never fail
    return {
        drawioExtensionV1: {
            getDrawioPlugins: async (_context: { uri: vscode.Uri }) => {
                return pluginProvider.getPlugins(_context.uri);
            },
        },
    };
}

export function deactivate() {
    bridgeClient?.disconnect();
}
