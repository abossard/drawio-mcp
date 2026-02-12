import * as vscode from 'vscode';

export class DrawioPluginProvider {
    constructor(private readonly config: vscode.WorkspaceConfiguration) {}

    getPlugins(): { jsCode: string }[] {
        const port = this.config.get<number>('websocketPort', 9219);
        const aiColor = this.config.get<string>('aiColor', '#D13913');
        const aiLabel = this.config.get<string>('aiLabel', '🤖 AI');

        const pluginCode = `
// Draw.io MCP Bridge Plugin — direct mxGraph manipulation
(function() {
    var SIDECAR_PORT = ${port};
    var AI_COLOR = '${aiColor}';
    var AI_LABEL = '${aiLabel}';
    var ws = null;
    var reconnectTimer = null;
    var _ui = null;
    var _graph = null;

    // ── Overlay tracking ──
    var highlightOverlays = {};   // cellId -> mxCellHighlight
    var cursorDiv = null;
    var selectionOverlays = {};   // cellId -> mxCellHighlight
    var statusDiv = null;
    var spinnerDiv = null;
    var logDiv = null;
    var logEntries = [];
    var MAX_LOG = 30;

    function getGraph() {
        if (_graph) return _graph;
        if (_ui && _ui.editor) _graph = _ui.editor.graph;
        return _graph;
    }

    // ── Activity Log Panel ──
    function ensureLogPanel() {
        if (logDiv) return;
        var graph = getGraph();
        if (!graph) return;
        var container = graph.container;

        logDiv = document.createElement('div');
        logDiv.style.cssText = 'position:absolute;top:10px;left:10px;z-index:9998;' +
            'width:280px;max-height:300px;overflow-y:auto;' +
            'background:rgba(0,0,0,0.82);color:#e0e0e0;border-radius:8px;' +
            'font-family:monospace;font-size:11px;padding:0;' +
            'box-shadow:0 4px 16px rgba(0,0,0,0.5);pointer-events:auto;';

        // Header bar
        var header = document.createElement('div');
        header.style.cssText = 'padding:6px 10px;background:rgba(255,255,255,0.1);' +
            'border-radius:8px 8px 0 0;font-weight:bold;font-size:12px;' +
            'display:flex;justify-content:space-between;align-items:center;cursor:pointer;';
        header.innerHTML = '<span>🤖 MCP Bridge</span><span style="color:#4CAF50;">● connected</span>';

        var logContent = document.createElement('div');
        logContent.id = 'mcp-log-content';
        logContent.style.cssText = 'padding:4px 8px;max-height:250px;overflow-y:auto;';

        // Toggle collapse on header click
        var collapsed = false;
        header.onclick = function() {
            collapsed = !collapsed;
            logContent.style.display = collapsed ? 'none' : 'block';
        };

        logDiv.appendChild(header);
        logDiv.appendChild(logContent);
        container.appendChild(logDiv);

        addLog('✅ Bridge connected to ws://127.0.0.1:' + SIDECAR_PORT, '#4CAF50');
    }

    function addLog(message, color) {
        ensureLogPanel();
        var logContent = document.getElementById('mcp-log-content');
        if (!logContent) return;

        var now = new Date();
        var time = now.getHours().toString().padStart(2,'0') + ':' +
                   now.getMinutes().toString().padStart(2,'0') + ':' +
                   now.getSeconds().toString().padStart(2,'0');

        var entry = document.createElement('div');
        entry.style.cssText = 'padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.05);';
        entry.innerHTML = '<span style="color:#888;">' + time + '</span> ' +
            '<span style="color:' + (color || '#e0e0e0') + ';">' + message + '</span>';

        logContent.appendChild(entry);
        logEntries.push(entry);

        // Trim old entries
        while (logEntries.length > MAX_LOG) {
            var old = logEntries.shift();
            if (old && old.parentNode) old.parentNode.removeChild(old);
        }

        // Auto-scroll
        logContent.scrollTop = logContent.scrollHeight;
    }

    function updateLogHeader(connected) {
        if (!logDiv) return;
        var header = logDiv.querySelector('div');
        if (header) {
            var dot = connected ?
                '<span style="color:#4CAF50;">● connected</span>' :
                '<span style="color:#F44336;">● disconnected</span>';
            header.innerHTML = '<span>🤖 MCP Bridge</span>' + dot;
        }
    }

    // ── WebSocket ──
    function connect() {
        try {
            ws = new WebSocket('ws://127.0.0.1:' + SIDECAR_PORT + '/drawio');
            ws.onopen = function() {
                console.log('[drawio-mcp] Connected to sidecar');
                ensureLogPanel();
                updateLogHeader(true);
                addLog('WebSocket opened', '#4CAF50');
                setupUserTracking();
            };
            ws.onmessage = function(evt) {
                try {
                    var msg = JSON.parse(evt.data);
                    addLog('⬇ ' + msg.type + (msg.data ? ' ' + summarize(msg.data) : ''), '#64B5F6');
                    handleMessage(msg);
                } catch(e) {
                    console.error('[drawio-mcp] Bad message:', e);
                    addLog('⚠ Parse error', '#F44336');
                }
            };
            ws.onclose = function() {
                console.log('[drawio-mcp] Disconnected');
                addLog('WebSocket closed', '#FF9800');
                updateLogHeader(false);
                scheduleReconnect();
            };
            ws.onerror = function() {
                addLog('⚠ Connection error', '#F44336');
                scheduleReconnect();
            };
        } catch(e) {
            addLog('⚠ Failed to connect', '#F44336');
            scheduleReconnect();
        }
    }

    function summarize(data) {
        if (data.cellIds) return '[' + data.cellIds.join(', ') + ']';
        if (data.message) return '"' + data.message.substring(0, 40) + '"';
        if (data.position) return '(' + data.position.x + ',' + data.position.y + ')';
        if (data.layout) return data.layout;
        if (data.show !== undefined) return data.show ? 'show' : 'hide';
        return '';
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(function() {
            reconnectTimer = null;
            connect();
        }, 5000);
    }

    function handleMessage(msg) {
        switch(msg.type) {
            case 'highlight':   doHighlight(msg.data); break;
            case 'unhighlight': doUnhighlight(msg.data); break;
            case 'cursor':      doCursor(msg.data); break;
            case 'selection':   doSelection(msg.data); break;
            case 'status':      doStatus(msg.data); break;
            case 'spinner':     doSpinner(msg.data); break;
            case 'layout':      doLayout(msg.data); break;
        }
    }

    // ── HIGHLIGHT: flash cells with colored border using mxCellHighlight ──
    function doHighlight(data) {
        var graph = getGraph();
        if (!graph) return;
        var color = data.color || AI_COLOR;
        var cellIds = data.cellIds || [];

        cellIds.forEach(function(id) {
            var cell = graph.model.getCell(id);
            if (!cell) return;

            // Remove existing highlight on this cell
            if (highlightOverlays[id]) {
                highlightOverlays[id].destroy();
                delete highlightOverlays[id];
            }

            var hl = new mxCellHighlight(graph, color, 3, false);
            hl.highlight(graph.view.getState(cell));
            highlightOverlays[id] = hl;
        });
    }

    function doUnhighlight(data) {
        var cellIds = data.cellIds || [];
        if (cellIds.length === 0) {
            // Unhighlight all
            for (var id in highlightOverlays) {
                highlightOverlays[id].destroy();
            }
            highlightOverlays = {};
        } else {
            cellIds.forEach(function(id) {
                if (highlightOverlays[id]) {
                    highlightOverlays[id].destroy();
                    delete highlightOverlays[id];
                }
            });
        }
    }

    // ── CURSOR: floating label at graph coordinates ──
    function doCursor(data) {
        var graph = getGraph();
        if (!graph) return;
        var container = graph.container;

        if (!cursorDiv) {
            cursorDiv = document.createElement('div');
            cursorDiv.style.cssText = 'position:absolute;pointer-events:none;z-index:9999;' +
                'padding:3px 8px;border-radius:4px;font-size:12px;font-weight:bold;' +
                'white-space:nowrap;transition:left 0.3s ease,top 0.3s ease;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
            container.appendChild(cursorDiv);
        }

        var color = data.color || AI_COLOR;
        var label = data.label || AI_LABEL;
        cursorDiv.style.background = color;
        cursorDiv.style.color = '#fff';
        cursorDiv.textContent = label;

        // Convert graph coordinates to screen coordinates
        var state = graph.view;
        var sx = state.translate.x + data.position.x * state.scale;
        var sy = state.translate.y + data.position.y * state.scale;
        cursorDiv.style.left = sx + 'px';
        cursorDiv.style.top = sy + 'px';
        cursorDiv.style.display = 'block';
    }

    // ── SELECTION: highlight multiple cells as AI-selected ──
    function doSelection(data) {
        var graph = getGraph();
        if (!graph) return;
        var color = data.color || AI_COLOR;
        var cellIds = data.cellIds || [];

        // Clear previous selection overlays
        for (var id in selectionOverlays) {
            selectionOverlays[id].destroy();
        }
        selectionOverlays = {};

        cellIds.forEach(function(id) {
            var cell = graph.model.getCell(id);
            if (!cell) return;
            var hl = new mxCellHighlight(graph, color, 4, true);
            hl.highlight(graph.view.getState(cell));
            selectionOverlays[id] = hl;
        });
    }

    // ── STATUS: toast message at the bottom of the editor ──
    function doStatus(data) {
        var graph = getGraph();
        if (!graph) return;
        var container = graph.container;

        if (!statusDiv) {
            statusDiv = document.createElement('div');
            statusDiv.style.cssText = 'position:absolute;bottom:20px;left:50%;transform:translateX(-50%);' +
                'z-index:9999;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:500;' +
                'background:rgba(0,0,0,0.85);color:#fff;pointer-events:none;' +
                'transition:opacity 0.4s ease;box-shadow:0 4px 12px rgba(0,0,0,0.4);white-space:nowrap;';
            container.appendChild(statusDiv);
        }

        statusDiv.textContent = data.message || '';
        statusDiv.style.opacity = '1';
        statusDiv.style.display = 'block';

        // Auto-hide after 4 seconds
        if (statusDiv._timer) clearTimeout(statusDiv._timer);
        statusDiv._timer = setTimeout(function() {
            statusDiv.style.opacity = '0';
            setTimeout(function() { statusDiv.style.display = 'none'; }, 400);
        }, 4000);
    }

    // ── SPINNER: loading indicator ──
    function doSpinner(data) {
        var graph = getGraph();
        if (!graph) return;
        var container = graph.container;

        if (!spinnerDiv) {
            spinnerDiv = document.createElement('div');
            spinnerDiv.style.cssText = 'position:absolute;top:20px;right:20px;z-index:9999;' +
                'padding:8px 16px;border-radius:8px;font-size:13px;font-weight:500;' +
                'background:rgba(0,0,0,0.85);color:#fff;pointer-events:none;' +
                'display:flex;align-items:center;gap:8px;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
            container.appendChild(spinnerDiv);
        }

        if (data.show) {
            spinnerDiv.innerHTML = '<span style="display:inline-block;width:14px;height:14px;' +
                'border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;' +
                'animation:mcpSpin 0.8s linear infinite;"></span> ' + (data.message || 'Working...');
            spinnerDiv.style.display = 'flex';

            // Inject keyframe if not already present
            if (!document.getElementById('mcp-spin-style')) {
                var style = document.createElement('style');
                style.id = 'mcp-spin-style';
                style.textContent = '@keyframes mcpSpin { to { transform: rotate(360deg); } }';
                document.head.appendChild(style);
            }
        } else {
            spinnerDiv.style.display = 'none';
        }
    }

    // ── LAYOUT: apply mxGraph auto-layout ──
    function doLayout(data) {
        var graph = getGraph();
        if (!graph) return;
        var layoutType = data.layout || 'hierarchical';
        var layoutObj = null;

        switch (layoutType) {
            case 'hierarchical':
                layoutObj = new mxHierarchicalLayout(graph,
                    data.direction === 'horizontal' ? mxConstants.DIRECTION_WEST : mxConstants.DIRECTION_NORTH);
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
        }

        if (layoutObj) {
            graph.getModel().beginUpdate();
            try { layoutObj.execute(graph.getDefaultParent()); }
            finally { graph.getModel().endUpdate(); }
        }

        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'layoutComplete', layout: layoutType }));
        }
    }

    // ── User tracking → sidecar ──
    function setupUserTracking() {
        var graph = getGraph();
        if (!graph) return;

        // Selection changes
        graph.getSelectionModel().addListener('change', function() {
            var cells = graph.getSelectionCells();
            var ids = cells.map(function(c) { return c.id; });
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'userSelection', cellIds: ids }));
            }
        });
    }

    // ── Init ──
    if (typeof Draw !== 'undefined') {
        Draw.loadPlugin(function(ui) {
            _ui = ui;
            _graph = ui.editor.graph;
            console.log('[drawio-mcp] Plugin loaded, connecting to sidecar...');
            connect();
        });
    } else {
        setTimeout(connect, 2000);
    }
})();
`;

        return [{ jsCode: pluginCode }];
    }
}
