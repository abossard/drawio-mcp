import * as vscode from 'vscode';

export class DrawioPluginProvider {
    constructor(private readonly config: vscode.WorkspaceConfiguration) {}

    getPlugins(): { jsCode: string }[] {
        const port = this.config.get<number>('websocketPort', 9219);
        const aiColor = this.config.get<string>('aiColor', '#D13913');
        const aiLabel = this.config.get<string>('aiLabel', '🤖 AI');

        const pluginCode = `
// Draw.io MCP Bridge Plugin
// Injected by drawio-mcp-bridge VS Code extension
(function() {
    var SIDECAR_PORT = ${port};
    var AI_COLOR = '${aiColor}';
    var AI_LABEL = '${aiLabel}';
    var ws = null;
    var reconnectTimer = null;

    function connect() {
        try {
            ws = new WebSocket('ws://127.0.0.1:' + SIDECAR_PORT + '/drawio');
            ws.onopen = function() {
                console.log('[drawio-mcp] Connected to sidecar');
                // Send current selection to sidecar
                sendSelectionUpdate();
                sendCursorUpdate();
            };
            ws.onmessage = function(evt) {
                try {
                    var msg = JSON.parse(evt.data);
                    handleSidecarMessage(msg);
                } catch(e) {}
            };
            ws.onclose = function() {
                console.log('[drawio-mcp] Disconnected from sidecar');
                scheduleReconnect();
            };
            ws.onerror = function() {
                scheduleReconnect();
            };
        } catch(e) {
            scheduleReconnect();
        }
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(function() {
            reconnectTimer = null;
            connect();
        }, 5000);
    }

    function handleSidecarMessage(msg) {
        switch(msg.type) {
            case 'cursor':
                updateAiCursor(msg.data);
                break;
            case 'selection':
                updateAiSelection(msg.data);
                break;
            case 'highlight':
                highlightCells(msg.data);
                break;
            case 'unhighlight':
                unhighlightCells(msg.data);
                break;
            case 'status':
                showStatus(msg.data);
                break;
            case 'spinner':
                showSpinner(msg.data);
                break;
            case 'layout':
                applyLayout(msg.data);
                break;
        }
    }

    function updateAiCursor(data) {
        // Use the parent window postMessage to communicate with the VS Code extension
        // which then calls updateLiveshareViewState
        window.parent.postMessage(JSON.stringify({
            event: 'mcpBridgeUpdate',
            liveshareState: {
                cursors: [{
                    id: 'ai-assistant',
                    position: data.position,
                    label: data.label || AI_LABEL,
                    color: data.color || AI_COLOR
                }],
                selectedCells: [],
                selectedRectangles: []
            }
        }), '*');
    }

    function updateAiSelection(data) {
        window.parent.postMessage(JSON.stringify({
            event: 'mcpBridgeUpdate',
            liveshareState: {
                cursors: [],
                selectedCells: [{
                    id: 'ai-assistant',
                    color: data.color || AI_COLOR,
                    selectedCellIds: data.cellIds || []
                }],
                selectedRectangles: []
            }
        }), '*');
    }

    function highlightCells(data) {
        // Send highlight request to parent for style overlay
        window.parent.postMessage(JSON.stringify({
            event: 'mcpBridgeHighlight',
            cellIds: data.cellIds,
            color: data.color || AI_COLOR
        }), '*');
    }

    function unhighlightCells(data) {
        window.parent.postMessage(JSON.stringify({
            event: 'mcpBridgeUnhighlight',
            cellIds: data.cellIds
        }), '*');
    }

    function showStatus(data) {
        window.parent.postMessage(JSON.stringify({
            event: 'mcpBridgeStatus',
            message: data.message,
            modified: false
        }), '*');
    }

    function showSpinner(data) {
        window.parent.postMessage(JSON.stringify({
            event: 'mcpBridgeSpinner',
            message: data.message,
            show: data.show
        }), '*');
    }

    function applyLayout(data) {
        var _ui = window._mcpUi;
        if (!_ui || !_ui.editor || !_ui.editor.graph) return;
        var graph = _ui.editor.graph;
        var layoutType = data.layout || 'hierarchical';
        var layoutObj = null;

        switch (layoutType) {
            case 'hierarchical':
                layoutObj = new mxHierarchicalLayout(graph, data.direction === 'horizontal' ? mxConstants.DIRECTION_WEST : mxConstants.DIRECTION_NORTH);
                if (data.spacing) layoutObj.intraCellSpacing = data.spacing;
                if (data.interRankSpacing) layoutObj.interRankCellSpacing = data.interRankSpacing;
                break;
            case 'organic':
                layoutObj = new mxFastOrganicLayout(graph);
                if (data.spacing) layoutObj.forceConstant = data.spacing;
                break;
            case 'circle':
                layoutObj = new mxCircleLayout(graph);
                if (data.spacing) layoutObj.radius = data.spacing;
                break;
            case 'tree':
                layoutObj = new mxCompactTreeLayout(graph, data.direction === 'horizontal');
                if (data.spacing) layoutObj.levelDistance = data.spacing;
                if (data.interRankSpacing) layoutObj.nodeDistance = data.interRankSpacing;
                break;
            case 'radialTree':
                layoutObj = new mxRadialTreeLayout(graph);
                if (data.spacing) layoutObj.levelDistance = data.spacing;
                break;
            default:
                layoutObj = new mxHierarchicalLayout(graph);
        }

        if (layoutObj) {
            var parent = graph.getDefaultParent();
            graph.getModel().beginUpdate();
            try {
                layoutObj.execute(parent);
            } finally {
                graph.getModel().endUpdate();
            }
            // Trigger autosave so VS Code extension writes updated XML back to disk
            if (_ui.actions && _ui.actions.get('save')) {
                _ui.actions.get('save').funct();
            }
        }

        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({
                type: 'layoutComplete',
                layout: layoutType
            }));
        }
    }

    // Track user selection and send to sidecar
    function sendSelectionUpdate() {
        // This runs inside the draw.io iframe context
        var _ui = window._mcpUi;
        if (_ui && _ui.editor && _ui.editor.graph) {
            var graph = _ui.editor.graph;
            var cells = graph.getSelectionCells();
            var ids = cells.map(function(c) { return c.id; });
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({
                    type: 'userSelection',
                    cellIds: ids
                }));
            }
        }
    }

    function sendCursorUpdate() {
        // Track mouse position in graph coordinates
        var _ui = window._mcpUi;
        if (_ui && _ui.editor && _ui.editor.graph) {
            var graph = _ui.editor.graph;
            graph.addMouseListener({
                mouseDown: function() {},
                mouseMove: function(sender, me) {
                    if (ws && ws.readyState === 1) {
                        var pt = me.getGraphX ? { x: me.getGraphX(), y: me.getGraphY() } : null;
                        if (pt) {
                            ws.send(JSON.stringify({
                                type: 'userCursor',
                                position: pt
                            }));
                        }
                    }
                },
                mouseUp: function() {}
            });

            // Track selection changes
            graph.getSelectionModel().addListener('change', function() {
                sendSelectionUpdate();
            });
        }
    }

    // Initialize when draw.io is ready
    if (typeof Draw !== 'undefined') {
        Draw.loadPlugin(function(ui_instance) {
            // Store ui reference globally for the plugin
            window._mcpUi = ui_instance;
            connect();
            
            // Report plugin loaded
            window.parent.postMessage(JSON.stringify({
                event: 'pluginLoaded',
                pluginId: 'drawio-mcp-bridge'
            }), '*');
        });
    } else {
        // Fallback: try connecting anyway
        setTimeout(connect, 2000);
    }
})();
`;

        return [{ jsCode: pluginCode }];
    }
}
