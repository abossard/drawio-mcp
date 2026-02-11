# drawio-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that enables AI assistants to create, read, and manipulate [draw.io](https://www.drawio.com/) diagrams. Works seamlessly with the [VS Code draw.io extension](https://marketplace.visualstudio.com/items?itemName=hediet.vscode-drawio) for real-time visual feedback.

## Install

[<img src="https://img.shields.io/badge/Install_in_VS_Code-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Install in VS Code">](https://insiders.vscode.dev/redirect/mcp/install?name=drawio-mcp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22github%3Aabossard%2Fdrawio-mcp%22%5D%7D)

Or copy this into `.vscode/mcp.json` in your project:

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

That's it. VS Code downloads, builds, and starts the server automatically.

<details>
<summary><strong>Other install methods</strong></summary>

#### VS Code — user-wide (all projects)

Add to **User** `settings.json` (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> → *Preferences: Open User Settings (JSON)*):

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

#### Claude Desktop

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

#### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DRAWIO_MCP_SIDECAR_PORT` | `9219` | WebSocket port for companion extension |
| `DRAWIO_MCP_NO_SIDECAR` | `0` | Set to `1` to disable the WebSocket sidecar |

</details>

## Features

### 🛠️ Diagram Tools (16 total)

| Tool | Description |
|------|-------------|
| `create_diagram` | Create a new `.drawio` file with an empty diagram |
| `read_diagram` | Parse a diagram and return structured overview of all pages, nodes, and edges |
| `add_node` | Add a shape/vertex with label, position, size, and style |
| `add_edge` | Add a connection between two nodes with optional label and style |
| `update_element` | Modify an existing node or edge (label, style, position, size) |
| `remove_element` | Remove a node or edge by ID |
| `add_page` | Add a new page/tab to a multi-page diagram |
| `get_diagram_styles` | List all available predefined shape and edge styles |

### 🕐 History & Undo Tools

| Tool | Description |
|------|-------------|
| `undo_last_operation` | Undo the last MCP operation, restoring the file to its previous state |
| `redo_last_operation` | Redo the last undone operation |
| `get_change_history` | List recent operations with timestamps and affected elements |

Every mutating operation (add/update/remove) creates an automatic snapshot. Undo/redo works independently of the draw.io editor's own Ctrl+Z — both work simultaneously.

### ✨ Animation & Visual Feedback Tools

| Tool | Description |
|------|-------------|
| `highlight_element` | Temporarily flash elements with a colored highlight effect |
| `show_ai_cursor` | Show an AI cursor at a position in the diagram† |
| `show_ai_selection` | Highlight cells as being AI-selected/edited† |
| `show_status` | Display a status message in the draw.io status bar† |
| `show_spinner` | Show/hide a loading spinner in the editor† |

_† Requires the companion VS Code extension (see below). `highlight_element` works with or without it._

### 📋 Resources

| Resource | URI | Description |
|----------|-----|-------------|
| Diagram Files | `drawio://files` | Lists all `.drawio` and `.dio` files in the working directory |

### 💬 Prompts

| Prompt | Description |
|--------|-------------|
| `flowchart` | Generate a flowchart from a process description |
| `architecture` | Generate an architecture diagram from system components |
| `sequence-diagram` | Generate a sequence diagram from interactions |

### 🎨 Predefined Styles

**Shapes:** `rectangle`, `roundedRectangle`, `ellipse`, `diamond`, `parallelogram`, `hexagon`, `triangle`, `cylinder`, `cloud`, `document`, `process`, `star`, `callout`

**UML:** `actor`, `component`, `package`, `interface`

**Flowchart:** `start` (green), `end` (red), `decision` (yellow), `processStep` (blue), `inputOutput` (purple)

**Architecture:** `server`, `database`, `firewall`, `user`, `container`

**Colors:** `blue`, `green`, `red`, `yellow`, `purple`, `orange`, `gray`

**Edges:** `straight`, `orthogonal`, `curved`, `entityRelation`, `arrow`, `openArrow`, `dashed`, `dotted`, `bidirectional`, `noArrow`

## How Live Editing Works

```
MCP Server ──(writes .drawio)──> File System
                                      ↓ (file watcher)
VS Code draw.io Extension ──(mergeXmlLike)──> draw.io Webview
```

When the MCP server writes to a `.drawio` file, the VS Code draw.io extension **automatically detects the change** and uses its `merge` action to diff and patch the live editor. This means:

- ✅ **No page reload** — changes appear seamlessly
- ✅ **Undo works** — each MCP write becomes one Ctrl+Z step in the editor
- ✅ **User selection preserved** — the merge doesn't disrupt what the user is doing

## Companion VS Code Extension (Optional)

For advanced features (AI presence overlays, status messages, spinners), install the companion extension:

```bash
cd vscode-drawio-mcp-bridge
npm install
npm run build
```

Then install it in VS Code (F1 → "Developer: Install Extension from Location...").

The companion extension:
- Connects to the MCP server's WebSocket sidecar (port 9219)
- Injects a draw.io plugin for AI cursor/selection overlays
- Uses the same protocol as VS Code Live Share for presence display
- Shows colored highlights around cells the AI is editing

### Architecture with Companion Extension

```
┌────────────────────────────────────────────────────┐
│  VS Code                                           │
│                                                    │
│  ┌──────────────────┐   ┌───────────────────────┐ │
│  │ draw.io Extension │   │ drawio-mcp-bridge     │ │
│  │ (hediet)          │   │ Extension             │ │
│  │ ┌──────────────┐ │   │                       │ │
│  │ │draw.io iframe │◄├───┤ • AI cursor overlays  │ │
│  │ │              │ │   │ • Cell highlighting   │ │
│  │ └──────────────┘ │   │ • Status messages     │ │
│  └──────────────────┘   └──────────┬────────────┘ │
│                                    │ WebSocket     │
│                         ┌──────────▼────────────┐  │
│                         │ drawio-mcp Server      │  │
│                         │ • 16 MCP tools         │  │
│                         │ • History/undo system  │  │
│                         │ • File watcher         │  │
│                         │ • WS sidecar (:9219)   │  │
│                         └────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

## Usage Examples

### Create a flowchart
> "Create a flowchart for a user login process in `docs/login-flow.drawio`"

### Read an existing diagram
> "Read `architecture.drawio` and describe the components"

### Modify with visual feedback
> "Add a Redis cache node between the API and Database in `architecture.drawio` and highlight it"

### Use a prompt template
> "Use the architecture prompt to create a diagram of a microservices system"

### Undo changes
> "Undo the last change to the diagram"

## Project Structure

```
drawio-mcp/
├── src/
│   ├── index.ts          # MCP server, all 16 tools, resources, prompts
│   ├── drawio.ts         # Draw.io XML parser, manipulator, history, file watcher
│   ├── styles.ts         # 30+ predefined shape and edge styles
│   └── sidecar.ts        # WebSocket server for companion extension
├── vscode-drawio-mcp-bridge/
│   └── src/
│       ├── extension.ts      # VS Code extension entry point
│       ├── bridge-client.ts  # WebSocket client to MCP sidecar
│       └── plugin-provider.ts # draw.io plugin injection (AI overlays)
├── build/                # Compiled output
├── package.json
├── tsconfig.json
└── RESEARCH.md           # Deep research on draw.io APIs
```

## Development

```bash
git clone https://github.com/abossard/drawio-mcp.git
cd drawio-mcp
npm install
npm test
```

To use your local build in VS Code, add to `.vscode/mcp.json` in any project:

```json
{
  "servers": {
    "drawio": {
      "command": "node",
      "args": ["/absolute/path/to/drawio-mcp/build/index.js"]
    }
  }
}
```

Run `npm run dev` to rebuild on every save — VS Code restarts the MCP server automatically.

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript once |
| `npm run dev` | Watch mode — rebuild on save |
| `npm test` | Run all tests |
| `npm run test:watch` | Re-run tests on save |
| `npm start` | Start the MCP server |

## License

[MIT](LICENSE)
