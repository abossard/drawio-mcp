# Draw.io MCP — Deep Research: Live Editing, History, Animations & Presence

## Executive Summary

After deep research into the draw.io ecosystem, VS Code extension internals, embed API, and MCP protocol, here are the key findings and a concrete architecture for achieving live editing with history, animations, and presence awareness.

---

## 1. How the VS Code draw.io Extension Works

The [hediet/vscode-drawio](https://github.com/hediet/vscode-drawio) extension:

- Uses VS Code **Custom Editor API** (`CustomTextEditorProvider` for `.drawio`/`.svg`, `CustomEditorProvider` for `.png`)
- Embeds draw.io as an **iframe webview** — the full draw.io web app runs inside VS Code
- Communicates via **postMessage JSON protocol** between extension host and webview
- **On external file change**: calls `drawioClient.mergeXmlLike(newText)` — this is key!
- **On user edit in draw.io**: receives `autosave` event, applies `WorkspaceEdit` to update the text document

### The `merge` Action — Key to Live Editing

```typescript
// When a file changes on disk (e.g., from MCP server write):
workspace.onDidChangeTextDocument(async (evt) => {
    const newText = evt.document.getText();
    await drawioClient.mergeXmlLike(newText);  // Diffs and patches the live editor
});
```

**This means our MCP server can achieve live editing simply by writing to the file.** The extension detects the change, reads the new XML, and merges it into the live draw.io editor without reloading — preserving the user's undo history and selection.

### Extension Plugin API

The extension supports injecting custom JavaScript plugins into draw.io:

```typescript
// Any VS Code extension with "isDrawioExtension": true can provide plugins:
export interface DrawioExtensionApi {
    drawioExtensionV1?: {
        getDrawioPlugins?: (context: DocumentContext) => Promise<{ jsCode: string }[]>;
    };
}
```

---

## 2. draw.io Embed postMessage Protocol

The full JSON protocol between the host and draw.io iframe:

| Direction | Message | Purpose |
|-----------|---------|---------|
| Host → draw.io | `{action: "load", xml: "...", autosave: 1}` | Load diagram |
| Host → draw.io | `{action: "merge", xml: "..."}` | **Merge external changes (live edit!)** |
| Host → draw.io | `{action: "export", format: "xml\|png\|svg"}` | Export diagram |
| Host → draw.io | `{action: "status", message: "...", modified: bool}` | Show status message |
| Host → draw.io | `{action: "spinner", message: "...", show: bool}` | Show/hide spinner |
| Host → draw.io | `{action: "layout", layouts: [...]}` | Run auto-layout |
| Host → draw.io | `{action: "configure", config: {...}}` | Configure editor |
| draw.io → Host | `{event: "init"}` | Editor ready |
| draw.io → Host | `{event: "autosave", xml: "..."}` | Diagram changed |
| draw.io → Host | `{event: "save", xml: "..."}` | User saved |
| draw.io → Host | `{event: "export", data: "...", format: "..."}` | Export result |
| draw.io → Host | `{event: "merge", error: "..."}` | Merge result |

---

## 3. Collaboration & Presence (Already Implemented!)

### The extension has VS Code Live Share integration!

Found in `src/features/LiveshareFeature/`:
- Full cursor sharing, cell selection sharing, and selection rectangle sharing
- Each peer gets a **color** from a 10-color palette
- Uses `updateLiveshareViewState` custom action

### The `updateLiveshareViewState` Protocol

```typescript
// Action sent TO the draw.io webview:
{
    action: "updateLiveshareViewState",
    cursors: [{
        id: "ai-assistant",
        position: { x: 300, y: 200 },
        label: "🤖 AI",
        color: "#D13913"  // Red for AI
    }],
    selectedCells: [{
        id: "ai-assistant",
        color: "#D13913",
        selectedCellIds: ["node-1", "node-2"]  // Cells being edited
    }],
    selectedRectangles: [{
        id: "ai-assistant",
        color: "#D13913",
        rectangle: {
            start: { x: 100, y: 100 },
            end: { x: 400, y: 300 }
        }
    }]
}
```

### Custom Events FROM draw.io

```typescript
// Events the webview sends to the extension:
{ event: "cursorChanged", position: { x: number, y: number } | undefined }
{ event: "selectedCellsChanged", selectedCellIds: string[] }
{ event: "selectedRectangleChanged", rect: { start: Point, end: Point } | undefined }
{ event: "focusChanged", hasFocus: boolean }
{ event: "nodeSelected", label: string, linkedData: unknown }
```

**This is the exact mechanism we need for showing "who is editing what"!**

---

## 4. History & Undo

### How mxGraph Undo Works
- `mxUndoManager` maintains undo/redo stacks of `mxUndoableEdit` objects
- Each edit contains atomic changes (cellAdded, cellRemoved, attributeChanged, etc.)
- `model.beginUpdate()` / `endUpdate()` groups changes into single undo steps

### Impact of MCP File Writes
When the MCP server writes to a file and the extension's `merge` action processes it:
- **The merge creates ONE undoable edit** containing all differences
- **User CAN Ctrl+Z** to undo the AI's changes!
- This is the best possible behavior — each MCP operation = one undo step

### MCP-Side History Strategy
For the MCP server to provide its own undo:
1. Store XML snapshots before each mutating operation
2. Implement `undo_last_operation` tool that restores previous snapshot
3. Store structured change log with operation metadata

---

## 5. Animations & Visual Feedback

### Style-Based Visual Effects

| Effect | Style Properties |
|--------|-----------------|
| Highlight (yellow) | `fillColor=#ffff00;` |
| Glow | `shadow=1;shadowColor=#0088ff;` |
| Semi-transparent | `opacity=60;` |
| Dashed (motion) | `dashed=1;dashPattern=5 3;` |
| Bold outline | `strokeWidth=3;strokeColor=#ff0000;` |
| Pulsing | Alternate opacity via repeated writes |

### Approach: Temporary Highlighting via File Writes

```
1. Read current style of element
2. Apply highlight style (e.g., yellow fill + thick stroke)
3. Write file → extension merges → draw.io shows highlight
4. Wait 500ms
5. Restore original style
6. Write file → extension merges → draw.io removes highlight
```

### Via Companion Extension

```typescript
// Show status message in draw.io:
drawioClient.sendAction({ action: "status", message: "🤖 AI: Adding database node...", modified: false });

// Show spinner during long operations:
drawioClient.sendAction({ action: "spinner", message: "Generating diagram...", show: true });
```

---

## 6. Recommended Architecture

### Option A: File-Based Only (Current — Works Today)

```
MCP Server ──(writes .drawio)──> File System ──(fs.watch)──> VS Code Extension ──(merge)──> draw.io
```

**Pros**: Simple, works now. **Cons**: No presence, no animations, one-way.

### Option B: Companion Extension (Recommended)

```
┌──────────────────────────────────────────────────┐
│  VS Code                                         │
│                                                  │
│  ┌─────────────────┐   ┌──────────────────────┐ │
│  │ draw.io          │   │ drawio-mcp-bridge    │ │
│  │ Extension        │   │ Extension            │ │
│  │                  │   │                      │ │
│  │ ┌──────────────┐│   │ • Injects JS plugin  │ │
│  │ │draw.io iframe││◄──┤ • Sends AI cursors   │ │
│  │ │              ││   │ • Shows AI highlights │ │
│  │ └──────────────┘│   │ • Status messages     │ │
│  └─────────────────┘   │ • Manages history     │ │
│                         └──────────┬───────────┘ │
│                                    │ WebSocket    │
│                         ┌──────────▼───────────┐ │
│                         │ drawio-mcp Server     │ │
│                         │ • CRUD tools          │ │
│                         │ • Undo/redo snapshots │ │
│                         │ • Edit notifications  │ │
│                         │ • File watching       │ │
│                         └──────────────────────┘ │
└──────────────────────────────────────────────────┘
```

The companion extension:
1. Registers as `"isDrawioExtension": true`
2. Injects a custom draw.io plugin for cursor/selection overlays
3. Opens a WebSocket to the MCP server's sidecar port
4. Forwards AI edit notifications as `updateLiveshareViewState` actions
5. Shows status bar messages for AI operations

### Option C: Plugin Injection Only (Simplest Enhancement)

Instead of a full companion extension, inject a draw.io plugin that:
- Connects to MCP server via WebSocket
- Has full mxGraph API access
- Can highlight cells, show cursors, trigger CSS animations
- Reports user edits back to MCP server

---

## 7. Implementation Roadmap

### Phase 2a: History/Undo (MCP Server Only)
- Add XML snapshot storage before each mutation
- New tools: `undo_last_operation`, `redo_last_operation`, `get_change_history`
- Track operation metadata (timestamp, tool, affected elements)

### Phase 2b: Companion VS Code Extension
- Create `drawio-mcp-bridge` extension
- WebSocket connection to MCP server sidecar
- Inject draw.io plugin for:
  - AI cursor overlay (position + color + label)
  - Cell selection highlighting (shows which cells AI is editing)
  - Status bar messages ("🤖 AI is adding: Database node")

### Phase 2c: Bidirectional Sync
- MCP server watches .drawio files for user changes
- Emits `notifications/resources/updated` when files change
- User edits flow to MCP → MCP can react to changes
- MCP edits flow to file → extension merges → user sees live

### Phase 2d: Animations
- `highlight_element` tool: flash a cell with a color and restore
- `show_ai_cursor` tool: position AI cursor in diagram
- `show_progress` tool: show spinner/status in draw.io
- Animated step-by-step diagram building (add node, highlight, pause, add edge, etc.)
