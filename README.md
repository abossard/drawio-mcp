# drawio-mcp

MCP server that lets AI assistants create, read, and edit [draw.io](https://www.drawio.com/) diagrams. Pair it with the [VS Code draw.io extension](https://marketplace.visualstudio.com/items?itemName=hediet.vscode-drawio) and watch diagrams update in real time as the AI works.

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=drawio&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22github%3Aabossard%2Fdrawio-mcp%22%5D%7D) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=drawio&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22github%3Aabossard%2Fdrawio-mcp%22%5D%7D&quality=insiders)

### What can it do?

- **Create diagrams** — flowcharts, architecture diagrams, sequence diagrams from natural language
- **Read & understand** — parse existing `.drawio` files and describe their structure
- **Edit precisely** — add/remove/update individual nodes and edges
- **Undo mistakes** — full history with undo/redo, independent of the editor's Ctrl+Z
- **Live preview** — changes appear instantly in the VS Code draw.io editor, no reload

---

## Install

Click one of the badges above, or add this to `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "drawio": {
      "command": "npx",
      "args": ["-y", "github:abossard/drawio-mcp"]
    }
  }
}
```

> **Tip:** Commit this file to your repo — every contributor gets diagram support automatically.

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "drawio": {
      "command": "npx",
      "args": ["-y", "github:abossard/drawio-mcp"]
    }
  }
}
```

</details>

<details>
<summary><strong>VS Code user settings (all projects)</strong></summary>

Add to your **User** `settings.json` (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> → *Preferences: Open User Settings (JSON)*):

```json
{
  "mcp": {
    "servers": {
      "drawio": {
        "command": "npx",
        "args": ["-y", "github:abossard/drawio-mcp"]
      }
    }
  }
}
```

</details>

---

## Usage

Just ask your AI assistant:

> *"Create a flowchart for a user login process in `docs/login-flow.drawio`"*

> *"Read `architecture.drawio` and describe the components"*

> *"Add a Redis cache node between the API and Database, then highlight it"*

> *"Undo the last change"*

The server also ships with prompt templates — try asking to *"use the architecture prompt"* or *"use the flowchart prompt"*.

---

## Tools

### Diagram manipulation

| Tool | Description |
|------|-------------|
| `create_diagram` | Create a new `.drawio` file |
| `read_diagram` | Parse and return all pages, nodes, and edges |
| `add_node` | Add a shape with label, position, size, and style |
| `add_edge` | Connect two nodes with optional label and style |
| `update_element` | Modify label, style, position, or size |
| `remove_element` | Delete a node or edge by ID |
| `add_page` | Add a new page/tab |
| `get_diagram_styles` | List all predefined styles |

### History

| Tool | Description |
|------|-------------|
| `undo_last_operation` | Restore file to previous state |
| `redo_last_operation` | Re-apply last undone change |
| `get_change_history` | List recent operations |

### Visual feedback

| Tool | Description |
|------|-------------|
| `highlight_element` | Flash elements with a colored highlight |
| `show_ai_cursor` | Show AI cursor position † |
| `show_ai_selection` | Highlight AI-selected cells † |
| `show_status` | Status bar message † |
| `show_spinner` | Loading spinner † |

_† Requires the [companion extension](#companion-extension-optional)._

### Predefined styles

Use the `shape` parameter in `add_node` or `edgeStyle` in `add_edge`:

| Category | Styles |
|----------|--------|
| **Shapes** | `rectangle` `roundedRectangle` `ellipse` `diamond` `parallelogram` `hexagon` `triangle` `cylinder` `cloud` `document` `process` `star` `callout` |
| **Flowchart** | `start` `end` `decision` `processStep` `inputOutput` |
| **Architecture** | `server` `database` `firewall` `user` `container` |
| **UML** | `actor` `component` `package` `interface` |
| **Colors** | `blue` `green` `red` `yellow` `purple` `orange` `gray` |
| **Edges** | `straight` `orthogonal` `curved` `entityRelation` `dashed` `dotted` `bidirectional` `noArrow` |

---

## How it works

```
AI Assistant ──(MCP)──> drawio-mcp server ──(writes XML)──> .drawio file
                                                                  │
                                              VS Code draw.io extension
                                              detects change & live-merges
                                                        │
                                                   draw.io webview
                                                  (instant update ✨)
```

- ✅ No page reload — changes merge seamlessly
- ✅ Undo works — each write becomes one Ctrl+Z step
- ✅ User selection preserved — the merge doesn't disrupt anything

---

## Companion Extension (Optional)

The companion VS Code extension adds real-time AI presence overlays to the draw.io editor. Without it the core MCP tools (create, read, edit, undo) work fine — the extension adds the visual extras.

### What it adds

| Feature | Description |
|---------|-------------|
| 🤖 AI cursor | Shows where the AI is "looking" in the diagram |
| 🔲 Cell selection | Highlights which cells the AI is editing |
| ✨ Flash highlight | Temporary colored flash on elements |
| 💬 Status messages | Shows AI status in the editor (e.g. "Adding database…") |
| ⏳ Spinner | Loading indicator during long operations |
| 📐 Auto-layout | Applies layout algorithms (hierarchical, organic, tree, circle, radial) |

### Install

```bash
# From the drawio-mcp repo root:
cd vscode-drawio-mcp-bridge
npm install && npm run build
```

Then in VS Code: <kbd>F1</kbd> → *"Developer: Install Extension from Location..."* → select the `vscode-drawio-mcp-bridge` folder.

The extension auto-connects to the MCP server's WebSocket sidecar when you open a `.drawio` file. No extra configuration needed.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `drawioMcpBridge.websocketPort` | `9219` | WebSocket port (must match `DRAWIO_MCP_SIDECAR_PORT`) |
| `drawioMcpBridge.autoConnect` | `true` | Connect automatically when a `.drawio` file opens |
| `drawioMcpBridge.aiColor` | `#D13913` | Color for AI cursor and selection overlays |
| `drawioMcpBridge.aiLabel` | `🤖 AI` | Label shown next to the AI cursor |

### Commands

- **Draw.io MCP: Connect to Server** — manually connect to the sidecar
- **Draw.io MCP: Disconnect from Server** — disconnect

### How it works

```
┌─────────────────────────────────────────────────┐
│  VS Code                                        │
│                                                 │
│  draw.io extension          drawio-mcp-bridge   │
│  ┌──────────────┐          ┌─────────────────┐  │
│  │ draw.io       │◄─plugin─┤ Injects JS into │  │
│  │ webview       │         │ draw.io iframe   │  │
│  └──────────────┘          └────────┬────────┘  │
│                                     │ WebSocket  │
│                          ┌──────────▼────────┐  │
│                          │ drawio-mcp server  │  │
│                          │ sidecar (:9219)    │  │
│                          └───────────────────┘  │
└─────────────────────────────────────────────────┘
```

The extension injects a plugin into the draw.io iframe that opens its own WebSocket to the MCP sidecar (`ws://127.0.0.1:9219/drawio`). AI actions (cursor moves, highlights, status) flow through this channel. User interactions (mouse position, cell selection) are sent back to the MCP server so the AI knows what the user is looking at.

---

## Development

```bash
git clone https://github.com/abossard/drawio-mcp.git
cd drawio-mcp
npm install
npm test
```

Point VS Code at your local build — add to `.vscode/mcp.json` in any project:

```json
{
  "servers": {
    "drawio-dev": {
      "command": "node",
      "args": ["/absolute/path/to/drawio-mcp/build/index.js"]
    }
  }
}
```

Run `npm run dev` for watch mode — VS Code auto-restarts the server on each rebuild.

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm run dev` | Watch mode (rebuild on save) |
| `npm test` | Run tests |
| `npm run test:watch` | Watch mode for tests |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DRAWIO_MCP_SIDECAR_PORT` | `9219` | WebSocket port for companion extension |
| `DRAWIO_MCP_NO_SIDECAR` | `1` | Set to `1` to disable the WebSocket sidecar |

---

## License

[MIT](LICENSE)
