---
applyTo: '**'
---

# drawio-mcp — Agent Instructions

## Project Overview
- **MCP server** for creating, reading, and updating draw.io diagrams
- **Bridge VS Code extension** (`vscode-drawio-mcp-bridge/`) that injects a JS plugin into the draw.io editor for live overlays (highlight, cursor, spinner, status, selection)
- WebSocket **sidecar** on port 9219 connects MCP server ↔ bridge extension ↔ draw.io plugin
- Multi-instance aware: first process becomes server, others relay through it

## Architecture

```
MCP Server (build/index.js)
  ├── drawio.ts      — diagram read/write/layout analysis
  ├── styles.ts      — shape/edge style presets
  ├── sidecar.ts     — WebSocket server (port 9219) or relay client
  └── index.ts       — MCP tool definitions

Bridge Extension (vscode-drawio-mcp-bridge/)
  ├── extension.ts       — VS Code extension entry, auto-connects BridgeClient
  ├── bridge-client.ts   — WebSocket client → sidecar (extension channel)
  └── plugin-provider.ts — JS code injected into draw.io webview (overlay rendering)
```

## Build Commands

### MCP Server
```bash
cd /Users/abossard/Desktop/projects/drawio-mcp
npm run build          # or: npx tsc
npm test               # run vitest
```
Output: `build/` directory

### Bridge Extension (VSIX)
```bash
cd /Users/abossard/Desktop/projects/drawio-mcp/vscode-drawio-mcp-bridge
npx tsc                # compile TS → out/
npx @vscode/vsce package --no-dependencies --allow-missing-repository
# Produces: drawio-mcp-bridge-0.1.0.vsix
```

### Install Bridge Extension
```bash
code-insiders --install-extension /Users/abossard/Desktop/projects/drawio-mcp/vscode-drawio-mcp-bridge/drawio-mcp-bridge-0.1.0.vsix --force
```
Then **reload VS Code** (Cmd+Shift+P → "Developer: Reload Window") for changes to take effect.

### Full Rebuild + Install (one-liner)
```bash
cd /Users/abossard/Desktop/projects/drawio-mcp && npx tsc && cd vscode-drawio-mcp-bridge && npx tsc && npx @vscode/vsce package --no-dependencies --allow-missing-repository <<< "y" && code-insiders --install-extension drawio-mcp-bridge-0.1.0.vsix --force
```

## Restart & Process Management

### Check running MCP processes
```bash
ps aux | grep "drawio-mcp/build/index.js" | grep -v grep
```

### Check sidecar port
```bash
lsof -i :9219
```

### Kill stale MCP processes
```bash
pkill -f "drawio-mcp/build/index.js"
```
Then reload VS Code — it will respawn the MCP server.

### After code changes, the reload sequence is:
1. `npx tsc` (build MCP server)
2. Reload VS Code (respawns MCP server with new code)
3. If bridge plugin-provider.ts changed: also rebuild VSIX, install, reload again

## Testing

```bash
npm test               # run all tests once
npm run test:watch     # watch mode
npx vitest run src/__tests__/drawio.test.ts   # single file
```

Test files:
- `src/__tests__/drawio.test.ts` — diagram manipulation + layout analysis
- `src/__tests__/sidecar.test.ts` — WebSocket sidecar lifecycle
- `src/__tests__/styles.test.ts` — style presets

## Key Concepts

### Sidecar Multi-Instance Behavior
- First MCP process binds port 9219 → **server mode**
- Subsequent processes → **relay mode** (WebSocket client to existing server)
- If server dies, relay processes attempt to **escalate to server** every 3s
- `check_connection` tool reports current mode

### Bridge Extension Plugin Injection
- `plugin-provider.ts` returns JS code that draw.io loads as a plugin
- The JS runs inside draw.io's webview (iframe) — no CSS @keyframes, use JS-driven animations
- Plugin connects to `ws://127.0.0.1:9219/drawio` for overlay messages
- Has an overlay panel (🤖 MCP pill, top-left) with:
  - Connection status dot
  - Active overlay count badge
  - "Clear All Overlays" button
  - Message log

### Live Overlay Features (require bridge + sidecar)
- `highlight` — colored border flash on cells (auto-clears after duration)
- `cursor` — floating AI label at graph coordinates (auto-hides 20s)
- `selection` — AI selection overlay on cells (auto-clears 20s)
- `status` — toast message at bottom (auto-hides 20s)
- `spinner` — JS-driven loading indicator (persists until hidden)
- `layout` — apply mxGraph auto-layout in the editor

### File-Based Features (always work)
- `create_diagram`, `read_diagram`, `add_node`, `add_edge`, `update_element`, `remove_element`
- `batch_add_elements`, `check_layout`, `list_diagrams`
- `highlight_element` falls back to style modification when no sidecar connected

## Common Debugging

| Symptom | Cause | Fix |
|---------|-------|-----|
| `check_connection` shows 0 clients | Bridge not connected or stale process | Reload VS Code |
| Overlays stuck | Old plugin code in webview | Rebuild VSIX, install, reload, reopen .drawio file |
| Spinner not visible | CSS animation blocked in webview | Fixed: uses JS-driven rotation |
| Multiple processes, only one works | Port contention | Relay mode handles this; kill stale processes if needed |
| RELAY mode but no server | Primary process died | Relay auto-escalates to server within 3s |
