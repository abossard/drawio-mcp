import * as vscode from 'vscode';

export class DrawioPluginProvider {
    constructor(private readonly config: vscode.WorkspaceConfiguration) {}

    getPlugins(uri?: vscode.Uri): { jsCode: string }[] {
        const port = this.config.get<number>('websocketPort', 9219);
        const aiColor = this.config.get<string>('aiColor', '#D13913');
        const aiLabel = this.config.get<string>('aiLabel', '🤖 AI');
        // Pass the file path to the plugin so it can register with the sidecar
        const filePath = uri ? uri.fsPath : '';

        const pluginCode = `
// Draw.io MCP Bridge Plugin — direct mxGraph manipulation
(function() {
    var SIDECAR_PORT = ${port};
    var AI_COLOR = '${aiColor}';
    var AI_LABEL = '${aiLabel}';
    var FILE_PATH = ${JSON.stringify(filePath)};
    var ws = null;
    var reconnectTimer = null;
    var _ui = null;
    var _graph = null;

    // ── Overlay tracking ──
    var highlightOverlays = {};   // cellId -> mxCellHighlight
    var highlightTimers = {};     // cellId -> timeout
    var cursorDiv = null;
    var cursorHideTimer = null;
    var selectionOverlays = {};   // cellId -> mxCellHighlight
    var selectionHideTimer = null;
    var statusDiv = null;
    var spinnerDiv = null;
    var spinnerRotation = 0;
    var spinnerInterval = null;
    var spinnerDot = null;
    var logDiv = null;
    var logContent = null;
    var logEntries = [];
    var logCollapsed = true;      // start collapsed
    var MAX_LOG = 30;

    function getGraph() {
        if (_graph) return _graph;
        if (_ui && _ui.editor) _graph = _ui.editor.graph;
        return _graph;
    }

    // ── Clear all overlays ──
    function clearAllOverlays() {
        // Highlights
        for (var id in highlightOverlays) {
            highlightOverlays[id].destroy();
        }
        highlightOverlays = {};
        for (var tid in highlightTimers) {
            clearTimeout(highlightTimers[tid]);
        }
        highlightTimers = {};

        // Cursor
        if (cursorDiv) {
            cursorDiv.style.display = 'none';
            cursorDiv.style.opacity = '0';
        }
        if (cursorHideTimer) { clearTimeout(cursorHideTimer); cursorHideTimer = null; }

        // Selection
        clearSelection();
        if (selectionHideTimer) { clearTimeout(selectionHideTimer); selectionHideTimer = null; }

        // Status
        if (statusDiv) {
            statusDiv.style.display = 'none';
            statusDiv.style.opacity = '0';
            if (statusDiv._timer) { clearTimeout(statusDiv._timer); statusDiv._timer = null; }
        }

        // Spinner
        if (spinnerDiv) spinnerDiv.style.display = 'none';
        if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }

        addLog('🧹 Cleared all overlays', '#FF9800');
        updateOverlayCount();
    }

    // ── Overlay counter ──
    function countActiveOverlays() {
        var n = 0;
        for (var k in highlightOverlays) n++;
        for (var k2 in selectionOverlays) n++;
        if (cursorDiv && cursorDiv.style.display !== 'none' && cursorDiv.style.opacity !== '0') n++;
        if (statusDiv && statusDiv.style.display !== 'none' && statusDiv.style.opacity !== '0') n++;
        if (spinnerDiv && spinnerDiv.style.display !== 'none') n++;
        return n;
    }

    function updateOverlayCount() {
        var badge = document.getElementById('mcp-overlay-count');
        if (!badge) return;
        var n = countActiveOverlays();
        badge.textContent = n > 0 ? n.toString() : '';
        badge.style.display = n > 0 ? 'inline-block' : 'none';
    }

    // ── Activity Log Panel (starts minimized — just a small pill) ──
    // Appended to document.body with position:fixed so it's not clipped by graph.container overflow
    function ensureLogPanel() {
        if (logDiv) return;
        var graph = getGraph();
        if (!graph) return;

        logDiv = document.createElement('div');
        logDiv.style.cssText = 'position:fixed;top:8px;left:8px;z-index:9998;' +
            'background:rgba(0,0,0,0.75);color:#e0e0e0;border-radius:6px;' +
            'font-family:monospace;font-size:11px;padding:0;' +
            'box-shadow:0 2px 8px rgba(0,0,0,0.4);pointer-events:auto;' +
            'max-width:280px;overflow:hidden;';

        // Header row
        var header = document.createElement('div');
        header.style.cssText = 'padding:4px 8px;font-size:11px;cursor:pointer;' +
            'display:flex;align-items:center;gap:6px;' +
            'user-select:none;white-space:nowrap;';

        var titleSpan = document.createElement('span');
        titleSpan.textContent = '🤖 MCP';
        titleSpan.style.cssText = 'flex:1;';
        header.appendChild(titleSpan);

        // Active overlay count badge
        var badge = document.createElement('span');
        badge.id = 'mcp-overlay-count';
        badge.style.cssText = 'display:none;background:#FF9800;color:#fff;border-radius:8px;' +
            'padding:0 5px;font-size:9px;font-weight:bold;min-width:14px;text-align:center;';
        header.appendChild(badge);

        // Status dot
        var dot = document.createElement('span');
        dot.id = 'mcp-status-dot';
        dot.style.cssText = 'color:#4CAF50;';
        dot.textContent = '●';
        header.appendChild(dot);

        header.onclick = function(e) {
            if (e.target === clearBtn) return; // don't toggle on clear click
            logCollapsed = !logCollapsed;
            expandArea.style.display = logCollapsed ? 'none' : 'block';
        };

        // Expandable area (log + clear button)
        var expandArea = document.createElement('div');
        expandArea.style.cssText = 'display:none;';

        logContent = document.createElement('div');
        logContent.style.cssText = 'padding:4px 6px;max-height:180px;overflow-y:auto;';

        // Button bar
        var btnBar = document.createElement('div');
        btnBar.style.cssText = 'padding:4px 6px;border-top:1px solid rgba(255,255,255,0.1);' +
            'display:flex;gap:4px;';

        var clearBtn = document.createElement('button');
        clearBtn.textContent = '🧹 Clear All Overlays';
        clearBtn.style.cssText = 'flex:1;padding:4px 8px;border:none;border-radius:4px;cursor:pointer;' +
            'background:rgba(255,152,0,0.25);color:#FFB74D;font-size:10px;font-family:monospace;' +
            'transition:background 0.2s;';
        clearBtn.onmouseenter = function() { clearBtn.style.background = 'rgba(255,152,0,0.45)'; };
        clearBtn.onmouseleave = function() { clearBtn.style.background = 'rgba(255,152,0,0.25)'; };
        clearBtn.onclick = function(e) {
            e.stopPropagation();
            clearAllOverlays();
        };
        btnBar.appendChild(clearBtn);

        var clearLogBtn = document.createElement('button');
        clearLogBtn.textContent = '🗑 Log';
        clearLogBtn.style.cssText = 'padding:4px 8px;border:none;border-radius:4px;cursor:pointer;' +
            'background:rgba(255,255,255,0.08);color:#999;font-size:10px;font-family:monospace;' +
            'transition:background 0.2s;';
        clearLogBtn.onmouseenter = function() { clearLogBtn.style.background = 'rgba(255,255,255,0.15)'; };
        clearLogBtn.onmouseleave = function() { clearLogBtn.style.background = 'rgba(255,255,255,0.08)'; };
        clearLogBtn.onclick = function(e) {
            e.stopPropagation();
            logContent.innerHTML = '';
            logEntries = [];
            addLog('Log cleared', '#888');
        };
        btnBar.appendChild(clearLogBtn);

        expandArea.appendChild(logContent);
        expandArea.appendChild(btnBar);

        logDiv.appendChild(header);
        logDiv.appendChild(expandArea);
        document.body.appendChild(logDiv);
    }

    function addLog(message, color) {
        ensureLogPanel();
        if (!logContent) return;

        var now = new Date();
        var time = now.getHours().toString().padStart(2,'0') + ':' +
                   now.getMinutes().toString().padStart(2,'0') + ':' +
                   now.getSeconds().toString().padStart(2,'0');

        var entry = document.createElement('div');
        entry.style.cssText = 'padding:1px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:10px;';
        entry.innerHTML = '<span style="color:#666;">' + time + '</span> ' +
            '<span style="color:' + (color || '#ccc') + ';">' + message + '</span>';

        logContent.appendChild(entry);
        logEntries.push(entry);

        while (logEntries.length > MAX_LOG) {
            var old = logEntries.shift();
            if (old && old.parentNode) old.parentNode.removeChild(old);
        }
        logContent.scrollTop = logContent.scrollHeight;
    }

    function updateLogHeader(connected) {
        var dot = document.getElementById('mcp-status-dot');
        if (dot) {
            dot.style.color = connected ? '#4CAF50' : '#F44336';
        }
    }

    // ── WebSocket ──
    function connect() {
        try {
            var wsUrl = 'ws://127.0.0.1:' + SIDECAR_PORT + '/drawio';
            if (FILE_PATH) {
                wsUrl += '?file=' + encodeURIComponent(FILE_PATH);
            }
            ws = new WebSocket(wsUrl);
            ws.onopen = function() {
                console.log('[drawio-mcp plugin] connected to sidecar on port ' + SIDECAR_PORT);
                ensureLogPanel();
                updateLogHeader(true);
                var fileLabel = FILE_PATH ? FILE_PATH.split('/').pop() : 'unknown file';
                addLog('\u2705 Connected \u2014 ' + fileLabel, '#4CAF50');
                // Register file path with sidecar (belt-and-suspenders: also in URL query)
                if (FILE_PATH) {
                    ws.send(JSON.stringify({ type: 'register', filePath: FILE_PATH }));
                }
                setupUserTracking();
            };
            ws.onmessage = function(evt) {
                try {
                    var msg = JSON.parse(evt.data);
                    addLog('⬇ ' + msg.type + ' ' + summarize(msg), '#64B5F6');
                    handleMessage(msg);
                } catch(e) {
                    console.error('[drawio-mcp plugin] failed to parse message:', e);
                }
            };
            ws.onclose = function() {
                console.log('[drawio-mcp plugin] disconnected from sidecar');
                addLog('\u26a0\ufe0f Disconnected \u2014 will retry in 5s', '#FF9800');
                updateLogHeader(false);
                scheduleReconnect();
            };
            ws.onerror = function() {
                scheduleReconnect();
            };
        } catch(e) {
            scheduleReconnect();
        }
    }

    function summarize(msg) {
        var data = msg.data || {};
        switch (msg.type) {
            case 'highlight':
                var ids = data.cellIds || [];
                return ids.length + ' cell' + (ids.length !== 1 ? 's' : '') + (data.color ? ' ' + data.color : '') + (data.duration ? ' ' + (data.duration/1000) + 's' : '');
            case 'unhighlight':
                var uids = data.cellIds || [];
                return uids.length > 0 ? uids.length + ' cell' + (uids.length !== 1 ? 's' : '') : 'all';
            case 'cursor':
                return (data.label || '') + ' at (' + (data.position ? data.position.x + ',' + data.position.y : '?') + ')';
            case 'selection':
                var sids = data.cellIds || [];
                return sids.length + ' cell' + (sids.length !== 1 ? 's' : '') + (data.color ? ' ' + data.color : '');
            case 'status':
                return '"' + (data.message || '').substring(0, 40) + '"';
            case 'spinner':
                return data.show ? 'show: "' + (data.message || '') + '"' : 'hide';
            case 'layout':
                return (data.layout || 'unknown') + (data.direction ? ' ' + data.direction : '');
            default:
                return JSON.stringify(data).substring(0, 50);
        }
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
            case 'graph-edit':  doGraphEdit(msg); break;
            case 'graph-read':  doGraphRead(msg); break;
            case 'screenshot':  doScreenshot(msg); break;
        }
    }

    // ── HIGHLIGHT: flash cells with colored border ──
    function doHighlight(data) {
        var graph = getGraph();
        if (!graph) return;
        var color = data.color || AI_COLOR;
        var cellIds = data.cellIds || [];
        var duration = data.duration || 0; // 0 = persistent until unhighlight

        cellIds.forEach(function(id) {
            var cell = graph.model.getCell(id);
            if (!cell) return;

            // Remove existing highlight
            if (highlightOverlays[id]) {
                highlightOverlays[id].destroy();
                delete highlightOverlays[id];
            }
            if (highlightTimers[id]) {
                clearTimeout(highlightTimers[id]);
                delete highlightTimers[id];
            }

            var hl = new mxCellHighlight(graph, color, 3, false);
            hl.highlight(graph.view.getState(cell));
            highlightOverlays[id] = hl;

            // Auto-clear after duration
            if (duration > 0) {
                highlightTimers[id] = setTimeout(function() {
                    if (highlightOverlays[id]) {
                        highlightOverlays[id].destroy();
                        delete highlightOverlays[id];
                    }
                    delete highlightTimers[id];
                    updateOverlayCount();
                }, duration);
            }
        });
    }

    function doUnhighlight(data) {
        var cellIds = data.cellIds || [];
        if (cellIds.length === 0) {
            for (var id in highlightOverlays) {
                highlightOverlays[id].destroy();
            }
            highlightOverlays = {};
            for (var tid in highlightTimers) {
                clearTimeout(highlightTimers[tid]);
            }
            highlightTimers = {};
        } else {
            cellIds.forEach(function(id) {
                if (highlightOverlays[id]) {
                    highlightOverlays[id].destroy();
                    delete highlightOverlays[id];
                }
                if (highlightTimers[id]) {
                    clearTimeout(highlightTimers[id]);
                    delete highlightTimers[id];
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
                'white-space:nowrap;transition:left 0.3s ease,top 0.3s ease,opacity 0.4s ease;' +
                'box-shadow:0 2px 8px rgba(0,0,0,0.3);';
            container.appendChild(cursorDiv);
        }

        var color = data.color || AI_COLOR;
        var label = data.label || AI_LABEL;
        cursorDiv.style.background = color;
        cursorDiv.style.color = '#fff';
        cursorDiv.textContent = label;
        cursorDiv.style.opacity = '1';

        var state = graph.view;
        var sx = state.translate.x + data.position.x * state.scale;
        var sy = state.translate.y + data.position.y * state.scale;
        cursorDiv.style.left = sx + 'px';
        cursorDiv.style.top = sy + 'px';
        cursorDiv.style.display = 'block';

        // Auto-hide cursor after 20 seconds
        if (cursorHideTimer) clearTimeout(cursorHideTimer);
        cursorHideTimer = setTimeout(function() {
            if (cursorDiv) {
                cursorDiv.style.opacity = '0';
                setTimeout(function() {
                    if (cursorDiv) cursorDiv.style.display = 'none';
                    updateOverlayCount();
                }, 500);
            }
        }, 20000);
    }

    // ── SELECTION: highlight multiple cells as AI-selected ──
    function doSelection(data) {
        var graph = getGraph();
        if (!graph) return;
        var color = data.color || AI_COLOR;
        var cellIds = data.cellIds || [];

        // Clear previous
        clearSelection();

        cellIds.forEach(function(id) {
            var cell = graph.model.getCell(id);
            if (!cell) return;
            var hl = new mxCellHighlight(graph, color, 4, true);
            hl.highlight(graph.view.getState(cell));
            selectionOverlays[id] = hl;
        });

        // Auto-clear after 20 seconds
        if (selectionHideTimer) clearTimeout(selectionHideTimer);
        selectionHideTimer = setTimeout(function() {
            clearSelection();
            updateOverlayCount();
        }, 20000);
    }

    function clearSelection() {
        for (var id in selectionOverlays) {
            selectionOverlays[id].destroy();
        }
        selectionOverlays = {};
    }

    // ── STATUS: toast message at the bottom of the editor ──
    // Uses position:fixed on document.body to avoid graph.container clipping
    function doStatus(data) {
        var graph = getGraph();
        if (!graph) return;

        if (!statusDiv) {
            statusDiv = document.createElement('div');
            statusDiv.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);' +
                'z-index:10000;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:500;' +
                'background:rgba(0,0,0,0.9);color:#fff;pointer-events:none;' +
                'box-shadow:0 4px 16px rgba(0,0,0,0.5);white-space:nowrap;' +
                'transition:opacity 0.4s ease;opacity:0;display:none;';
            document.body.appendChild(statusDiv);
        }

        statusDiv.textContent = data.message || '';
        statusDiv.style.display = 'block';
        // Force reflow so the transition triggers
        statusDiv.offsetHeight;
        statusDiv.style.opacity = '1';

        // Auto-hide after 20 seconds
        if (statusDiv._timer) clearTimeout(statusDiv._timer);
        statusDiv._timer = setTimeout(function() {
            if (statusDiv) {
                statusDiv.style.opacity = '0';
                setTimeout(function() {
                    if (statusDiv) statusDiv.style.display = 'none';
                    updateOverlayCount();
                }, 500);
            }
        }, 20000);
    }

    // ── SPINNER: loading indicator (JS-driven rotation) ──
    // Uses position:fixed on document.body to avoid graph.container clipping
    function doSpinner(data) {
        var graph = getGraph();
        if (!graph) return;

        if (!spinnerDiv) {
            spinnerDiv = document.createElement('div');
            spinnerDiv.style.cssText = 'position:fixed;top:16px;right:16px;z-index:10000;' +
                'padding:8px 16px;border-radius:8px;font-size:13px;font-weight:500;' +
                'background:rgba(0,0,0,0.9);color:#fff;pointer-events:none;' +
                'display:none;align-items:center;gap:8px;box-shadow:0 4px 16px rgba(0,0,0,0.5);';
            document.body.appendChild(spinnerDiv);
        }

        if (data.show) {
            // Build spinner with a dot element we rotate via JS
            spinnerDiv.innerHTML = '';

            spinnerDot = document.createElement('span');
            spinnerDot.style.cssText = 'display:inline-block;width:14px;height:14px;' +
                'border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;' +
                'flex-shrink:0;';
            spinnerDiv.appendChild(spinnerDot);

            var label = document.createElement('span');
            label.textContent = data.message || 'Working...';
            spinnerDiv.appendChild(label);

            spinnerDiv.style.display = 'flex';
            spinnerRotation = 0;

            // JS-driven rotation (works in all webview contexts)
            if (spinnerInterval) clearInterval(spinnerInterval);
            spinnerInterval = setInterval(function() {
                spinnerRotation = (spinnerRotation + 15) % 360;
                if (spinnerDot) spinnerDot.style.transform = 'rotate(' + spinnerRotation + 'deg)';
            }, 30);
        } else {
            spinnerDiv.style.display = 'none';
            if (spinnerInterval) {
                clearInterval(spinnerInterval);
                spinnerInterval = null;
            }
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

    // ── GRAPH-EDIT: live mxGraph mutations from MCP tools ──
    function doGraphEdit(msg) {
        var graph = getGraph();
        if (!graph || !ws || ws.readyState !== 1) {
            sendResult(msg.requestId, false, null, 'No graph available');
            return;
        }

        var op = msg.data.operation;
        var params = msg.data.params;
        var result = {};

        try {
            graph.getModel().beginUpdate();
            try {
                switch (op) {
                    case 'addNode': {
                        var parent = graph.getDefaultParent();
                        var v = graph.insertVertex(parent, params.id || null,
                            params.label || '',
                            params.x || 0, params.y || 0,
                            params.width || 120, params.height || 60,
                            params.style || '');
                        result.id = v.id;
                        addLog('\\u270F\\uFE0F addNode "' + (params.label || '').substring(0, 20) + '" \\u2192 ' + v.id, '#81C784');
                        break;
                    }
                    case 'addEdge': {
                        var parent = graph.getDefaultParent();
                        var source = graph.model.getCell(params.sourceId);
                        var target = graph.model.getCell(params.targetId);
                        if (!source) throw new Error('Source not found: ' + params.sourceId);
                        if (!target) throw new Error('Target not found: ' + params.targetId);
                        var e = graph.insertEdge(parent, params.id || null,
                            params.label || '', source, target,
                            params.style || '');
                        result.id = e.id;
                        addLog('\\u270F\\uFE0F addEdge ' + params.sourceId + ' \\u2192 ' + params.targetId + ' = ' + e.id, '#81C784');
                        break;
                    }
                    case 'updateElement': {
                        var cell = graph.model.getCell(params.elementId);
                        if (!cell) throw new Error('Element not found: ' + params.elementId);
                        if (params.label !== undefined) {
                            graph.model.setValue(cell, params.label);
                        }
                        if (params.style !== undefined) {
                            graph.model.setStyle(cell, params.style);
                        }
                        if (params.x !== undefined || params.y !== undefined ||
                            params.width !== undefined || params.height !== undefined) {
                            var geo = cell.geometry ? cell.geometry.clone() : new mxGeometry();
                            if (params.x !== undefined) geo.x = params.x;
                            if (params.y !== undefined) geo.y = params.y;
                            if (params.width !== undefined) geo.width = params.width;
                            if (params.height !== undefined) geo.height = params.height;
                            graph.model.setGeometry(cell, geo);
                        }
                        result.id = params.elementId;
                        addLog('\\u270F\\uFE0F update ' + params.elementId, '#81C784');
                        break;
                    }
                    case 'removeElement': {
                        var cell = graph.model.getCell(params.elementId);
                        if (!cell) throw new Error('Element not found: ' + params.elementId);
                        graph.removeCells([cell]);
                        result.id = params.elementId;
                        addLog('\\u270F\\uFE0F remove ' + params.elementId, '#EF5350');
                        break;
                    }
                    case 'batchAdd': {
                        var parent = graph.getDefaultParent();
                        var nodeResults = [];
                        var edgeResults = [];

                        // Insert nodes first (so edges can reference them)
                        var nodes = params.nodes || [];
                        for (var i = 0; i < nodes.length; i++) {
                            var n = nodes[i];
                            var v = graph.insertVertex(parent, n.id || null,
                                n.label || '',
                                n.x || 0, n.y || 0,
                                n.width || 120, n.height || 60,
                                n.style || '');
                            nodeResults.push({ id: v.id, label: n.label || '' });
                        }

                        // Then edges
                        var edges = params.edges || [];
                        for (var j = 0; j < edges.length; j++) {
                            var ed = edges[j];
                            var src = graph.model.getCell(ed.sourceId);
                            var tgt = graph.model.getCell(ed.targetId);
                            if (!src || !tgt) {
                                addLog('\\u26A0 batchAdd edge skipped: missing ' + (!src ? ed.sourceId : ed.targetId), '#FF9800');
                                continue;
                            }
                            var edge = graph.insertEdge(parent, ed.id || null,
                                ed.label || '', src, tgt, ed.style || '');
                            edgeResults.push({ id: edge.id, sourceId: ed.sourceId, targetId: ed.targetId });
                        }

                        result.nodeIds = nodeResults;
                        result.edgeIds = edgeResults;
                        addLog('\\u270F\\uFE0F batch +' + nodeResults.length + ' nodes +' + edgeResults.length + ' edges', '#81C784');
                        break;
                    }
                    default:
                        throw new Error('Unknown graph-edit operation: ' + op);
                }
            } finally {
                graph.getModel().endUpdate();
            }

            sendResult(msg.requestId, true, result, null);
        } catch (err) {
            addLog('\\u274C graph-edit error: ' + (err.message || err), '#EF5350');
            sendResult(msg.requestId, false, null, err.message || String(err));
        }

        updateOverlayCount();
    }

    // ── GRAPH-READ: return current graph XML to MCP ──
    function doGraphRead(msg) {
        if (!_ui || !ws || ws.readyState !== 1) {
            sendResult(msg.requestId, false, null, 'No editor available');
            return;
        }

        try {
            // Get the full file XML (all pages) if available, otherwise just graph XML
            var xml;
            if (_ui.getFileData) {
                xml = _ui.getFileData();
            } else {
                xml = mxUtils.getXml(_ui.editor.getGraphXml());
            }
            ws.send(JSON.stringify({
                type: 'graph-read-result',
                requestId: msg.requestId,
                success: true,
                xml: xml
            }));
            addLog('\\u2B06 sent graph XML (' + xml.length + ' chars)', '#64B5F6');
        } catch (err) {
            sendResult(msg.requestId, false, null, err.message || String(err));
        }
    }

    // ── SCREENSHOT: capture diagram as PNG image ──
    function doScreenshot(msg) {
        var graph = getGraph();
        if (!graph || !ws || ws.readyState !== 1) {
            sendResult(msg.requestId, false, null, 'No graph available');
            return;
        }

        try {
            var scale = (msg.data && msg.data.scale) ? msg.data.scale : 1;
            var border = (msg.data && msg.data.border) ? msg.data.border : 10;

            // Get SVG from mxGraph
            var bgColor = graph.background || '#ffffff';
            var svgRoot = graph.getSvg(bgColor, scale, border);
            var svgXml = new XMLSerializer().serializeToString(svgRoot);

            // Read dimensions from SVG attributes
            var svgWidth = Math.ceil(parseFloat(svgRoot.getAttribute('width')) || 800);
            var svgHeight = Math.ceil(parseFloat(svgRoot.getAttribute('height')) || 600);

            // Convert SVG to PNG via canvas
            var canvas = document.createElement('canvas');
            canvas.width = svgWidth;
            canvas.height = svgHeight;
            var ctx = canvas.getContext('2d');

            var img = new Image();
            // Use base64 data URI to avoid tainted canvas issues
            var svgBase64 = btoa(unescape(encodeURIComponent(svgXml)));
            var svgDataUrl = 'data:image/svg+xml;base64,' + svgBase64;

            img.onload = function() {
                // Fill white background
                ctx.fillStyle = bgColor;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0);

                try {
                    var pngDataUrl = canvas.toDataURL('image/png');
                    var pngBase64 = pngDataUrl.replace(/^data:image\\/png;base64,/, '');

                    ws.send(JSON.stringify({
                        type: 'screenshot-result',
                        requestId: msg.requestId,
                        success: true,
                        data: {
                            imageData: pngBase64,
                            mimeType: 'image/png',
                            width: canvas.width,
                            height: canvas.height
                        }
                    }));
                    addLog('\\uD83D\\uDCF8 screenshot PNG ' + canvas.width + '\\u00d7' + canvas.height, '#64B5F6');
                } catch (canvasErr) {
                    // Canvas tainted — fall back to SVG
                    ws.send(JSON.stringify({
                        type: 'screenshot-result',
                        requestId: msg.requestId,
                        success: true,
                        data: {
                            imageData: svgBase64,
                            mimeType: 'image/svg+xml',
                            width: svgWidth,
                            height: svgHeight
                        }
                    }));
                    addLog('\\uD83D\\uDCF8 screenshot SVG fallback ' + svgWidth + '\\u00d7' + svgHeight, '#FF9800');
                }
                updateOverlayCount();
            };

            img.onerror = function() {
                // Image load failed — return SVG directly
                ws.send(JSON.stringify({
                    type: 'screenshot-result',
                    requestId: msg.requestId,
                    success: true,
                    data: {
                        imageData: svgBase64,
                        mimeType: 'image/svg+xml',
                        width: svgWidth,
                        height: svgHeight
                    }
                }));
                addLog('\\uD83D\\uDCF8 screenshot SVG fallback ' + svgWidth + '\\u00d7' + svgHeight, '#FF9800');
                updateOverlayCount();
            };

            img.src = svgDataUrl;
        } catch (err) {
            addLog('\\u274C screenshot error: ' + (err.message || err), '#EF5350');
            sendResult(msg.requestId, false, null, err.message || String(err));
        }
    }

    function sendResult(requestId, success, data, error) {
        if (!ws || ws.readyState !== 1) return;
        var msg = {
            type: 'graph-edit-result',
            requestId: requestId,
            success: success
        };
        if (data) msg.data = data;
        if (error) msg.error = error;
        ws.send(JSON.stringify(msg));
    }


    // ── User tracking → sidecar ──
    function setupUserTracking() {
        var graph = getGraph();
        if (!graph) return;

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
            console.log('[drawio-mcp plugin] loaded, connecting to sidecar on port ' + SIDECAR_PORT + (FILE_PATH ? ' for ' + FILE_PATH.split('/').pop() : '') + '...');
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
