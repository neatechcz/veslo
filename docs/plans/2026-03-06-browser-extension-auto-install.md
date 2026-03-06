# Browser Extension Auto-Install Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Auto-install the OpenCode browser extension for OpenWork desktop users — auto-register native messaging host on startup, open Chrome Web Store link on setup, and poll for connection.

**Architecture:** New Rust module `browser_extension.rs` detects installed Chromium browsers and registers the native messaging host manifest. New Tauri commands expose browser detection and setup to the frontend. The frontend modifies the existing "Automate your browser" button to show a browser picker, open the CWS link, and poll for connection instead of launching an LLM-guided flow.

**Tech Stack:** Rust (Tauri backend), SolidJS/TypeScript (frontend), Chrome Native Messaging, Chrome Web Store

**Design doc:** `docs/plans/2026-03-06-browser-extension-auto-install-design.md`

---

## Prerequisite: CWS Extension ID

Before implementation, the extension must be published to the Chrome Web Store. The `different-ai/opencode-browser` repo already has `build:cws` and `CHROME_WEB_STORE.md` for this. Once published, note the extension ID (32-char string like `abcdefghijklmnopabcdefghijklmnop`).

For development, use a placeholder constant that gets replaced once the real CWS ID is known.

---

### Task 1: Rust Browser Detection Module

**Files:**
- Create: `packages/desktop/src-tauri/src/browser_extension.rs`

**Step 1: Create the browser detection and native messaging registration module**

```rust
// packages/desktop/src-tauri/src/browser_extension.rs

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::paths::home_dir;

/// Chrome Web Store extension ID (replace with real ID after CWS publishing)
const CWS_EXTENSION_ID: &str = "PLACEHOLDER_EXTENSION_ID";

/// Native messaging host name (must match what the extension expects)
const NM_HOST_NAME: &str = "com.opencode.browser_automation";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedBrowser {
    pub name: String,
    pub nm_host_dir: String,
}

/// Detect installed Chromium-based browsers by checking if their data directory exists.
pub fn detect_chromium_browsers() -> Vec<DetectedBrowser> {
    let home = match home_dir() {
        Some(h) => h,
        None => return vec![],
    };

    let candidates: Vec<(&str, PathBuf)> = if cfg!(target_os = "macos") {
        let base = home.join("Library").join("Application Support");
        vec![
            ("Google Chrome", base.join("Google").join("Chrome")),
            ("Microsoft Edge", base.join("Microsoft Edge")),
            ("Brave", base.join("BraveSoftware").join("Brave-Browser")),
            ("Chromium", base.join("Chromium")),
        ]
    } else if cfg!(target_os = "linux") {
        let base = home.join(".config");
        vec![
            ("Google Chrome", base.join("google-chrome")),
            ("Microsoft Edge", base.join("microsoft-edge")),
            ("Brave", base.join("BraveSoftware").join("Brave-Browser")),
            ("Chromium", base.join("chromium")),
        ]
    } else {
        // Windows: native messaging uses registry, not files. Not supported yet.
        vec![]
    };

    candidates
        .into_iter()
        .filter(|(_, data_dir)| data_dir.exists())
        .map(|(name, data_dir)| {
            let nm_host_dir = data_dir
                .join("NativeMessagingHosts")
                .to_string_lossy()
                .to_string();
            DetectedBrowser {
                name: name.to_string(),
                nm_host_dir,
            }
        })
        .collect()
}

/// Build the native messaging host manifest JSON for a given host wrapper path.
fn build_nm_manifest(host_wrapper_path: &str) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "name": NM_HOST_NAME,
        "description": "OpenCode Browser native messaging host",
        "path": host_wrapper_path,
        "type": "stdio",
        "allowed_origins": [
            format!("chrome-extension://{}/", CWS_EXTENSION_ID)
        ]
    }))
    .unwrap_or_default()
}

/// Register the native messaging host manifest for all detected browsers.
/// The host wrapper script must already exist at `~/.opencode-browser/host-wrapper.sh`.
/// Returns the number of browsers where the manifest was written.
pub fn register_native_messaging_hosts() -> Result<usize, String> {
    let home = home_dir().ok_or("Cannot determine home directory")?;
    let host_wrapper = home
        .join(".opencode-browser")
        .join("host-wrapper.sh")
        .to_string_lossy()
        .to_string();

    let manifest_content = build_nm_manifest(&host_wrapper);
    let manifest_filename = format!("{NM_HOST_NAME}.json");

    let browsers = detect_chromium_browsers();
    let mut written = 0;

    for browser in &browsers {
        let nm_dir = PathBuf::from(&browser.nm_host_dir);
        let manifest_path = nm_dir.join(&manifest_filename);

        // Skip if manifest already exists and content matches
        if manifest_path.exists() {
            if let Ok(existing) = fs::read_to_string(&manifest_path) {
                if existing.trim() == manifest_content.trim() {
                    written += 1;
                    continue;
                }
            }
        }

        // Create directory if needed
        if let Err(e) = fs::create_dir_all(&nm_dir) {
            println!(
                "[browser-ext] Failed to create {}: {e}",
                nm_dir.display()
            );
            continue;
        }

        // Write manifest
        match fs::write(&manifest_path, &manifest_content) {
            Ok(_) => {
                println!(
                    "[browser-ext] Registered NM host for {} at {}",
                    browser.name,
                    manifest_path.display()
                );
                written += 1;
            }
            Err(e) => {
                println!(
                    "[browser-ext] Failed to write {}: {e}",
                    manifest_path.display()
                );
            }
        }
    }

    Ok(written)
}

/// Check whether the host wrapper script exists (prerequisite for native messaging).
pub fn is_host_installed() -> bool {
    let home = match home_dir() {
        Some(h) => h,
        None => return false,
    };
    home.join(".opencode-browser")
        .join("host-wrapper.sh")
        .exists()
}

/// Return the Chrome Web Store install URL.
pub fn cws_install_url() -> String {
    format!(
        "https://chromewebstore.google.com/detail/{}",
        CWS_EXTENSION_ID
    )
}
```

**Step 2: Verify it compiles**

Run: `cd "packages/desktop/src-tauri" && cargo check 2>&1 | head -20`
Expected: Compiles with no errors (may have warnings about unused functions — that's fine at this stage).

**Step 3: Commit**

```bash
git add packages/desktop/src-tauri/src/browser_extension.rs
git commit -m "feat(desktop): add browser detection and NM host registration module"
```

---

### Task 2: Tauri Commands for Browser Extension

**Files:**
- Create: `packages/desktop/src-tauri/src/commands/browser_extension.rs`
- Modify: `packages/desktop/src-tauri/src/commands/mod.rs:13` (add module declaration)

**Step 1: Create the Tauri commands module**

```rust
// packages/desktop/src-tauri/src/commands/browser_extension.rs

use crate::browser_extension;

#[derive(serde::Serialize)]
pub struct BrowserExtensionSetupInfo {
    pub browsers: Vec<browser_extension::DetectedBrowser>,
    pub host_installed: bool,
    pub cws_url: String,
}

/// Returns detected browsers, host status, and CWS URL for the frontend setup flow.
#[tauri::command]
pub fn browser_extension_detect() -> BrowserExtensionSetupInfo {
    BrowserExtensionSetupInfo {
        browsers: browser_extension::detect_chromium_browsers(),
        host_installed: browser_extension::is_host_installed(),
        cws_url: browser_extension::cws_install_url(),
    }
}

/// Run the npm installer to set up the native host and register NM manifests.
/// This is idempotent — safe to call multiple times.
#[tauri::command]
pub async fn browser_extension_install(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_shell::ShellExt;

    // Run the npm installer to set up ~/.opencode-browser/ (host wrapper, native-host.cjs, etc.)
    let output = app
        .shell()
        .command("npx")
        .args(["@different-ai/opencode-browser@latest", "install"])
        .output()
        .await
        .map_err(|e| format!("Failed to run installer: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Installer failed: {stderr}"));
    }

    // After npm installer runs, also register NM hosts for all detected browsers
    // (the npm installer may have done this too, but we ensure it's up to date)
    let count = browser_extension::register_native_messaging_hosts()?;

    Ok(format!("Installed. NM hosts registered for {count} browser(s)."))
}
```

**Step 2: Add module declaration**

In `packages/desktop/src-tauri/src/commands/mod.rs`, add at the end (after line 13):

```rust
pub mod browser_extension;
```

**Step 3: Verify it compiles**

Run: `cd "packages/desktop/src-tauri" && cargo check 2>&1 | head -20`
Expected: Compiles with no errors.

**Step 4: Commit**

```bash
git add packages/desktop/src-tauri/src/commands/browser_extension.rs packages/desktop/src-tauri/src/commands/mod.rs
git commit -m "feat(desktop): add Tauri commands for browser extension setup"
```

---

### Task 3: Wire Commands in lib.rs

**Files:**
- Modify: `packages/desktop/src-tauri/src/lib.rs:19-53` (add imports)
- Modify: `packages/desktop/src-tauri/src/lib.rs:95-154` (add to handler)
- Modify: `packages/desktop/src-tauri/src/lib.rs:1` (add module declaration)

**Step 1: Add module declaration and imports**

In `packages/desktop/src-tauri/src/lib.rs`:

1. Add module declaration. The file already has `mod workspace;` on line 15. The new module needs to be added:

   After line 15 (`mod workspace;`), this is not a module — `browser_extension` lives inside `commands/`. No top-level `mod` needed, just the import.

   Add import after line 53 (after `use workspace::watch::WorkspaceWatchState;`):

   ```rust
   use commands::browser_extension::{browser_extension_detect, browser_extension_install};
   ```

2. Add the two commands to the `generate_handler!` macro. After line 153 (`set_window_decorations`), add:

   ```rust
   browser_extension_detect,
   browser_extension_install
   ```

   (Don't forget to add a comma after `set_window_decorations` on line 153.)

**Step 2: Verify it compiles**

Run: `cd "packages/desktop/src-tauri" && cargo check 2>&1 | head -20`
Expected: Compiles successfully.

**Step 3: Commit**

```bash
git add packages/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): register browser extension Tauri commands"
```

---

### Task 4: Auto-Run Installer During Workspace Bootstrap

**Files:**
- Modify: `packages/desktop/src-tauri/src/workspace/files.rs:346-501` (add NM registration call)

**Step 1: Add NM host registration to ensure_workspace_files**

At the end of `ensure_workspace_files()`, just before the final `Ok(())` on line 500, add:

```rust
    // Best-effort: register native messaging hosts for all detected browsers.
    // This ensures the browser extension can connect even before the user explicitly
    // runs the npm installer (the NM manifest only needs the host name and allowed_origins).
    if let Err(e) = crate::browser_extension::register_native_messaging_hosts() {
        println!("[workspace] NM host registration skipped: {e}");
    }
```

This is best-effort: if the host wrapper script doesn't exist yet, the manifest will point to a non-existent path, but that's fine — it'll be overwritten when the full installer runs. The important thing is that the manifest directory structure is created.

**Step 2: Verify it compiles**

Run: `cd "packages/desktop/src-tauri" && cargo check 2>&1 | head -20`
Expected: Compiles successfully.

**Step 3: Commit**

```bash
git add packages/desktop/src-tauri/src/workspace/files.rs
git commit -m "feat(desktop): register NM hosts during workspace bootstrap"
```

---

### Task 5: Frontend Tauri Bindings

**Files:**
- Modify: `packages/app/src/app/lib/tauri.ts` (add invoke wrappers at the end of file)

**Step 1: Add TypeScript types and invoke wrappers**

Append to the end of `packages/app/src/app/lib/tauri.ts`:

```typescript
// --- Browser extension ---

export type DetectedBrowser = {
  name: string;
  nmHostDir: string;
};

export type BrowserExtensionSetupInfo = {
  browsers: DetectedBrowser[];
  hostInstalled: boolean;
  cwsUrl: string;
};

export async function browserExtensionDetect(): Promise<BrowserExtensionSetupInfo> {
  return invoke<BrowserExtensionSetupInfo>("browser_extension_detect");
}

export async function browserExtensionInstall(): Promise<string> {
  return invoke<string>("browser_extension_install");
}
```

**Step 2: Commit**

```bash
git add packages/app/src/app/lib/tauri.ts
git commit -m "feat(app): add browser extension Tauri bindings"
```

---

### Task 6: Frontend — Modified Browser Setup Flow

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx:2955-2983` (rewrite `handleBrowserAutomationQuickstart`)
- Modify: `packages/app/src/app/pages/session.tsx:302-343` (add state signals)
- Modify: `packages/app/src/app/pages/session.tsx:3696-3736` (update empty state UI)

**Context:**
- `isTauriRuntime()` is already imported at line 83
- `@tauri-apps/plugin-opener` is used elsewhere via dynamic import: `import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url))`
- Tauri bindings are in `../lib/tauri`
- Existing signals pattern: `const [toastMessage, setToastMessage] = createSignal<string | null>(null);`
- Polling cleanup pattern: `onCleanup(() => { window.clearInterval(interval); })`

**Step 1: Add state signals for browser extension setup**

In `packages/app/src/app/pages/session.tsx`, near the existing signals block (around line 302-343), add:

```typescript
// Browser extension setup state
type BrowserSetupStep = "idle" | "detecting" | "picking" | "installing" | "waiting" | "success" | "error";
const [browserSetupStep, setBrowserSetupStep] = createSignal<BrowserSetupStep>("idle");
const [detectedBrowsers, setDetectedBrowsers] = createSignal<{ name: string; nmHostDir: string }[]>([]);
const [browserSetupCwsUrl, setBrowserSetupCwsUrl] = createSignal<string>("");
const [browserSetupError, setBrowserSetupError] = createSignal<string | null>(null);
```

**Step 2: Add the import for the Tauri bindings**

Add to the imports from `../lib/tauri` (find the existing import block):

```typescript
import { browserExtensionDetect, browserExtensionInstall } from "../lib/tauri";
```

**Step 3: Rewrite handleBrowserAutomationQuickstart**

Replace the function at lines 2955-2983 with:

```typescript
const handleBrowserAutomationQuickstart = async () => {
  if (!isTauriRuntime()) {
    // Web app: fall back to LLM-guided setup
    const text = BROWSER_SETUP_TEMPLATE.body || "Help me set up browser automation.";
    handleSendPrompt({
      mode: "prompt",
      text,
      resolvedText: text,
      parts: [{ type: "text", text }],
      attachments: [],
    });
    return;
  }

  setBrowserSetupStep("detecting");
  setBrowserSetupError(null);

  try {
    // Step 1: Run the npm installer (idempotent — sets up host wrapper + NM manifests)
    await browserExtensionInstall();

    // Step 2: Detect browsers
    const info = await browserExtensionDetect();
    setBrowserSetupCwsUrl(info.cwsUrl);

    if (info.browsers.length === 0) {
      setBrowserSetupStep("error");
      setBrowserSetupError("No supported browser found. Install Chrome, Edge, or Brave first.");
      return;
    }

    if (info.browsers.length === 1) {
      // Single browser — skip picker, go straight to CWS
      await openCwsInBrowser(info.cwsUrl);
      setBrowserSetupStep("waiting");
    } else {
      // Multiple browsers — show picker
      setDetectedBrowsers(info.browsers);
      setBrowserSetupStep("picking");
    }
  } catch (e) {
    setBrowserSetupStep("error");
    setBrowserSetupError(String(e));
  }
};

const openCwsInBrowser = async (url: string) => {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
};

const handleBrowserPick = async (browserName: string) => {
  setBrowserSetupStep("waiting");
  await openCwsInBrowser(browserSetupCwsUrl());
};

const handleBrowserSetupDone = () => {
  setBrowserSetupStep("success");
  // After a short delay, offer to try the first task via LLM
  setTimeout(() => {
    const text = "I've set up the browser extension. Let's try opening a webpage to test it.";
    handleSendPrompt({
      mode: "prompt",
      text,
      resolvedText: text,
      parts: [{ type: "text", text }],
      attachments: [],
    });
    setBrowserSetupStep("idle");
  }, 1500);
};

const handleBrowserSetupFallback = () => {
  setBrowserSetupStep("idle");
  const text = BROWSER_SETUP_TEMPLATE.body || "Help me set up browser automation.";
  handleSendPrompt({
    mode: "prompt",
    text,
    resolvedText: text,
    parts: [{ type: "text", text }],
    attachments: [],
  });
};
```

**Step 4: Update the empty state UI**

Replace lines 3696-3736 (the `<Show when={props.messages.length === 0 && ...}>` block) with:

```tsx
<Show when={props.messages.length === 0 && !showWorkspaceSetupEmptyState()}>
  <div class="text-center py-16 px-6 space-y-6">
    <div class="w-16 h-16 bg-dls-hover rounded-3xl mx-auto flex items-center justify-center border border-dls-border">
      <Zap class="text-dls-secondary" />
    </div>
    <div class="space-y-2">
      <h3 class="text-xl font-medium">What do you want to do?</h3>
      <p class="text-dls-secondary text-sm max-w-sm mx-auto">
        Pick a starting point or just type below.
      </p>
    </div>

    {/* Browser extension setup inline flow */}
    <Show when={browserSetupStep() === "picking"}>
      <div class="max-w-md mx-auto rounded-2xl border border-dls-border bg-dls-hover p-4 space-y-3 text-left">
        <div class="text-sm font-semibold text-dls-text">Which browser do you use?</div>
        <div class="space-y-2">
          <For each={detectedBrowsers()}>
            {(browser) => (
              <button
                type="button"
                class="w-full rounded-xl border border-dls-border bg-dls-surface p-3 text-sm text-dls-text hover:bg-dls-active transition-all text-left"
                onClick={() => void handleBrowserPick(browser.name)}
              >
                {browser.name}
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>

    <Show when={browserSetupStep() === "detecting" || browserSetupStep() === "installing"}>
      <div class="max-w-md mx-auto rounded-2xl border border-dls-border bg-dls-hover p-4 text-sm text-dls-secondary">
        Setting up browser automation...
      </div>
    </Show>

    <Show when={browserSetupStep() === "waiting"}>
      <div class="max-w-md mx-auto rounded-2xl border border-dls-border bg-dls-hover p-4 space-y-3">
        <div class="text-sm text-dls-text">
          Click <span class="font-semibold">"Add to Chrome"</span> in the store page that just opened.
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            class="rounded-xl border border-dls-border bg-dls-surface px-3 py-2 text-xs text-dls-text hover:bg-dls-active transition-all"
            onClick={() => void handleBrowserSetupDone()}
          >
            I've installed it
          </button>
          <button
            type="button"
            class="rounded-xl px-3 py-2 text-xs text-dls-secondary hover:text-dls-text transition-all"
            onClick={() => void handleBrowserSetupFallback()}
          >
            Need help
          </button>
        </div>
      </div>
    </Show>

    <Show when={browserSetupStep() === "success"}>
      <div class="max-w-md mx-auto rounded-2xl border border-green-7 bg-green-2 p-4 text-sm text-green-11">
        Browser extension connected! Starting your first task...
      </div>
    </Show>

    <Show when={browserSetupStep() === "error"}>
      <div class="max-w-md mx-auto rounded-2xl border border-red-7 bg-red-2 p-4 space-y-2">
        <div class="text-sm text-red-11">{browserSetupError()}</div>
        <button
          type="button"
          class="rounded-xl px-3 py-2 text-xs text-red-11 hover:bg-red-3 transition-all"
          onClick={() => void handleBrowserSetupFallback()}
        >
          Try manual setup
        </button>
      </div>
    </Show>

    {/* Quick action buttons (show when not in setup flow) */}
    <Show when={browserSetupStep() === "idle"}>
      <div class="grid gap-3 sm:grid-cols-2 max-w-2xl mx-auto text-left">
        <button
          type="button"
          class="rounded-2xl border border-dls-border bg-dls-hover p-4 transition-all hover:bg-dls-active hover:border-gray-7"
          onClick={() => {
            void handleBrowserAutomationQuickstart();
          }}
        >
          <div class="text-sm font-semibold text-dls-text">Automate your browser</div>
          <div class="mt-1 text-xs text-dls-secondary leading-relaxed">
            Set up browser actions and run reliable web tasks from OpenWork.
          </div>
        </button>
        <button
          type="button"
          class="rounded-2xl border border-dls-border bg-dls-hover p-4 transition-all hover:bg-dls-active hover:border-gray-7"
          onClick={() => {
            void handleSoulQuickstart();
          }}
        >
          <div class="text-sm font-semibold text-dls-text">Give me a soul</div>
          <div class="mt-1 text-xs text-dls-secondary leading-relaxed">
            Keep your goals and preferences across sessions with light scheduled check-ins.
            Tradeoff: more autonomy can create extra background runs, but revert is one command.
            Audit setup and heartbeat evidence from the Soul section.
          </div>
        </button>
      </div>
    </Show>
  </div>
</Show>
```

**Step 5: Verify the app builds**

Run: `cd "packages/app" && npx tsc --noEmit 2>&1 | head -30`
Expected: No type errors related to our changes.

**Step 6: Commit**

```bash
git add packages/app/src/app/pages/session.tsx packages/app/src/app/lib/tauri.ts
git commit -m "feat(app): browser extension auto-install flow with CWS deep link"
```

---

### Task 7: Update Browser Setup Skill

**Files:**
- Modify: `.opencode/skills/browser-setup-devtools/SKILL.md`

**Step 1: Update the fallback section to mention CWS**

In `.opencode/skills/browser-setup-devtools/SKILL.md`, update step 6 (the fallback section, lines 33-41). Replace:

```markdown
6. Fallback only if DevTools MCP cannot be used:
   - Check availability with `browser_version` or `browser_status`.
   - If missing, run `npx @different-ai/opencode-browser install` yourself.
   - Open the Extensions page yourself when possible:
     - macOS: `open -a "Google Chrome" "chrome://extensions"`
     - Windows: `start chrome://extensions`
     - Linux: `xdg-open "chrome://extensions"`
   - Tell the user to enable Developer mode, click "Load unpacked", and select `~/.opencode-browser/extension`, then pin the extension.
   - Re-check availability with `browser_version`.
   - Offer a first task and use `browser_open_tab`.
```

With:

```markdown
6. Fallback only if DevTools MCP cannot be used:
   - Check availability with `browser_version` or `browser_status`.
   - If missing, guide the user to install from the Chrome Web Store:
     - The desktop app's "Automate your browser" button handles this automatically.
     - If the user is not using the desktop app, provide the CWS install link.
     - As a last resort, run `npx @different-ai/opencode-browser install` and guide manual load.
   - Re-check availability with `browser_version`.
   - Offer a first task and use `browser_open_tab`.
```

**Step 2: Commit**

```bash
git add .opencode/skills/browser-setup-devtools/SKILL.md
git commit -m "docs: update browser setup skill to reference CWS install path"
```

---

### Task 8: Manual Testing Checklist

This task is not code — it's a verification checklist to run through after all code tasks are complete.

**On macOS (primary):**

1. **Build the desktop app:**
   ```bash
   cd packages/desktop && pnpm tauri dev
   ```

2. **Create a new workspace with "starter" preset**
   - Verify `NativeMessagingHosts/com.opencode.browser_automation.json` was created in:
     - `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (if Chrome installed)
     - Similar for Edge/Brave if installed
   - Verify the manifest JSON has correct structure

3. **Click "Automate your browser" in empty chat state:**
   - Should show "Setting up browser automation..." briefly
   - Then either show browser picker (if multiple browsers) or open CWS directly
   - After CWS opens, should show "Click 'Add to Chrome'" with "I've installed it" button

4. **Click "I've installed it":**
   - Should show success message
   - Should auto-send a test prompt

5. **Click "Need help":**
   - Should fall back to LLM-guided setup

6. **Error case — no browsers:**
   - Temporarily rename Chrome data dir and test
   - Should show "No supported browser found"

7. **Web app fallback:**
   - Open the app in a browser (not Tauri)
   - Click "Automate your browser"
   - Should immediately send the LLM-guided prompt (no Tauri commands)

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `packages/desktop/src-tauri/src/browser_extension.rs` | Browser detection, NM host registration |
| `packages/desktop/src-tauri/src/commands/browser_extension.rs` | Tauri commands |
| `packages/desktop/src-tauri/src/commands/mod.rs` | Module declaration |
| `packages/desktop/src-tauri/src/lib.rs` | Command registration |
| `packages/desktop/src-tauri/src/workspace/files.rs` | Workspace bootstrap integration |
| `packages/app/src/app/lib/tauri.ts` | Frontend Tauri bindings |
| `packages/app/src/app/pages/session.tsx` | UI flow (button, picker, status) |
| `.opencode/skills/browser-setup-devtools/SKILL.md` | Skill docs update |
