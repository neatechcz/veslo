# Tauri Pilot for Agents

This project has `tauri-pilot` integrated for debug builds of the desktop Tauri app.

## What is installed

- Desktop plugin dependency: `packages/desktop/src-tauri/Cargo.toml`
- Plugin registration: `packages/desktop/src-tauri/src/lib.rs`
- Required Tauri permission: `packages/desktop/src-tauri/capabilities/default.json`
- CLI installed for WSL: `/home/jajse/.cargo/bin/tauri-pilot`
- CLI installed for Windows: `C:\Users\jajse\.cargo\bin\tauri-pilot.exe`
- Codex MCP config: `/home/jajse/.codex/config.toml`

The Codex MCP entry is:

```toml
[mcp_servers.tauri-pilot]
command = "/mnt/c/Users/jajse/.cargo/bin/tauri-pilot.exe"
args = ["mcp"]
```

Restart Codex after changing MCP config so the server is loaded.

## Why use it

Playwright does not reliably drive Tauri desktop windows because Tauri uses system WebViews, not a browser process that Playwright controls. `tauri-pilot` runs a debug-only plugin inside the Tauri app and exposes the UI through a compact accessibility snapshot.

Benefits for agents:

- Inspect the real desktop UI, not just browser/dev-server state.
- Interact with elements by stable snapshot refs such as `@e3`.
- Verify outcomes with commands like `assert`, `diff`, `logs`, and `eval`.
- Use MCP tools from Codex instead of repeatedly shelling out.
- Keep production builds clean because the plugin is registered only under `debug_assertions`.

## Basic workflow

Start the desktop dev app first:

```bash
pnpm dev
```

Then, from another shell:

```bash
/mnt/c/Users/jajse/.cargo/bin/tauri-pilot.exe ping
/mnt/c/Users/jajse/.cargo/bin/tauri-pilot.exe snapshot -i
```

Use the refs from the snapshot:

```bash
/mnt/c/Users/jajse/.cargo/bin/tauri-pilot.exe click @e3
/mnt/c/Users/jajse/.cargo/bin/tauri-pilot.exe fill @e2 "search text"
/mnt/c/Users/jajse/.cargo/bin/tauri-pilot.exe diff -i
/mnt/c/Users/jajse/.cargo/bin/tauri-pilot.exe assert visible @e1
```

For complex JavaScript:

```bash
/mnt/c/Users/jajse/.cargo/bin/tauri-pilot.exe eval - <<'EOF'
document.title
EOF
```

## MCP usage in Codex

After Codex is restarted, the `tauri-pilot` MCP server should expose tools under names like:

- `pilot.snapshot`
- `pilot.click`
- `pilot.fill`
- `pilot.logs`
- `pilot.network`
- `pilot.eval`
- `pilot.ipc`
- `pilot.assert_*`

Prefer this loop:

1. `pilot.snapshot` with interactive filtering.
2. Interact through refs from the latest snapshot.
3. Use `pilot.diff` or `pilot.assert_*` to verify.
4. Use `pilot.logs` for frontend errors.

Refs are snapshot-local. Take a fresh snapshot before interacting if the UI changed significantly.

## Platform notes

Use the Windows executable for this project:

```bash
/mnt/c/Users/jajse/.cargo/bin/tauri-pilot.exe
```

The app is commonly built and run through the Windows Rust/Tauri toolchain, and the Windows CLI can talk to the Windows named pipe created by the plugin. The WSL binary exists, but it is mainly useful for Linux Tauri apps.

If WSL `cargo check` fails on `glib-2.0`, `gobject-2.0`, or `gio-2.0`, that means Linux Tauri development packages are missing. Windows `cargo check` has already been verified for this integration.

## Troubleshooting

If `ping` cannot connect:

- Make sure the Tauri desktop app is running in debug/dev mode.
- Make sure Codex was restarted after MCP config changes.
- Check that the app identifier is `com.neatech.veslo.dev` in dev config.
- Try CLI first before MCP:

```bash
/mnt/c/Users/jajse/.cargo/bin/tauri-pilot.exe windows
/mnt/c/Users/jajse/.cargo/bin/tauri-pilot.exe ping
```

If there are multiple windows, target the main window explicitly:

```bash
/mnt/c/Users/jajse/.cargo/bin/tauri-pilot.exe --window main snapshot -i
```

