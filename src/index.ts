#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as path from 'node:path';
import {
  createDiagramFile,
  readDiagram,
  addNode,
  addEdge,
  updateElement,
  removeElement,
  addPage,
  listDiagramFiles,
  getHistory,
  undoLastOperation,
  redoLastOperation,
  batchAddElements,
  checkLayout,
  generateId,
  validateShape,
  validateEdgeStyle,
  validateConnectionPoint,
  buildConnectionStyle,
} from './drawio.js';
import { SHAPE_STYLES, EDGE_STYLES, CONNECTION_POINTS, DEFAULT_GEOMETRY } from './styles.js';
import { startSidecar, stopSidecar, sendToDrawio, hasConnectedClients, getClientCount, hasConnectedDrawioClient, sendToDrawioAndWait } from './sidecar.js';

const server = new McpServer({
  name: 'drawio-mcp',
  version: '1.0.0',
});

// ── Tools ──────────────────────────────────────────────────────────────────

server.tool(
  'create_diagram',
  'Create a new empty draw.io diagram file. The file will be immediately visible in the VS Code draw.io extension.',
  {
    filePath: z.string().describe('Path for the new .drawio file (relative or absolute)'),
    pageName: z.string().optional().describe('Name of the first page (default: "Page-1")'),
  },
  async ({ filePath, pageName }) => {
    try {
      const resolved = await createDiagramFile(filePath, pageName);
      return {
        content: [{ type: 'text', text: `Created diagram: ${resolved}\n\nTip: Install the VS Code draw.io extension to view and edit this file live:\n  code --install-extension hediet.vscode-drawio` }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'read_diagram',
  'Read and parse a draw.io diagram file, returning a structured overview of all pages, nodes (shapes), and edges (connections).',
  {
    filePath: z.string().describe('Path to the .drawio file'),
  },
  async ({ filePath }) => {
    try {
      const info = await readDiagram(filePath);
      const summary = formatDiagramSummary(info);
      return { content: [{ type: 'text', text: summary }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'add_node',
  'Add a new node (shape/vertex) to a draw.io diagram. Use the "shape" parameter for predefined styles, or provide a custom "style" string.',
  {
    filePath: z.string().describe('Path to the .drawio file'),
    label: z.string().describe('Text label displayed inside the node'),
    shape: z.string().optional().describe(
      `Predefined shape name. Available: ${Object.keys(SHAPE_STYLES).join(', ')}`
    ),
    style: z.string().optional().describe('Custom draw.io style string (overrides shape if both provided)'),
    x: z.number().optional().describe('X position (default: 0)'),
    y: z.number().optional().describe('Y position (default: 0)'),
    width: z.number().optional().describe('Width in pixels (default: 120)'),
    height: z.number().optional().describe('Height in pixels (default: 60)'),
    pageIndex: z.number().optional().describe('Page index to add to (0-based, default: 0)'),
    id: z.string().optional().describe('Custom ID for the node (auto-generated if not provided)'),
  },
  async ({ filePath, label, shape, style, x, y, width, height, pageIndex, id }) => {
    try {
      const resolvedPath = path.resolve(filePath);

      // Live editing: if the diagram is open in an editor, edit via mxGraph API
      if (hasConnectedDrawioClient(resolvedPath)) {
        validateShape(shape);
        let computedStyle = style || '';
        if (shape && SHAPE_STYLES[shape]) {
          computedStyle = SHAPE_STYLES[shape] + computedStyle;
        } else if (!computedStyle) {
          computedStyle = SHAPE_STYLES.roundedRectangle;
        }
        const nodeId = id || generateId();
        const requestId = generateId();

        const response = await sendToDrawioAndWait({
          type: 'graph-edit',
          requestId,
          filePath: resolvedPath,
          data: {
            operation: 'addNode',
            params: {
              id: nodeId, label, style: computedStyle,
              x: x ?? DEFAULT_GEOMETRY.x, y: y ?? DEFAULT_GEOMETRY.y,
              width: width ?? DEFAULT_GEOMETRY.width, height: height ?? DEFAULT_GEOMETRY.height,
            },
          },
        });

        if (!response.success) {
          return { content: [{ type: 'text', text: `Error (live): ${response.error}` }], isError: true };
        }
        const resultId = response.data?.id || nodeId;
        return { content: [{ type: 'text', text: `Added node "${label}" with ID: ${resultId} (live edit)` }] };
      }

      // File I/O fallback
      const result = await addNode(filePath, { label, shape, style, x, y, width, height, pageIndex, id });
      return {
        content: [{ type: 'text', text: `Added node "${label}" with ID: ${result.id}` }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'add_edge',
  `Add a connection (edge/arrow) between two nodes in a draw.io diagram.

LAYOUT TIPS for readable diagrams:
- Use "curved" edgeStyle when multiple edges connect the same pair of nodes, combined with different exitPoint/entryPoint to separate them visually.
- Use "orthogonal" for clean right-angle routing in architecture diagrams.
- Use exitPoint/entryPoint to control WHERE on a node the edge connects (e.g. "left", "right", "topLeft25", "bottomRight75") — this prevents edges from stacking on top of each other.
- For bidirectional flows, use two separate edges with offset connection points (e.g. edge A: exitPoint="rightTop25" → entryPoint="leftTop25", edge B: exitPoint="leftBottom75" → entryPoint="rightBottom75").`,
  {
    filePath: z.string().describe('Path to the .drawio file'),
    sourceId: z.string().describe('ID of the source node'),
    targetId: z.string().describe('ID of the target node'),
    label: z.string().optional().describe('Label for the edge'),
    edgeStyle: z.string().optional().describe(
      `Predefined edge style. Available: ${Object.keys(EDGE_STYLES).join(', ')}`
    ),
    style: z.string().optional().describe('Custom draw.io style string'),
    exitPoint: z.string().optional().describe(
      `Where the edge exits the source node. Available: ${Object.keys(CONNECTION_POINTS).join(', ')}. Use offset variants (e.g. topLeft25, rightBottom75) when multiple edges share a node to avoid overlap.`
    ),
    entryPoint: z.string().optional().describe(
      `Where the edge enters the target node. Available: ${Object.keys(CONNECTION_POINTS).join(', ')}. Use offset variants to separate parallel edges.`
    ),
    pageIndex: z.number().optional().describe('Page index (0-based, default: 0)'),
    id: z.string().optional().describe('Custom ID for the edge'),
  },
  async ({ filePath, sourceId, targetId, label, edgeStyle, style, exitPoint, entryPoint, pageIndex, id }) => {
    try {
      const resolvedPath = path.resolve(filePath);

      // Live editing path
      if (hasConnectedDrawioClient(resolvedPath)) {
        validateEdgeStyle(edgeStyle);
        validateConnectionPoint(exitPoint, 'exitPoint');
        validateConnectionPoint(entryPoint, 'entryPoint');

        let computedStyle = style || '';
        if (edgeStyle && EDGE_STYLES[edgeStyle]) {
          computedStyle = EDGE_STYLES[edgeStyle] + computedStyle;
        }
        computedStyle += buildConnectionStyle(exitPoint, entryPoint);

        const edgeId = id || generateId();
        const requestId = generateId();

        const response = await sendToDrawioAndWait({
          type: 'graph-edit',
          requestId,
          filePath: resolvedPath,
          data: {
            operation: 'addEdge',
            params: {
              id: edgeId, sourceId, targetId,
              label: label || '', style: computedStyle,
            },
          },
        });

        if (!response.success) {
          return { content: [{ type: 'text', text: `Error (live): ${response.error}` }], isError: true };
        }
        const resultId = response.data?.id || edgeId;
        return { content: [{ type: 'text', text: `Added edge from ${sourceId} → ${targetId} with ID: ${resultId} (live edit)` }] };
      }

      // File I/O fallback
      const result = await addEdge(filePath, { sourceId, targetId, label, edgeStyle, style, exitPoint, entryPoint, pageIndex, id });
      let text = `Added edge from ${sourceId} → ${targetId} with ID: ${result.id}`;
      if (result.layoutWarnings.length > 0) {
        text += '\n\n⚠️ Layout warnings:';
        for (const w of result.layoutWarnings) {
          text += `\n  [${w.severity}] ${w.message}`;
          if (w.suggestion) text += `\n    → ${w.suggestion}`;
        }
      }
      return {
        content: [{ type: 'text', text }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'batch_add_elements',
  `Add multiple nodes and edges to a draw.io diagram in a single operation. Much more efficient than calling add_node/add_edge individually — performs only one file read and one file write regardless of how many elements are added. Use this for building entire diagrams or adding multiple components at once.

LAYOUT BEST PRACTICES:
- Space nodes at least 200px apart horizontally and 150px vertically to leave room for edge labels.
- Use "curved" edgeStyle when multiple edges connect the same nodes or cross over each other.
- Use exitPoint/entryPoint (e.g. "left", "right", "topLeft25", "bottomRight75") to separate parallel edges.
- For bidirectional pairs, use offset connection points so the two arrows don't overlap.
- All edge labels automatically get a white background for readability.
- Prefer "orthogonal" for structured layouts and "curved" for organic/many-connection layouts.`,
  {
    filePath: z.string().describe('Path to the .drawio file'),
    nodes: z.array(z.object({
      label: z.string().describe('Text label displayed inside the node'),
      id: z.string().optional().describe('Custom ID for the node (auto-generated if not provided)'),
      shape: z.string().optional().describe(
        `Predefined shape name. Available: ${Object.keys(SHAPE_STYLES).join(', ')}`
      ),
      style: z.string().optional().describe('Custom draw.io style string (overrides shape if both provided)'),
      x: z.number().optional().describe('X position (default: 0)'),
      y: z.number().optional().describe('Y position (default: 0)'),
      width: z.number().optional().describe('Width in pixels (default: 120)'),
      height: z.number().optional().describe('Height in pixels (default: 60)'),
      pageIndex: z.number().optional().describe('Page index (0-based, default: 0)'),
    })).optional().describe('Array of nodes to add'),
    edges: z.array(z.object({
      sourceId: z.string().describe('ID of the source node'),
      targetId: z.string().describe('ID of the target node'),
      label: z.string().optional().describe('Label for the edge'),
      id: z.string().optional().describe('Custom ID for the edge'),
      edgeStyle: z.string().optional().describe(
        `Predefined edge style. Available: ${Object.keys(EDGE_STYLES).join(', ')}`
      ),
      style: z.string().optional().describe('Custom draw.io style string'),
      exitPoint: z.string().optional().describe(
        `Where edge exits source. Available: ${Object.keys(CONNECTION_POINTS).join(', ')}`
      ),
      entryPoint: z.string().optional().describe(
        `Where edge enters target. Available: ${Object.keys(CONNECTION_POINTS).join(', ')}`
      ),
      pageIndex: z.number().optional().describe('Page index (0-based, default: 0)'),
    })).optional().describe('Array of edges to add'),
  },
  async ({ filePath, nodes, edges }) => {
    try {
      const resolvedPath = path.resolve(filePath);

      // Live editing path
      if (hasConnectedDrawioClient(resolvedPath)) {
        // Pre-validate and compute styles on MCP side
        const preparedNodes = (nodes || []).map(n => {
          validateShape(n.shape);
          let s = n.style || '';
          if (n.shape && SHAPE_STYLES[n.shape]) {
            s = SHAPE_STYLES[n.shape] + s;
          } else if (!s) {
            s = SHAPE_STYLES.roundedRectangle;
          }
          return {
            id: n.id || generateId(),
            label: n.label,
            style: s,
            x: n.x ?? DEFAULT_GEOMETRY.x,
            y: n.y ?? DEFAULT_GEOMETRY.y,
            width: n.width ?? DEFAULT_GEOMETRY.width,
            height: n.height ?? DEFAULT_GEOMETRY.height,
          };
        });
        const preparedEdges = (edges || []).map(e => {
          validateEdgeStyle(e.edgeStyle);
          validateConnectionPoint(e.exitPoint, 'exitPoint');
          validateConnectionPoint(e.entryPoint, 'entryPoint');
          let s = e.style || '';
          if (e.edgeStyle && EDGE_STYLES[e.edgeStyle]) {
            s = EDGE_STYLES[e.edgeStyle] + s;
          }
          s += buildConnectionStyle(e.exitPoint, e.entryPoint);
          return {
            id: e.id || generateId(),
            sourceId: e.sourceId,
            targetId: e.targetId,
            label: e.label || '',
            style: s,
          };
        });

        const requestId = generateId();
        const response = await sendToDrawioAndWait({
          type: 'graph-edit',
          requestId,
          filePath: resolvedPath,
          data: {
            operation: 'batchAdd',
            params: { nodes: preparedNodes, edges: preparedEdges },
          },
        });

        if (!response.success) {
          return { content: [{ type: 'text', text: `Error (live): ${response.error}` }], isError: true };
        }

        const rNodes = response.data?.nodeIds || [];
        const rEdges = response.data?.edgeIds || [];
        const lines: string[] = [
          `Batch added ${rNodes.length} node(s) and ${rEdges.length} edge(s) (live edit).`,
        ];
        if (rNodes.length > 0) {
          lines.push('Nodes:');
          for (const n of rNodes) lines.push(`  • "${n.label}" → ID: ${n.id}`);
        }
        if (rEdges.length > 0) {
          lines.push('Edges:');
          for (const e of rEdges) lines.push(`  → ${e.sourceId} → ${e.targetId} (ID: ${e.id})`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // File I/O fallback
      const result = await batchAddElements(filePath, { nodes, edges });
      const lines: string[] = [
        `Batch added ${result.nodeIds.length} node(s) and ${result.edgeIds.length} edge(s).`,
      ];
      if (result.nodeIds.length > 0) {
        lines.push('Nodes:');
        for (const n of result.nodeIds) {
          lines.push(`  • "${n.label}" → ID: ${n.id}`);
        }
      }
      if (result.edgeIds.length > 0) {
        lines.push('Edges:');
        for (const e of result.edgeIds) {
          lines.push(`  → ${e.sourceId} → ${e.targetId} (ID: ${e.id})`);
        }
      }
      if (result.layoutWarnings.length > 0) {
        lines.push('');
        lines.push(`⚠️ Layout warnings (${result.layoutWarnings.length}):`);
        for (const w of result.layoutWarnings) {
          lines.push(`  [${w.severity}] ${w.message}`);
          if (w.suggestion) lines.push(`    → ${w.suggestion}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'update_element',
  'Update properties of an existing node or edge in a draw.io diagram. Only specified properties are changed.',
  {
    filePath: z.string().describe('Path to the .drawio file'),
    elementId: z.string().describe('ID of the element to update'),
    label: z.string().optional().describe('New label text'),
    style: z.string().optional().describe('New style string'),
    x: z.number().optional().describe('New X position'),
    y: z.number().optional().describe('New Y position'),
    width: z.number().optional().describe('New width'),
    height: z.number().optional().describe('New height'),
  },
  async ({ filePath, elementId, label, style, x, y, width, height }) => {
    try {
      const resolvedPath = path.resolve(filePath);

      // Live editing path
      if (hasConnectedDrawioClient(resolvedPath)) {
        const requestId = generateId();
        const response = await sendToDrawioAndWait({
          type: 'graph-edit',
          requestId,
          filePath: resolvedPath,
          data: {
            operation: 'updateElement',
            params: { elementId, label, style, x, y, width, height },
          },
        });
        if (!response.success) {
          return { content: [{ type: 'text', text: `Error (live): ${response.error}` }], isError: true };
        }
        return { content: [{ type: 'text', text: `Updated element ${elementId} (live edit)` }] };
      }

      // File I/O fallback
      const result = await updateElement(filePath, elementId, { label, style, x, y, width, height });
      if (result.success) {
        return { content: [{ type: 'text', text: `Updated element ${elementId} (changeId: ${result.changeId})` }] };
      }
      return { content: [{ type: 'text', text: `Element ${elementId} not found` }], isError: true };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'remove_element',
  'Remove a node or edge from a draw.io diagram by its ID. Also removes any edges connected to a removed node.',
  {
    filePath: z.string().describe('Path to the .drawio file'),
    elementId: z.string().describe('ID of the element to remove'),
  },
  async ({ filePath, elementId }) => {
    try {
      const resolvedPath = path.resolve(filePath);

      // Live editing path
      if (hasConnectedDrawioClient(resolvedPath)) {
        const requestId = generateId();
        const response = await sendToDrawioAndWait({
          type: 'graph-edit',
          requestId,
          filePath: resolvedPath,
          data: {
            operation: 'removeElement',
            params: { elementId },
          },
        });
        if (!response.success) {
          return { content: [{ type: 'text', text: `Error (live): ${response.error}` }], isError: true };
        }
        return { content: [{ type: 'text', text: `Removed element ${elementId} (live edit)` }] };
      }

      // File I/O fallback
      const result = await removeElement(filePath, elementId);
      if (result.success) {
        return { content: [{ type: 'text', text: `Removed element ${elementId} (changeId: ${result.changeId})` }] };
      }
      return { content: [{ type: 'text', text: `Element ${elementId} not found` }], isError: true };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'add_page',
  'Add a new page (tab) to a draw.io diagram.',
  {
    filePath: z.string().describe('Path to the .drawio file'),
    pageName: z.string().describe('Name for the new page'),
  },
  async ({ filePath, pageName }) => {
    try {
      const result = await addPage(filePath, pageName);
      return {
        content: [{ type: 'text', text: `Added page "${pageName}" (ID: ${result.pageId})` }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'get_diagram_styles',
  'List all available predefined shape and edge styles for use with add_node and add_edge.',
  {},
  async () => {
    const shapes = Object.entries(SHAPE_STYLES)
      .map(([name, style]) => `  ${name}: ${style}`)
      .join('\n');
    const edges = Object.entries(EDGE_STYLES)
      .map(([name, style]) => `  ${name}: ${style || '(default)'}`)
      .join('\n');

    return {
      content: [{
        type: 'text',
        text: `Available Shape Styles:\n${shapes}\n\nAvailable Edge Styles:\n${edges}`,
      }],
    };
  }
);

server.tool(
  'undo_last_operation',
  'Undo the last MCP operation on a draw.io diagram, restoring the file to its previous state. Works independently of the draw.io editor undo.',
  {},
  async () => {
    try {
      const result = await undoLastOperation();
      if (result.success && result.record) {
        return {
          content: [{ type: 'text', text: `Undone: ${result.record.description} (${result.record.operation})` }],
        };
      }
      return { content: [{ type: 'text', text: 'Nothing to undo' }], isError: true };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'redo_last_operation',
  'Redo the last undone MCP operation, re-applying the changes to the diagram file.',
  {},
  async () => {
    try {
      const result = await redoLastOperation();
      if (result.success && result.record) {
        return {
          content: [{ type: 'text', text: `Redone: ${result.record.description} (${result.record.operation})` }],
        };
      }
      return { content: [{ type: 'text', text: 'Nothing to redo' }], isError: true };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'get_change_history',
  'Get the history of recent MCP operations on draw.io diagrams. Shows operation type, description, timestamp, and affected elements.',
  {
    limit: z.number().optional().describe('Maximum number of history entries to return (default: 10)'),
  },
  async ({ limit }) => {
    const history = getHistory(limit ?? 10);
    if (history.length === 0) {
      return { content: [{ type: 'text', text: 'No operations in history' }] };
    }
    const lines = history.map((r, i) => 
      `${i + 1}. [${r.timestamp}] ${r.operation}: ${r.description} (elements: ${r.elementIds.join(', ')})`
    );
    return {
      content: [{ type: 'text', text: `Change History (${history.length} entries):\n${lines.join('\n')}` }],
    };
  }
);

server.tool(
  'highlight_element',
  'Temporarily highlight one or more elements in the draw.io diagram with a flash effect. If the companion extension is connected, uses overlay highlighting. Otherwise, temporarily modifies the element style.',
  {
    filePath: z.string().describe('Path to the .drawio file'),
    elementIds: z.array(z.string()).describe('IDs of elements to highlight'),
    color: z.string().optional().describe('Highlight color (default: "#FFD700" gold)'),
    durationMs: z.number().optional().describe('Duration of highlight in ms (default: 20000)'),
  },
  async ({ filePath, elementIds, color, durationMs }) => {
    const highlightColor = color || '#FFD700';
    const duration = durationMs || 20000;

    try {
      // Prefer sidecar/companion extension path (non-destructive overlay)
      if (hasConnectedClients()) {
        sendToDrawio({
          type: 'highlight',
          data: { cellIds: elementIds, color: highlightColor, duration },
          filePath: path.resolve(filePath),
        });

        return {
          content: [{ type: 'text', text: `Highlighting ${elementIds.length} element(s) via companion extension for ${duration}ms` }],
        };
      }

      // Fallback: modify styles directly (destructive but works without companion)
      const info = await readDiagram(filePath);
      const page = info.pages[0];
      if (!page) return { content: [{ type: 'text', text: 'No pages in diagram' }], isError: true };

      // Store original styles
      const originals: { id: string; style: string }[] = [];
      for (const node of page.nodes) {
        if (elementIds.includes(node.id)) {
          originals.push({ id: node.id, style: node.style });
        }
      }

      // Apply highlight: add strokeColor and strokeWidth and fillColor overlay
      for (const orig of originals) {
        const highlightStyle = addHighlightToStyle(orig.style, highlightColor);
        await updateElement(filePath, orig.id, { style: highlightStyle });
      }

      // Schedule restore
      setTimeout(async () => {
        for (const orig of originals) {
          await updateElement(filePath, orig.id, { style: orig.style });
        }
      }, duration);

      return {
        content: [{ type: 'text', text: `Highlighting ${originals.length} element(s) for ${duration}ms (style-based fallback)` }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'show_status',
  'Display a status message in the draw.io editor status bar. Useful for showing what the AI is currently doing. Requires the companion extension.',
  {
    message: z.string().describe('Status message to display (e.g., "🤖 Adding database component...")'),
  },
  async ({ message }) => {
    if (!hasConnectedClients()) {
      return { content: [{ type: 'text', text: 'No companion extension connected (status not shown)' }] };
    }
    sendToDrawio({
      type: 'status',
      data: { message },
    });
    return { content: [{ type: 'text', text: `Status shown: "${message}"` }] };
  }
);

server.tool(
  'show_spinner',
  'Show or hide a loading spinner in the draw.io editor. Use show=true when starting a long operation and show=false when done.',
  {
    message: z.string().optional().describe('Message to show with spinner (e.g., "Generating diagram...")'),
    show: z.boolean().describe('true to show spinner, false to hide'),
  },
  async ({ message, show }) => {
    if (!hasConnectedClients()) {
      return { content: [{ type: 'text', text: 'No companion extension connected (spinner not shown)' }] };
    }
    sendToDrawio({
      type: 'spinner',
      data: { message: message || '', show },
    });
    return { content: [{ type: 'text', text: show ? `Spinner shown: "${message || ''}"` : 'Spinner hidden' }] };
  }
);

server.tool(
  'show_ai_cursor',
  'Show an AI cursor indicator at a specific position in the draw.io diagram. Requires the companion VS Code extension to be connected.',
  {
    filePath: z.string().optional().describe('Path to the .drawio file (scopes cursor to the correct editor)'),
    x: z.number().describe('X position in diagram coordinates'),
    y: z.number().describe('Y position in diagram coordinates'),
    label: z.string().optional().describe('Label next to cursor (default: "🤖 AI")'),
    color: z.string().optional().describe('Cursor color hex (default: "#D13913")'),
  },
  async ({ filePath, x, y, label, color }) => {
    if (!hasConnectedClients()) {
      return { content: [{ type: 'text', text: 'No companion extension connected. Install drawio-mcp-bridge in VS Code.' }], isError: true };
    }
    sendToDrawio({
      type: 'cursor',
      data: {
        position: { x, y },
        label: label || '🤖 AI',
        color: color || '#D13913',
      },
      filePath: filePath ? path.resolve(filePath) : undefined,
    });
    return { content: [{ type: 'text', text: `AI cursor shown at (${x}, ${y})` }] };
  }
);

server.tool(
  'show_ai_selection',
  'Highlight specific cells in the draw.io diagram as being selected/edited by AI. Shows a colored overlay around the cells. Requires the companion VS Code extension.',
  {
    filePath: z.string().optional().describe('Path to the .drawio file (scopes selection to the correct editor)'),
    cellIds: z.array(z.string()).describe('IDs of cells to show as AI-selected'),
    color: z.string().optional().describe('Selection overlay color (default: "#D13913")'),
  },
  async ({ filePath, cellIds, color }) => {
    if (!hasConnectedClients()) {
      return { content: [{ type: 'text', text: 'No companion extension connected. Install drawio-mcp-bridge in VS Code.' }], isError: true };
    }
    sendToDrawio({
      type: 'selection',
      data: {
        cellIds,
        color: color || '#D13913',
      },
      filePath: filePath ? path.resolve(filePath) : undefined,
    });
    return { content: [{ type: 'text', text: `AI selection shown on ${cellIds.length} cell(s): ${cellIds.join(', ')}` }] };
  }
);

server.tool(
  'check_connection',
  'Check the WebSocket sidecar connection status. Reports whether the sidecar server is running and how many companion extension / draw.io plugin clients are connected. Useful for diagnosing live-edit features.',
  {},
  async () => {
    const counts = getClientCount();
    const totalClients = counts.extensions + counts.drawioPlugins;

    const lines: string[] = [];

    if (counts.relayMode) {
      lines.push(`Sidecar mode: 🔄 RELAY — connected as client to existing sidecar on ws://127.0.0.1:${process.env.DRAWIO_MCP_SIDECAR_PORT || '9219'}`);
      lines.push('Another MCP server instance owns the sidecar port. This process relays messages through it.');
      lines.push('');
      lines.push('✅ Live editing features are available via relay!');
      lines.push('  → Messages (highlight, cursor, layout, etc.) are forwarded to the primary sidecar.');
    } else {
      lines.push(`Sidecar WebSocket server: ✅ running on ws://127.0.0.1:${process.env.DRAWIO_MCP_SIDECAR_PORT || '9219'}`);
      lines.push(`Connected clients: ${totalClients}`);
      lines.push(`  • Extension clients (bridge): ${counts.extensions}`);
      lines.push(`  • Draw.io plugin clients: ${counts.drawioPlugins}`);
      if (counts.registeredFiles.length > 0) {
        lines.push(`  • Registered files: ${counts.registeredFiles.join(', ')}`);
      }
      lines.push('');

      if (totalClients === 0) {
        lines.push('⚠️ No clients connected. Live features (highlight, cursor, status, layout) will not work.');
        lines.push('');
        lines.push('To enable live editing, install the companion extensions:');
        lines.push('');
        lines.push('Step 1 — Install the draw.io VS Code extension:');
        lines.push('  code --install-extension hediet.vscode-drawio');
        lines.push('');
        lines.push('Step 2 — Build & install the bridge extension (from the drawio-mcp repo root):');
        lines.push('  cd vscode-drawio-mcp-bridge');
        lines.push('  npm install && npm run build');
        lines.push('  npx @vscode/vsce package --allow-missing-repository');
        lines.push('  code --install-extension ./drawio-mcp-bridge-0.1.0.vsix');
        lines.push('');
        lines.push('Step 3 — Reload VS Code (Cmd/Ctrl+Shift+P → "Developer: Reload Window")');
        lines.push('Step 4 — Open any .drawio file — the bridge auto-connects to ws://127.0.0.1:9219');
        lines.push('');
        lines.push('A small activity log panel will appear in the top-left of the draw.io editor when connected.');
      } else {
        lines.push('✅ Live editing features are available!');
        if (counts.drawioPlugins > 0) {
          lines.push('  → draw.io plugin connected — highlight, cursor, selection, layout all work');
        }
        if (counts.extensions > 0) {
          lines.push('  → Bridge extension connected — status messages and spinner work');
        }
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── Resources ──────────────────────────────────────────────────────────────

server.tool(
  'check_layout',
  `Analyze a draw.io diagram for layout issues. Returns warnings about:
- Node overlaps (two nodes occupying the same space)
- Edge label overlaps with nodes (label text crossing through a node)
- Edge passes through node (an edge's path visually crosses an intermediate node)
- Insufficient spacing between connected nodes (label won't fit in the gap)

Each warning includes direction-aware suggestions that consider cascading conflicts — e.g. if moving node A right would collide with node B, the suggestion warns about it and recommends moving B first.

For edge-passes-through-node issues, suggestions include moving the blocking node, changing edge style to "curved" or "orthogonal", or using connection points to reroute.

Call this after building/modifying a diagram to detect readability problems. Use the suggestions to fix issues via update_element.`,
  {
    filePath: z.string().describe('Path to the .drawio file'),
    pageIndex: z.number().optional().describe('Page to analyze (0-based, default: 0)'),
  },
  async ({ filePath, pageIndex }) => {
    try {
      const warnings = await checkLayout(filePath, { pageIndex });
      if (warnings.length === 0) {
        return { content: [{ type: 'text', text: '✅ No layout issues detected.' }] };
      }
      const lines = [`⚠️ Found ${warnings.length} layout issue(s):`];
      for (const w of warnings) {
        lines.push(`\n[${w.severity.toUpperCase()}] ${w.message}`);
        if (w.suggestion) lines.push(`  → ${w.suggestion}`);
        lines.push(`  Elements: ${w.elementIds.join(', ')}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'apply_layout',
  `Trigger a draw.io built-in automatic layout algorithm on the diagram. Requires the diagram to be open in VS Code with the companion extension connected.

Available layouts:
- "hierarchical": Best for flowcharts, org charts, architecture diagrams. Arranges nodes in layers by rank.
- "organic": Force-directed layout. Good for graphs with many cross-connections. Nodes spread out naturally.
- "tree": Compact tree layout. Best for strict tree/hierarchy structures.
- "radialTree": Tree layout radiating outward from center.
- "circle": Arranges all nodes in a circle.

After layout, draw.io saves the updated positions back to the .drawio file automatically.`,
  {
    filePath: z.string().optional().describe('Path to the .drawio file (scopes layout to the correct editor)'),
    layout: z.enum(['hierarchical', 'organic', 'tree', 'radialTree', 'circle']).describe('Layout algorithm to apply'),
    direction: z.enum(['vertical', 'horizontal']).optional().describe('Layout direction (default: vertical). Only applies to hierarchical and tree layouts.'),
    spacing: z.number().optional().describe('Primary spacing between nodes in px (default: layout-dependent, typically 30-50)'),
    interRankSpacing: z.number().optional().describe('Spacing between ranks/layers in px (default: layout-dependent). Only for hierarchical and tree.'),
  },
  async ({ filePath, layout, direction, spacing, interRankSpacing }) => {
    if (!hasConnectedClients()) {
      return {
        content: [{
          type: 'text',
          text: 'No companion extension connected. The apply_layout tool requires:\n1. The draw.io VS Code extension: code --install-extension hediet.vscode-drawio\n2. The diagram open in VS Code\n3. The drawio-mcp-bridge companion extension (cd vscode-drawio-mcp-bridge && npm install && npm run compile)\n\nAlternative: Use check_layout to detect issues and update_element to fix positions manually.'
        }],
        isError: true,
      };
    }

    sendToDrawio({
      type: 'layout',
      data: {
        layout,
        direction: direction || 'vertical',
        spacing: spacing,
        interRankSpacing: interRankSpacing,
      },
      filePath: filePath ? path.resolve(filePath) : undefined,
    });

    return {
      content: [{
        type: 'text',
        text: `Applied "${layout}" layout${direction ? ` (${direction})` : ''}. The diagram positions will be updated automatically. Re-read the diagram or run check_layout to verify the result.`,
      }],
    };
  }
);

server.resource(
  'setup-instructions',
  'drawio://setup',
  {
    description: 'Setup instructions for the draw.io MCP server, including required VS Code extensions and companion bridge',
    mimeType: 'text/markdown',
  },
  async () => {
    return {
      contents: [{
        uri: 'drawio://setup',
        text: [
          '# draw.io MCP Server — Setup',
          '',
          '## Required: VS Code draw.io Extension',
          'Install the draw.io integration so `.drawio` files render live in VS Code:',
          '```',
          'code --install-extension hediet.vscode-drawio',
          '```',
          'Or search for **"Draw.io Integration"** (by hediet) in the VS Code Extensions panel.',
          '',
          '## Optional: Companion Bridge Extension',
          'For live features (AI cursor, highlighting, auto-layout via `apply_layout`), install the companion extension:',
          '```',
          'cd vscode-drawio-mcp-bridge && npm install && npm run compile',
          'code --install-extension ./vscode-drawio-mcp-bridge',
          '```',
          '',
          '## MCP Config',
          'Add to your MCP client config (e.g. `mcp.json`):',
          '```json',
          '{',
          '  "servers": {',
          '    "drawio": {',
          '      "command": "node",',
          '      "args": ["<path-to>/drawio-mcp/build/index.js"]',
          '    }',
          '  }',
          '}',
          '```',
        ].join('\n'),
        mimeType: 'text/markdown',
      }],
    };
  }
);

server.resource(
  'diagram-files',
  'drawio://files',
  {
    description: 'List all .drawio and .dio files in the current working directory',
    mimeType: 'application/json',
  },
  async () => {
    const files = await listDiagramFiles(process.cwd());
    const relativePaths = files.map(f => path.relative(process.cwd(), f));
    return {
      contents: [{
        uri: 'drawio://files',
        text: JSON.stringify(relativePaths, null, 2),
        mimeType: 'application/json',
      }],
    };
  }
);

// ── Prompts ────────────────────────────────────────────────────────────────

server.prompt(
  'flowchart',
  'Generate a flowchart from a process description. Provide a description of the process steps and this prompt will guide the AI to create a complete flowchart diagram.',
  {
    processDescription: z.string().describe('Description of the process to visualize as a flowchart'),
    filePath: z.string().describe('Path for the .drawio file to create'),
  },
  ({ processDescription, filePath }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Create a flowchart in draw.io for the following process. Use batch_add_elements to create all nodes and edges in ONE call:

1. First, call create_diagram with filePath="${filePath}"
2. Then call batch_add_elements with ALL nodes and edges at once:
   - Start/end nodes: shape "start" and "end"
   - Process steps: shape "processStep"
   - Decision points: shape "decision"
   - Input/output: shape "inputOutput"
   - Connect all with edges

LAYOUT RULES (CRITICAL for readability):
- Arrange top-to-bottom. Center column at x=300, start at y=40.
- Vertical spacing: 150px between steps (NOT 100px — labels need room).
- Decision branches: offset left branch x=50, right branch x=550.
- Edge style: "orthogonal" for main flow, "curved" for branches that skip levels.
- Edge labels: keep short (1-3 words). Use exitPoint/entryPoint to control where edges connect.
- When a decision has Yes/No branches going to different columns, use exitPoint="left" and exitPoint="right" on the decision node.
- When branches merge back, use entryPoint="top" on the merge target.
- Node width: 160px for process steps, 140x80 for decisions.

Process to visualize:
${processDescription}

IMPORTANT: Use meaningful IDs (e.g., "start", "check-input", "process-data"). Use batch_add_elements for efficiency.`,
      },
    }],
  })
);

server.prompt(
  'architecture',
  'Generate an architecture diagram from a system description. Describe the components and their interactions.',
  {
    systemDescription: z.string().describe('Description of the system architecture'),
    filePath: z.string().describe('Path for the .drawio file to create'),
  },
  ({ systemDescription, filePath }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Create an architecture diagram in draw.io for the following system. Use batch_add_elements for efficiency (ONE call for all nodes and edges):

1. First, call create_diagram with filePath="${filePath}"
2. Then call batch_add_elements with all nodes and edges:
   - "database" for databases/data stores
   - "server" for backend services
   - "cloud" for cloud/external services
   - "user" for user/actor nodes
   - "container" for grouping (300x200 or larger)
   - "blue" for web/frontend components
   - "green" for API/service components
   - "orange" for message queues/middleware

LAYOUT RULES (CRITICAL — prevents overlapping and unreadable diagrams):
- Arrange in layers: Users (y=40) → Frontend (y=240) → Backend (y=440) → Data (y=640).
- Horizontal spacing: at least 220px between nodes in the same layer.
- Node widths: 160px minimum. Use 200px for nodes with long names.
- Edge style: "orthogonal" for same-layer connections, "curved" when edges cross layers or cross other edges.
- When MULTIPLE edges connect to the SAME node, use DIFFERENT connection points:
  - Example: 3 edges entering a database → use entryPoint="topLeft25", entryPoint="top", entryPoint="topRight75"
  - Example: 2 edges leaving a service → use exitPoint="bottom" and exitPoint="right"
- For bidirectional flows (e.g. request/response), use TWO separate edges with offset connection points:
  - Request: exitPoint="rightTop25" → entryPoint="leftTop25"
  - Response: exitPoint="leftBottom75" → entryPoint="rightBottom75"
  - Use "curvedDashed" for response arrows, "curved" or "orthogonal" for request arrows.
- Edge labels: keep SHORT (2-4 words max). Labels automatically get white backgrounds.
- Avoid edges that cross through node boxes — reroute via connection points or use "curved" style.

System to visualize:
${systemDescription}

IMPORTANT: Use meaningful IDs, proper spacing, and connection points to keep the diagram readable.`,
      },
    }],
  })
);

server.prompt(
  'sequence-diagram',
  'Generate a sequence diagram showing interactions between actors/systems over time.',
  {
    interactionDescription: z.string().describe('Description of the interactions to visualize'),
    filePath: z.string().describe('Path for the .drawio file to create'),
  },
  ({ interactionDescription, filePath }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Create a sequence-style diagram in draw.io for the following interactions. Use batch_add_elements for efficiency:

1. First, call create_diagram with filePath="${filePath}"
2. Then call batch_add_elements with ALL elements at once:
   - Participant boxes across the top (y=40) with shape "roundedRectangle", spaced 250px apart horizontally
   - Vertical dashed lifelines from each participant downward using edges with style "dashed;endArrow=none;endFill=0;"
   - Horizontal arrows between lifelines for each message, progressing downward

LAYOUT RULES (CRITICAL for sequence diagrams):
- Participant spacing: 250px horizontally (not 200px — edge labels need room).
- Participant width: 140px, height: 50px.
- Message vertical spacing: 70px between each message arrow.
- Solid arrows (no special edgeStyle needed) for requests.
- Dashed arrows for responses: edgeStyle "curvedDashed" or style "dashed=1;".
- Edge labels: short (1-3 words). Labels automatically get white backgrounds.
- Self-calls: use exitPoint="rightTop25" and entryPoint="rightBottom75" on the same participant, with "curved" edgeStyle.
- Lifeline endpoints: add invisible nodes (style "strokeColor=none;fillColor=none;") at the bottom of each lifeline.
- Keep lifelines aligned vertically under each participant.

Interactions to visualize:
${interactionDescription}

IMPORTANT: Use meaningful IDs. Use batch_add_elements for the entire diagram.`,
      },
    }],
  })
);

// ── Helper ─────────────────────────────────────────────────────────────────

function formatDiagramSummary(info: any): string {
  const lines: string[] = [
    `Diagram: ${info.filePath}`,
    `Pages: ${info.pages.length} | Nodes: ${info.totalNodes} | Edges: ${info.totalEdges}`,
    '',
  ];

  for (const page of info.pages) {
    lines.push(`📄 Page: "${page.name}" (ID: ${page.id})`);
    const vertices = page.nodes.filter((n: any) => n.vertex);
    const edges = page.nodes.filter((n: any) => n.edge);

    if (vertices.length > 0) {
      lines.push('  Nodes:');
      for (const v of vertices) {
        const pos = v.geometry ? ` @ (${v.geometry.x ?? 0}, ${v.geometry.y ?? 0})` : '';
        const size = v.geometry ? ` [${v.geometry.width ?? 0}×${v.geometry.height ?? 0}]` : '';
        lines.push(`    • ${v.id}: "${v.value}"${pos}${size}`);
      }
    }

    if (edges.length > 0) {
      lines.push('  Edges:');
      for (const e of edges) {
        const label = e.value ? ` "${e.value}"` : '';
        lines.push(`    → ${e.id}: ${e.source} → ${e.target}${label}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function addHighlightToStyle(style: string, color: string): string {
  // Remove existing strokeColor/strokeWidth, add highlight
  let s = style
    .replace(/strokeColor=[^;]*;?/g, '')
    .replace(/strokeWidth=[^;]*;?/g, '')
    .replace(/shadow=[^;]*;?/g, '');
  if (!s.endsWith(';')) s += ';';
  return s + `strokeColor=${color};strokeWidth=3;shadow=1;shadowColor=${color};`;
}

// ── Start server ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();

  // Start optional WebSocket sidecar for companion extension
  const sidecarPort = parseInt(process.env.DRAWIO_MCP_SIDECAR_PORT || '9219', 10);
  if (process.env.DRAWIO_MCP_NO_SIDECAR !== '1') {
    await startSidecar(sidecarPort);
  }

  await server.connect(transport);
  console.error(`[drawio-mcp pid:${process.pid}] server started on stdio — sidecar port ${sidecarPort}`);

  process.on('SIGINT', () => { stopSidecar(); process.exit(0); });
  process.on('SIGTERM', () => { stopSidecar(); process.exit(0); });
}

main().catch((err) => {
  console.error(`[drawio-mcp pid:${process.pid}] fatal error:`, err);
  process.exit(1);
});
