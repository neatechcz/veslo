# Browser Extension Auto-Install Design

**Date:** 2026-03-06
**Status:** Approved
**Branch:** TBD

## Goal

Make the OpenCode browser extension (`@different-ai/opencode-browser`) installation as automatic as possible for OpenWork desktop app users. Currently the extension requires manual `npx` download, loading unpacked in Chrome, and enabling Developer mode. The new flow should be one-click.

## Approach: Chrome Web Store Publish + Deep Link

Publish the extension to the Chrome Web Store (CWS submission materials already exist in the opencode-browser repo). The desktop app opens a CWS install link so the user just clicks "Add to Chrome". Native messaging host registration is handled automatically by the desktop app.

## Architecture

### Phase 1 — App Startup (automatic, silent)

- Detect all installed Chromium browsers (Chrome, Edge, Brave, Chromium)
- Register the native messaging host manifest in each detected browser's native messaging directory:
  - macOS Chrome: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
  - macOS Edge: `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`
  - macOS Brave: `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/`
  - Linux Chrome: `~/.config/google-chrome/NativeMessagingHosts/`
  - Linux Edge: `~/.config/microsoft-edge/NativeMessagingHosts/`
  - Linux Brave: `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/`
  - Windows: Registry-based per browser (HKCU)
- Ensure `opencode.json` has the browser plugin MCP configuration
- Skip writing if manifest already exists and is up-to-date; overwrite if outdated

### Phase 2 — User Triggers Browser Setup

- User clicks "Automate your browser" button or runs `/browser-setup` command
- App checks if extension is already connected (native messaging ping)
- If connected → skip to success state
- If not connected:
  - If multiple Chromium browsers detected → show browser picker
  - Open Chrome Web Store link (`https://chromewebstore.google.com/detail/EXTENSION_ID`) in the chosen browser
  - CWS works for Chrome, Brave (native CWS support), and Edge (with "Allow extensions from other stores" toggle)
  - Show in-app status: "Click 'Add to Chrome' in the store page"

### Phase 3 — Connection Confirmation

- Poll for native messaging connection every 2-3 seconds
- On success → dismiss banner, show "Browser extension connected!"
- Offer a first browser task to try
- On timeout (60s) → "Still waiting... Did you click 'Add to Chrome'?" with retry button
- After 2 minutes → offer manual fallback (LLM-guided `browser-setup` command)

## Components

### 1. Native Messaging Host Registrar (Rust, Tauri side)

New module: `packages/desktop/src-tauri/src/browser_extension.rs`

Functions:
- `detect_chromium_browsers()` → returns list of detected browsers with their native messaging host paths
- `register_native_messaging_hosts()` → writes the manifest JSON to each browser's directory
- `check_extension_connected()` → attempts native messaging ping to detect if extension is active

Called during `ensure_workspace_files()` or app startup.

### 2. Browser Extension Setup Command (Tauri command)

New Tauri command `install_browser_extension` exposed to the frontend:
- Takes a browser choice parameter
- Opens the CWS link in the selected browser (using `tauri-plugin-opener`)
- Returns the list of detected browsers for the picker

### 3. Frontend Setup Flow (SolidJS, app side)

Modifies the existing "Automate your browser" button flow:
1. Browser picker (if multiple browsers detected)
2. "Installing..." status with CWS link opened
3. Polls `check_extension_connected` every 2-3s
4. Success state with "Try your first task" prompt
5. Falls back to LLM-guided flow if something goes wrong

### 4. CWS Publishing (one-time setup, opencode-browser repo)

- Use existing `build:cws` script
- Submit using existing `CHROME_WEB_STORE.md` materials
- Store the extension ID as a constant in the desktop app

## Error Handling

| Scenario | Behavior |
|---|---|
| No browsers detected | Show "No supported browser found" with download links |
| CWS page opened, user doesn't install | Timeout 60s → retry prompt; 2min → manual fallback |
| Extension installed but not connected | Guide to check extension is enabled and pinned |
| Edge selected | Show note about "Allow extensions from other stores" toggle before opening CWS |
| Native messaging host dir doesn't exist | Create it (no elevated permissions needed on macOS/Linux) |
| Windows registry | Write to HKCU (no admin needed) |
| Manifest already exists and current | Skip (compare content) |
| Manifest outdated | Overwrite |

## Not Doing

- Bundling extension files in the Tauri app (CWS handles distribution)
- Chrome enterprise policies (too heavy-handed for consumer app)
- `--load-extension` flag approach (separate Chrome profile issues)
- Firefox support (not a Chromium browser)
