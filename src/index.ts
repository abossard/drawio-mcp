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
} from './drawio.js';
import { SHAPE_STYLES, EDGE_STYLES } from './styles.js';
import { startSidecar, stopSidecar, sendToDrawio, hasConnectedClients } from './sidecar.js';

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
        content: [{ type: 'text', text: `Created diagram: ${resolved}` }],
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
  'Add a connection (edge/arrow) between two nodes in a draw.io diagram.',
  {
    filePath: z.string().describe('Path to the .drawio file'),
    sourceId: z.string().describe('ID of the source node'),
    targetId: z.string().describe('ID of the target node'),
    label: z.string().optional().describe('Label for the edge'),
    edgeStyle: z.string().optional().describe(
      `Predefined edge style. Available: ${Object.keys(EDGE_STYLES).join(', ')}`
    ),
    style: z.string().optional().describe('Custom draw.io style string'),
    pageIndex: z.number().optional().describe('Page index (0-based, default: 0)'),
    id: z.string().optional().describe('Custom ID for the edge'),
  },
  async ({ filePath, sourceId, targetId, label, edgeStyle, style, pageIndex, id }) => {
    try {
      const result = await addEdge(filePath, { sourceId, targetId, label, edgeStyle, style, pageIndex, id });
      return {
        content: [{ type: 'text', text: `Added edge from ${sourceId} → ${targetId} with ID: ${result.id}` }],
      };
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
    durationMs: z.number().optional().describe('Duration of highlight in ms (default: 1500)'),
  },
  async ({ filePath, elementIds, color, durationMs }) => {
    const highlightColor = color || '#FFD700';
    const duration = durationMs || 1500;

    try {
      // Prefer sidecar/companion extension path (non-destructive overlay)
      if (hasConnectedClients()) {
        sendToDrawio({
          type: 'highlight',
          data: { cellIds: elementIds, color: highlightColor },
        });

        // Schedule unhighlight
        setTimeout(() => {
          sendToDrawio({
            type: 'unhighlight',
            data: { cellIds: elementIds },
          });
        }, duration);

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
    x: z.number().describe('X position in diagram coordinates'),
    y: z.number().describe('Y position in diagram coordinates'),
    label: z.string().optional().describe('Label next to cursor (default: "🤖 AI")'),
    color: z.string().optional().describe('Cursor color hex (default: "#D13913")'),
  },
  async ({ x, y, label, color }) => {
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
    });
    return { content: [{ type: 'text', text: `AI cursor shown at (${x}, ${y})` }] };
  }
);

server.tool(
  'show_ai_selection',
  'Highlight specific cells in the draw.io diagram as being selected/edited by AI. Shows a colored overlay around the cells. Requires the companion VS Code extension.',
  {
    cellIds: z.array(z.string()).describe('IDs of cells to show as AI-selected'),
    color: z.string().optional().describe('Selection overlay color (default: "#D13913")'),
  },
  async ({ cellIds, color }) => {
    if (!hasConnectedClients()) {
      return { content: [{ type: 'text', text: 'No companion extension connected. Install drawio-mcp-bridge in VS Code.' }], isError: true };
    }
    sendToDrawio({
      type: 'selection',
      data: {
        cellIds,
        color: color || '#D13913',
      },
    });
    return { content: [{ type: 'text', text: `AI selection shown on ${cellIds.length} cell(s): ${cellIds.join(', ')}` }] };
  }
);

// ── Resources ──────────────────────────────────────────────────────────────

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
        text: `Create a flowchart in draw.io for the following process. Use the drawio-mcp tools to build this step by step:

1. First, call create_diagram with filePath="${filePath}"
2. Add start/end nodes using shape "start" and "end"
3. Add process steps using shape "processStep"
4. Add decision points using shape "decision"
5. Add input/output operations using shape "inputOutput"
6. Connect all nodes with edges using add_edge
7. Use descriptive labels on all nodes and decision edges (e.g., "Yes"/"No")

Arrange nodes in a top-to-bottom flow with ~100px vertical spacing between steps.
Use x=300 as center alignment. Start at y=40.

Process to visualize:
${processDescription}

IMPORTANT: Use meaningful IDs for nodes (e.g., "start", "check-input", "process-data") so edges are easy to trace.`,
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
        text: `Create an architecture diagram in draw.io for the following system. Use the drawio-mcp tools:

1. First, call create_diagram with filePath="${filePath}"
2. Use these shapes for different component types:
   - "database" for databases/data stores
   - "server" for backend services
   - "cloud" for cloud/external services
   - "user" for user/actor nodes
   - "container" for grouping related components (make these larger, e.g. 300x200)
   - "blue" for web/frontend components
   - "green" for API/service components
   - "orange" for message queues/middleware
3. Connect components with labeled edges showing data flow
4. Use "orthogonal" edgeStyle for clean routing
5. Arrange in layers: Users (top) → Frontend → Backend → Data (bottom)

System to visualize:
${systemDescription}

IMPORTANT: Use meaningful IDs and proper spacing (200px horizontal, 150px vertical between layers).`,
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
        text: `Create a sequence-style diagram in draw.io for the following interactions. Use the drawio-mcp tools:

1. First, call create_diagram with filePath="${filePath}"
2. Create participant boxes across the top (y=40) with shape "roundedRectangle", spaced ~200px apart horizontally
3. Draw vertical dashed lines (lifelines) from each participant downward using edges with style "dashed;endArrow=none;endFill=0;"
4. Add horizontal arrows between lifelines for each message/interaction, progressing downward (increase y by ~60 for each step)
5. Label each arrow with the message/action
6. Use solid arrows for requests and dashed arrows for responses

Interactions to visualize:
${interactionDescription}

IMPORTANT: Keep lifelines aligned vertically under each participant. Use meaningful IDs.`,
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
  console.error('drawio-mcp server started on stdio');

  process.on('SIGINT', () => { stopSidecar(); process.exit(0); });
  process.on('SIGTERM', () => { stopSidecar(); process.exit(0); });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
