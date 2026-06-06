# VSLO-184 Windows Sidecar Console Suppression Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop Veslo-owned OpenCode, Veslo server, Veslo orchestrator, and OpenCode router sidecars from opening visible Windows console windows during first launch, relaunch, and idle restart.

**Architecture:** Add an explicit desktop-side supervised process contract for local backend sidecars. On Windows, supervised launches must use `CREATE_NO_WINDOW` even when resolving bundled sidecars or fallback commands; on other platforms keep the existing runtime semantics. Preserve child PID, kill, stdout/stderr, termination events, debug-log forwarding, and health checks.

**Tech Stack:** Rust/Tauri desktop runtime, `std::process::Command`, Windows `CommandExt::creation_flags`, Tauri async channels, existing WebdriverIO desktop E2E, YouTrack CLI.

---

## Preconditions

- Use the real Tauri desktop runtime for behavioral verification.
- Do not use `packages/web`, raw Vite, or UI-only dev servers as proof.
- Before any desktop runtime/E2E launch, run the desktop test preflight from `docs/dev/testing-playbook.md`.
- Use @test-driven-development before implementation, @systematic-debugging if the Windows probe still shows visible windows, and @verification-before-completion before claiming done.
- Keep existing unrelated worktree changes untouched.

## Task 1: Add A Failing Hidden Sidecar Contract Test

**Files:**
- Create: `packages/desktop/windows-hidden-sidecar-contract.test.mjs`

**Step 1: Write the failing test**

Create a source-level Node test that encodes the intended desktop contract before changing Rust code.

```js
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const desktopRoot = import.meta.dirname;

function readDesktopFile(relativePath) {
  return readFileSync(resolve(desktopRoot, relativePath), "utf8");
}

test("desktop defines a supervised hidden sidecar process contract", () => {
  const path = resolve(desktopRoot, "src-tauri/src/supervised_process.rs");
  assert.equal(existsSync(path), true, "supervised_process.rs should centralize sidecar launching");

  const source = readFileSync(path, "utf8");
  assert.match(source, /CREATE_NO_WINDOW/, "Windows launches must explicitly use CREATE_NO_WINDOW");
  assert.match(source, /SupervisedCommandChild/, "child handles must be normalized for managers");
  assert.match(source, /SupervisedCommandEvent/, "stdout/stderr/termination events must be normalized");
  assert.match(source, /supervised_sidecar/, "bundled sidecars must use the supervised launcher");
  assert.match(source, /supervised_command/, "fallback commands must use the supervised launcher");
});

test("all supervised backend sidecar starts go through the hidden contract", () => {
  const files = [
    "src-tauri/src/engine/spawn.rs",
    "src-tauri/src/veslo_server/spawn.rs",
    "src-tauri/src/orchestrator/mod.rs",
    "src-tauri/src/opencode_router/spawn.rs",
  ];

  for (const file of files) {
    const source = readDesktopFile(file);
    assert.match(source, /supervised_process/, `${file} should import the supervised process helper`);
    assert.doesNotMatch(source, /\.shell\(\)\s*\.\s*sidecar\(/, `${file} should not launch sidecars directly`);
    assert.doesNotMatch(source, /\.shell\(\)\s*\.\s*command\(/, `${file} should not launch fallback commands directly`);
  }
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
node --test packages/desktop/windows-hidden-sidecar-contract.test.mjs
```

Expected: FAIL because `src-tauri/src/supervised_process.rs` does not exist yet and current spawn modules call Tauri shell directly.

**Step 3: Commit the failing test only if the team accepts red-green commits**

Default for this repo can be one commit per completed task instead. If committing red tests is not desired, keep this unstaged until Task 4 passes.

## Task 2: Add The Supervised Process Abstraction

**Files:**
- Create: `packages/desktop/src-tauri/src/supervised_process.rs`
- Modify: `packages/desktop/src-tauri/src/lib.rs`

**Step 1: Implement normalized child and event types**

Create `supervised_process.rs` with a platform-aware abstraction. Keep this module small and focused on process launch mechanics.

```rust
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use tauri::async_runtime::{channel, block_on as block_on_task, Receiver, Sender};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone)]
pub enum SupervisedCommandEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Error(String),
    Terminated { code: Option<i32>, signal: Option<i32> },
}

#[derive(Debug)]
pub enum SupervisedCommandChild {
    Shell(CommandChild),
    Native(NativeCommandChild),
}

#[derive(Debug)]
pub struct NativeCommandChild {
    inner: Arc<Mutex<Child>>,
}

impl SupervisedCommandChild {
    pub fn pid(&self) -> u32 {
        match self {
            Self::Shell(child) => child.pid(),
            Self::Native(child) => child.pid(),
        }
    }

    pub fn kill(self) -> Result<(), String> {
        match self {
            Self::Shell(child) => child.kill().map_err(|e| e.to_string()),
            Self::Native(child) => child.kill(),
        }
    }
}

impl NativeCommandChild {
    fn pid(&self) -> u32 {
        self.inner.lock().map(|child| child.id()).unwrap_or(0)
    }

    fn kill(self) -> Result<(), String> {
        let mut child = self.inner.lock().map_err(|_| "native child mutex poisoned".to_string())?;
        child.kill().map_err(|e| e.to_string())
    }
}
```

**Step 2: Add a builder-like command model**

Add a small builder that preserves the current call style: args, env, and current directory are accumulated before spawn.

```rust
pub enum SupervisedProgram {
    Sidecar(String),
    Command(OsString),
}

pub struct SupervisedCommand {
    app: AppHandle,
    program: SupervisedProgram,
    args: Vec<OsString>,
    envs: Vec<(OsString, OsString)>,
    current_dir: Option<PathBuf>,
}

pub fn supervised_sidecar(app: &AppHandle, name: &str) -> SupervisedCommand {
    SupervisedCommand {
        app: app.clone(),
        program: SupervisedProgram::Sidecar(name.to_string()),
        args: Vec::new(),
        envs: Vec::new(),
        current_dir: None,
    }
}

pub fn supervised_command<S: AsRef<OsStr>>(app: &AppHandle, program: S) -> SupervisedCommand {
    SupervisedCommand {
        app: app.clone(),
        program: SupervisedProgram::Command(program.as_ref().to_os_string()),
        args: Vec::new(),
        envs: Vec::new(),
        current_dir: None,
    }
}

impl SupervisedCommand {
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args.extend(args.into_iter().map(|arg| arg.as_ref().to_os_string()));
        self
    }

    pub fn env<K, V>(mut self, key: K, value: V) -> Self
    where
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        self.envs.push((key.as_ref().to_os_string(), value.as_ref().to_os_string()));
        self
    }

    pub fn current_dir<P: AsRef<Path>>(mut self, dir: P) -> Self {
        self.current_dir = Some(dir.as_ref().to_path_buf());
        self
    }

    pub fn spawn(self) -> Result<(Receiver<SupervisedCommandEvent>, SupervisedCommandChild), String> {
        #[cfg(windows)]
        {
            return self.spawn_native_hidden();
        }

        #[cfg(not(windows))]
        {
            return self.spawn_tauri_shell();
        }
    }
}
```

**Step 3: Implement non-Windows via existing Tauri shell**

Convert Tauri `CommandEvent` into `SupervisedCommandEvent`.

```rust
#[cfg(not(windows))]
impl SupervisedCommand {
    fn spawn_tauri_shell(self) -> Result<(Receiver<SupervisedCommandEvent>, SupervisedCommandChild), String> {
        let mut command = match &self.program {
            SupervisedProgram::Sidecar(name) => self
                .app
                .shell()
                .sidecar(name)
                .map_err(|e| format!("Failed to locate bundled sidecar {name}: {e}"))?,
            SupervisedProgram::Command(program) => self.app.shell().command(program),
        };

        command = command.args(self.args);
        if let Some(current_dir) = self.current_dir {
            command = command.current_dir(current_dir);
        }
        for (key, value) in self.envs {
            command = command.env(key, value);
        }

        let (mut shell_rx, child) = command.spawn().map_err(|e| e.to_string())?;
        let (tx, rx) = channel(1);
        tauri::async_runtime::spawn(async move {
            while let Some(event) = shell_rx.recv().await {
                let mapped = match event {
                    CommandEvent::Stdout(bytes) => SupervisedCommandEvent::Stdout(bytes),
                    CommandEvent::Stderr(bytes) => SupervisedCommandEvent::Stderr(bytes),
                    CommandEvent::Error(message) => SupervisedCommandEvent::Error(message),
                    CommandEvent::Terminated(payload) => SupervisedCommandEvent::Terminated {
                        code: payload.code,
                        signal: payload.signal,
                    },
                    _ => continue,
                };
                let _ = tx.send(mapped).await;
            }
        });

        Ok((rx, SupervisedCommandChild::Shell(child)))
    }
}
```

**Step 4: Implement Windows native hidden spawn**

Use `std::process::Command` with `CREATE_NO_WINDOW`. Resolve bundled sidecars from the current binary directory, resource sidecar directory, and `src-tauri/sidecars`.

```rust
#[cfg(windows)]
impl SupervisedCommand {
    fn spawn_native_hidden(self) -> Result<(Receiver<SupervisedCommandEvent>, SupervisedCommandChild), String> {
        let program = match &self.program {
            SupervisedProgram::Sidecar(name) => resolve_sidecar_path(&self.app, name)
                .ok_or_else(|| format!("Failed to locate bundled sidecar {name}"))?
                .into_os_string(),
            SupervisedProgram::Command(program) => program.clone(),
        };

        let mut command = StdCommand::new(program);
        command.args(self.args);
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.creation_flags(CREATE_NO_WINDOW);

        if let Some(current_dir) = self.current_dir {
            command.current_dir(current_dir);
        }
        for (key, value) in self.envs {
            command.env(key, value);
        }

        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let child = Arc::new(Mutex::new(child));
        let wait_child = child.clone();
        let (tx, rx) = channel(1);

        spawn_reader(stdout, tx.clone(), SupervisedCommandEvent::Stdout);
        spawn_reader(stderr, tx.clone(), SupervisedCommandEvent::Stderr);
        thread::spawn(move || {
            let result = wait_child
                .lock()
                .map_err(|_| "native child mutex poisoned".to_string())
                .and_then(|mut child| child.wait().map_err(|e| e.to_string()));

            let event = match result {
                Ok(status) => SupervisedCommandEvent::Terminated { code: status.code(), signal: None },
                Err(error) => SupervisedCommandEvent::Error(error),
            };
            let _ = block_on_task(async move { tx.send(event).await });
        });

        Ok((rx, SupervisedCommandChild::Native(NativeCommandChild { inner: child })))
    }
}
```

**Step 5: Add sidecar resolution and pipe readers**

Implement helpers in the same module. Try canonical and `.exe` names; include target-suffixed names if the package has them.

```rust
#[cfg(windows)]
fn resolve_sidecar_path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok();
    let current_bin_dir = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
    let dirs = crate::paths::sidecar_path_candidates(resource_dir.as_deref(), current_bin_dir.as_deref());

    let names = [
        format!("{name}.exe"),
        name.to_string(),
    ];

    for dir in dirs {
        for candidate_name in &names {
            let candidate = dir.join(candidate_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(windows)]
fn spawn_reader(
    pipe: Option<impl std::io::Read + Send + 'static>,
    tx: Sender<SupervisedCommandEvent>,
    wrap: fn(Vec<u8>) -> SupervisedCommandEvent,
) {
    thread::spawn(move || {
        let Some(pipe) = pipe else {
            return;
        };
        let reader = BufReader::new(pipe);
        for line in reader.split(b'\n') {
            match line {
                Ok(bytes) => {
                    let _ = block_on_task(async { tx.send(wrap(bytes)).await });
                }
                Err(error) => {
                    let _ = block_on_task(async {
                        tx.send(SupervisedCommandEvent::Error(error.to_string())).await
                    });
                    break;
                }
            }
        }
    });
}
```

**Step 6: Register the module**

Modify `packages/desktop/src-tauri/src/lib.rs`:

```rust
mod supervised_process;
```

**Step 7: Build**

Run:

```bash
pnpm --filter @neatech/veslo exec cargo build --manifest-path src-tauri/Cargo.toml --no-default-features
```

Expected: build errors are likely until Task 3 migrates type usage. Do not commit yet unless the module compiles independently.

## Task 3: Update Process Supervision Types

**Files:**
- Modify: `packages/desktop/src-tauri/src/process_supervisor.rs`
- Modify: `packages/desktop/src-tauri/src/engine/manager.rs`
- Modify: `packages/desktop/src-tauri/src/veslo_server/manager.rs`
- Modify: `packages/desktop/src-tauri/src/orchestrator/manager.rs`
- Modify: `packages/desktop/src-tauri/src/opencode_router/manager.rs`

**Step 1: Replace child type in managers**

Change manager state fields from Tauri `CommandChild` to `SupervisedCommandChild`.

Example:

```rust
use crate::supervised_process::SupervisedCommandChild;

pub struct EngineState {
    pub child: Option<SupervisedCommandChild>,
    // keep existing fields
}
```

Do this for engine, Veslo server, orchestrator, and OpenCode router state.

**Step 2: Update generic supervisor trait**

In `process_supervisor.rs`, replace imports and trait signatures:

```rust
use crate::supervised_process::{SupervisedCommandChild, SupervisedCommandEvent};

pub trait SupervisedChild {
    fn child(&self) -> &Option<SupervisedCommandChild>;
    fn take_child(&mut self) -> Option<SupervisedCommandChild>;
    // keep existing methods
}
```

Update `spawn_output_collector_with_forwarder` to match on `SupervisedCommandEvent`:

```rust
match event {
    SupervisedCommandEvent::Stdout(line_bytes) => { /* existing stdout body */ }
    SupervisedCommandEvent::Stderr(line_bytes) => { /* existing stderr body */ }
    SupervisedCommandEvent::Terminated { code, .. } => { /* existing terminated body */ }
    SupervisedCommandEvent::Error(message) => { /* existing error body */ }
}
```

**Step 3: Update manager stop/snapshot code**

Every call site using `child.pid()` and `child.kill()` should keep the same shape because `SupervisedCommandChild` exposes both methods.

**Step 4: Run focused build**

Run:

```bash
pnpm --filter @neatech/veslo exec cargo build --manifest-path src-tauri/Cargo.toml --no-default-features
```

Expected: Remaining errors point to spawn modules and command loops still using Tauri `CommandEvent`. Fix those in Task 4.

## Task 4: Migrate All Supervised Sidecar Start Paths

**Files:**
- Modify: `packages/desktop/src-tauri/src/engine/spawn.rs`
- Modify: `packages/desktop/src-tauri/src/veslo_server/spawn.rs`
- Modify: `packages/desktop/src-tauri/src/orchestrator/mod.rs`
- Modify: `packages/desktop/src-tauri/src/opencode_router/spawn.rs`
- Modify: `packages/desktop/src-tauri/src/commands/engine.rs`
- Modify: `packages/desktop/src-tauri/src/commands/opencode_router.rs`

**Step 1: Replace direct Tauri shell imports in spawn modules**

Use:

```rust
use crate::supervised_process::{
    supervised_command, supervised_sidecar, SupervisedCommandChild, SupervisedCommandEvent,
};
```

Return:

```rust
Result<(Receiver<SupervisedCommandEvent>, SupervisedCommandChild), String>
```

**Step 2: Migrate OpenCode engine spawn**

Replace direct sidecar/command selection with:

```rust
let command = if use_sidecar {
    supervised_sidecar(app, "opencode")
} else {
    supervised_command(app, program.as_os_str())
};
```

Keep args, cwd, envs, PATH prepending, and auth envs unchanged.

**Step 3: Migrate Veslo server spawn**

Replace:

```rust
app.shell().command("bun")
app.shell().sidecar("veslo-server")
app.shell().command("veslo-server")
```

with:

```rust
supervised_command(app, "bun")
supervised_sidecar(app, "veslo-server")
supervised_command(app, "veslo-server")
```

The dev-watch path is development-only but should still be hidden on Windows.

**Step 4: Migrate orchestrator daemon spawn**

Replace:

```rust
app.shell().sidecar("veslo-orchestrator")
app.shell().command("veslo")
```

with the supervised helper. Keep PATH prepending and env overrides unchanged.

**Step 5: Migrate OpenCode router spawn**

Replace:

```rust
app.shell().sidecar("veslo-code-router")
app.shell().sidecar("opencode-router")
app.shell().command("opencode-router")
```

with supervised helper calls. Keep health port, cwd, auth envs, and Bun env overrides unchanged.

**Step 6: Update command loops that match events**

In `commands/engine.rs` and `commands/opencode_router.rs`, replace `CommandEvent::*` matches with `SupervisedCommandEvent::*`.

Example:

```rust
SupervisedCommandEvent::Stdout(line_bytes) => { /* existing body */ }
SupervisedCommandEvent::Stderr(line_bytes) => { /* existing body */ }
SupervisedCommandEvent::Terminated { code, .. } => { /* existing body */ }
SupervisedCommandEvent::Error(message) => { /* existing body */ }
```

**Step 7: Run the contract test**

Run:

```bash
node --test packages/desktop/windows-hidden-sidecar-contract.test.mjs
```

Expected: PASS.

**Step 8: Run Rust build and tests**

Run:

```bash
pnpm --filter @neatech/veslo exec cargo test --manifest-path src-tauri/Cargo.toml
pnpm --filter @neatech/veslo exec cargo build --manifest-path src-tauri/Cargo.toml --no-default-features
```

Expected: PASS.

**Step 9: Commit**

```bash
git add \
  packages/desktop/windows-hidden-sidecar-contract.test.mjs \
  packages/desktop/src-tauri/src/supervised_process.rs \
  packages/desktop/src-tauri/src/lib.rs \
  packages/desktop/src-tauri/src/process_supervisor.rs \
  packages/desktop/src-tauri/src/engine/manager.rs \
  packages/desktop/src-tauri/src/veslo_server/manager.rs \
  packages/desktop/src-tauri/src/orchestrator/manager.rs \
  packages/desktop/src-tauri/src/opencode_router/manager.rs \
  packages/desktop/src-tauri/src/engine/spawn.rs \
  packages/desktop/src-tauri/src/veslo_server/spawn.rs \
  packages/desktop/src-tauri/src/orchestrator/mod.rs \
  packages/desktop/src-tauri/src/opencode_router/spawn.rs \
  packages/desktop/src-tauri/src/commands/engine.rs \
  packages/desktop/src-tauri/src/commands/opencode_router.rs
git commit -m "fix(desktop): hide Windows sidecar console launches"
```

## Task 5: Extend The Windows First-Run Probe

**Files:**
- Modify: `packages/e2e/windows-veslo-runtime-probe.mjs`
- Optionally modify: `packages/e2e/helpers/app-launcher.ts`

**Step 1: Add a visible window probe**

Add a Windows-only helper that uses PowerShell with `windowsHide: true` to list visible Veslo/OpenCode process windows.

```js
import { execFileSync } from "node:child_process";

function probeVisibleSidecarWindows() {
  if (process.platform !== "win32") {
    return { skipped: true, reason: "not-windows" };
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$items = Get-Process | Where-Object {",
    "  $_.MainWindowTitle -and ($_.ProcessName -match 'veslo|opencode')",
    "} | Select-Object Id,ProcessName,MainWindowTitle",
    "$items | ConvertTo-Json -Compress",
  ].join("; ");

  const raw = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();

  if (!raw) return { skipped: false, windows: [] };
  const parsed = JSON.parse(raw);
  return { skipped: false, windows: Array.isArray(parsed) ? parsed : [parsed] };
}
```

**Step 2: Include the result in probe output**

Add:

```js
const visibleSidecarWindows = probeVisibleSidecarWindows();
```

and include it in the final JSON payload:

```js
visibleSidecarWindows,
```

**Step 3: Make visible sidecar windows fail the probe on Windows**

After collecting output, add:

```js
if (
  process.platform === "win32" &&
  visibleSidecarWindows &&
  !visibleSidecarWindows.skipped &&
  visibleSidecarWindows.windows.length > 0
) {
  process.exitCode = 1;
}
```

**Step 4: Run helper tests if changed**

Run:

```bash
node --test packages/e2e/helpers/app-launcher.test.ts
```

Expected: PASS if `app-launcher.ts` changed. Skip this command if only the standalone probe changed and no existing test covers it.

**Step 5: Commit**

```bash
git add packages/e2e/windows-veslo-runtime-probe.mjs packages/e2e/helpers/app-launcher.ts
git commit -m "test(e2e): report visible Windows sidecar windows"
```

## Task 6: Update Canonical Runtime Docs

**Files:**
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/dev/testing-playbook.md`

**Step 1: Document hidden sidecar launch behavior**

Add a short section to `docs/dev/state-and-config-reference.md` near the sidecar/debug-log material:

```markdown
### Windows sidecar console suppression

On Windows, supervised local backend processes are launched through the desktop hidden sidecar contract. OpenCode, Veslo server, Veslo orchestrator, and OpenCode router must not create visible console windows during first launch, relaunch, idle restart, or fallback command startup. Their stdout/stderr remains available through the desktop debug-log pipeline.

Antivirus, SmartScreen, AVG, Avast, and similar reputation prompts are separate from Veslo terminal windows. Veslo can reduce those prompts through signing, stable publisher identity, bundled binaries, and vendor submission, but it cannot fully suppress vendor-owned security UI.
```

**Step 2: Document Windows verification**

Add to the desktop runtime verification section in `docs/dev/testing-playbook.md`:

```markdown
For `VSLO-184` or Windows sidecar launch changes, run a Windows clean-profile first-run probe after the normal Tauri E2E build. Confirm that `visibleSidecarWindows.windows` is empty. If antivirus or SmartScreen prompts appear, record them separately from terminal-window behavior.
```

**Step 3: Commit**

```bash
git add docs/dev/state-and-config-reference.md docs/dev/testing-playbook.md
git commit -m "docs: document Windows sidecar launch verification"
```

## Task 7: Verify In The Real Desktop Runtime

**Files:**
- No new files.

**Step 1: Run non-desktop checks**

Run:

```bash
node --test packages/desktop/windows-hidden-sidecar-contract.test.mjs
pnpm --filter @neatech/veslo exec cargo test --manifest-path src-tauri/Cargo.toml
pnpm --filter @neatech/veslo exec cargo build --manifest-path src-tauri/Cargo.toml --no-default-features
```

Expected: PASS.

**Step 2: Run desktop preflight**

Run from repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Expected: post-check is empty. If a user-owned production app is running, stop and ask for direction instead of killing it.

**Step 3: Build the E2E desktop binary**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e
```

Expected: debug desktop binary exists under `packages/desktop/src-tauri/target/debug/`.

**Step 4: Run targeted E2E startup spec**

Run:

```bash
cd packages/e2e
pnpm test --spec ./specs/veslo-server-startup.spec.ts
```

Expected: PASS. The app starts Veslo server, OpenCode, orchestrator, and router in the real Tauri runtime.

**Step 5: Run Windows first-run probe on a Windows machine**

Run from repo root after building the E2E desktop binary:

```bash
node --import=tsx/esm packages/e2e/windows-veslo-runtime-probe.mjs
```

Expected on Windows:

- Veslo server health is OK.
- Capabilities request is OK.
- `visibleSidecarWindows.windows` is `[]`.
- No OpenCode or Veslo server console windows are visible during first launch.

If this cannot be run on the current machine, report it as a verification gap and request Windows verification before marking `VSLO-184` accepted.

## Task 8: Prepare The YouTrack Handoff Comment

**Files:**
- No repo file required.

**Step 1: Wait for the user's explicit handoff instruction**

Do not comment in YouTrack immediately after implementation. Wait until the user says the implementation is done and users should test it.

**Step 2: Add a concise comment to `VSLO-184`**

Use this text:

```text
Hotovo k otestování.

Zjednodušeně: na Windows jsme upravili spouštění lokálních backendů Vesla tak, aby OpenCode / Veslo server / související pomocné procesy neotevíraly viditelná terminálová okna.

Prosím ověřit:
- první instalaci a první spuštění na Windows,
- běžné opětovné spuštění aplikace,
- idle stav, jestli už neproblikává terminálové okno.

Poznámka: AVG/Avast/SmartScreen kontrola se může zobrazit dál. To je reputační kontrola antiviru/Windows nad novými .exe soubory, ne terminálové okno spuštěné Veslem.
```

Dry run:

```bash
node /Users/vaclavsoukup/.codex/skills/youtrack/scripts/yt.mjs issue comment VSLO-184 --text "<comment text>"
```

Apply only after the user explicitly asks to write it:

```bash
node /Users/vaclavsoukup/.codex/skills/youtrack/scripts/yt.mjs issue comment VSLO-184 --text "<comment text>" --apply
```

Expected: YouTrack comment appears under `VSLO-184`.

## Completion Criteria

- All supervised local backend launches use the hidden launch contract.
- Existing process supervision still reports PID, kill, stdout/stderr, and termination.
- Real desktop E2E startup still passes.
- Windows first-run probe shows no visible Veslo/OpenCode sidecar console windows, or the verification gap is explicitly recorded.
- Docs describe the Windows sidecar behavior and separate antivirus prompts from terminal windows.
- `VSLO-184` gets the simple tester handoff comment only when the user asks for it after implementation.
