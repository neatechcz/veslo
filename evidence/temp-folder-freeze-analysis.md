# Temporary Folder System: Complete Code Analysis

## What This Document Covers

Every code path involved in temporary folder (session) creation, activation, joining to a permanent folder, and cleanup. Each path is traced with exact file locations, timeouts, and identified failure points.

---

## 1. Creating a Temp Session

**Entry point:** User clicks "New Session"

### Call chain

```
app.tsx:4923  openNewSessionWithDirectory()
  workspace.ts:1477  createScratchWorkspace()
    workspace.ts:333  buildPrivateWorkspaceRoot()
      → resolves {appDataDir}/private-workspaces
    → folder = {root}/{Date.now()}-{runId}
    workspace.ts:1388  createLocalWorkspace("starter", folder)
      tauri.ts  workspaceCreate({folderPath, name, preset})
        workspace.rs:206  workspace_create()               ← Tauri IPC, synchronous Rust
          workspace.rs:232  fs::create_dir_all(&folder)
          workspace.rs:236  ensure_workspace_files(&folder, "starter")
            files.rs:350   create .opencode/skills/
            files.rs:353   seed_workspace_guide()           — writes SKILL.md
            files.rs:355   seed_get_started_skill()         — writes SKILL.md
            files.rs:356   seed_enterprise_creator_skills() — downloads ZIP from GitHub (first time only, marker file check)
            files.rs:365   provision_internal_workspace_assets() — writes internal packs
            files.rs:381   seed_commands()                  — writes command .md files
            files.rs:395   read/create opencode.json config
            files.rs:499   create .opencode/veslo.json
          workspace.rs:238  load_workspace_state()
          workspace.rs:239  add workspace to state list
          workspace.rs:259  save_workspace_state()
          workspace.rs:261  update_workspace_watch()        — starts file watcher
      workspace.ts:1432  setWorkspaces(ws.workspaces)
      workspace.ts:1440  setProjectDir(active.path)        ← premature update (documented bug, workaround in place)

  workspace.ts:1538  ensureLocalWorkspaceActive(scratch.id)
    workspace.ts:514  activateWorkspace(id)
      workspace.ts:547  setConnectingWorkspaceId(id)       ← loading overlay triggers after 250ms
      workspace.ts:550  setTimeout(WORKSPACE_ACTIVATE_TIMEOUT_MS = 30s)  ← safety timeout
      workspace.ts:828  actualEngineDir = engineStore.engine()?.projectDir
      workspace.ts:829  workspaceChanged = oldPath !== nextRoot || actualEngineDir !== nextRoot
      workspace.ts:845  workspaceSetActive(id)             — Tauri IPC (8s timeout)
      workspace.ts:994  if (!isRemote && wasLocalConnection && workspaceChanged):
        → engine restart path (see section 4)
      workspace.ts:1114  wsActivateGuard.exit()            ← clears connectingWorkspaceId → hides overlay

    workspace.ts:1543  if no client yet:
      workspace.ts:1551  engineStore.startHost(workspace.path)  ← THIS IS THE BLOCKING CALL
```

### What startHost does

```
engine-store.ts:206  startHost()
  engine-store.ts:262  setBusy(true), setBusyLabel("status.starting_engine")
    → loading overlay shows (app.tsx:5851-5853 checks for this label)
  engine-store.ts:272  engineStart(dir, options)             ← Tauri IPC
    engine.rs:369  engine_start()                           ← synchronous Rust
      engine.rs:389  fs::create_dir_all(project_dir)
      engine.rs:392  read_opencode_config()
      engine.rs:405  runtime = Orchestrator (default)
      engine.rs:486  spawn_orchestrator_daemon()            — spawns veslo-orchestrator process
      engine.rs:554  health_timeout_ms = 180_000            ← 180 SECONDS (3 MINUTES)
      engine.rs:560  wait_for_orchestrator(base_url, 180s)  ← BUSY LOOP, BLOCKS THREAD
        orchestrator/mod.rs:175  while elapsed < 180s:
          orchestrator/mod.rs:182  fetch_orchestrator_health()  — HTTP GET /health (1.2s timeout each)
          orchestrator/mod.rs:187  sleep(200ms)
  engine-store.ts:310  setBusy(false)                       ← only runs AFTER engineStart returns
```

### Failure point: Loading overlay stuck for up to 3 minutes

When `engineStart()` is called via Tauri IPC, it blocks for up to **180 seconds** in `wait_for_orchestrator()`. During this time:
- `busy = true` and `busyLabel = "status.starting_engine"`
- `app.tsx:5845-5854` keeps `workspaceSwitchOpen = true`
- The user sees the workspace switch overlay with spinner indefinitely

The orchestrator polls every 200ms. If OpenCode is slow to start on the temp directory (DB migration, file indexing, etc.), the user waits. If OpenCode never becomes healthy, they wait the full 180 seconds before seeing an error.

**Why temp directories specifically?** The temp directory is brand new. OpenCode starts from scratch — no existing DB, no cached state. It runs initial setup, migrations, and indexing. This is slower than starting on a workspace that was previously initialized.

---

## 2. Opening an Existing Temp Session (Workspace Switch)

**Entry point:** User clicks on a session that belongs to a temp workspace while a different workspace is active.

### Call chain

```
app.tsx:6515  void selectSession(id)
  → but first, the session belongs to workspace X while workspace Y is active
  → the app needs to switch workspaces

workspace.ts:514  activateWorkspace(tempWorkspaceId)
  workspace.ts:547  setConnectingWorkspaceId(id)
  workspace.ts:829  workspaceChanged = true (different workspace)
  workspace.ts:994  if (wasLocalConnection && workspaceChanged):
    workspace.ts:1001  setBusy(true), setBusyLabel("status.restarting_engine")
    workspace.ts:1007  if runtime === "veslo-orchestrator":
      workspace.ts:1008  activateOrchestratorWorkspace({workspacePath})
        → 15s timeout (ORCHESTRATOR_WORKSPACE_ACTIVATE_TIMEOUT_MS)
        orchestrator.rs:638  orchestrator_workspace_activate()
          → POST /workspaces (add workspace)
          → POST /workspaces/{id}/activate
          → GET /workspaces/{id}/path
      workspace.ts:1012  activateVesloHostWorkspaceWithTimeout()
        → switches veslo host to temp workspace path
      workspace.ts:1016  engineInfo()  (12s timeout)
      workspace.ts:1028  connectToServer()
    workspace.ts:1045  else (non-orchestrator):
      workspace.ts:1046  runWorkspaceEngineRestartWithTimeouts()
        → engineStop() then engineStart(next.path)
        → engineStart blocks for up to 180s (same as section 1)
  workspace.ts:1090  setBusy(false)
  workspace.ts:1114  wsActivateGuard.exit()  → hides overlay
```

### Failure points for workspace switch

**Path A (orchestrator runtime):** `activateOrchestratorWorkspace` has a 15s timeout. If the orchestrator's `/workspaces` or `/activate` endpoints are slow (because OpenCode is busy with the temp workspace), this times out. But the catch at line 1085 handles it, marks `engineRestartFailed`, and returns false. The overlay hides. **This path has proper timeouts.**

**Path B (non-orchestrator runtime):** `engineStart()` blocks for up to **180 seconds** inside `wait_for_orchestrator`. The `runWorkspaceEngineRestartWithTimeouts` wrapper may or may not have its own timeout — let me check.

<FINDING: Need to verify if runWorkspaceEngineRestartWithTimeouts has a timeout that's shorter than 180s>

**Path C (no prior local connection):** If there was no prior local engine (e.g., user was on a remote workspace), the code at workspace.ts:975-989 uses `startHost` with a **45-second timeout** (`START_HOST_TIMEOUT_MS`). But `startHost` internally calls `engineStart` which blocks for up to 180s on the Rust side. The JS timeout fires after 45s and throws, but the Rust thread continues blocking for another 135s in the background. The overlay hides after 45s in this case.

---

## 3. Joining Temp Session to Permanent Folder

**Entry point:** User clicks "Select Directory" to move a temp session to a real folder.

### Call chain

```
app.tsx:4936  chooseFolderForCurrentSession()
  app.tsx:4955  pickWorkspaceFolder()                — native OS file picker dialog

  app.tsx:4958  workspaceCopyIntoFolder({source, target, overwrite: false})
    workspace.rs:164  workspace_copy_into_folder()    ← Tauri IPC, synchronous
      workspace.rs:191  collect_copy_conflicts(source, target)
        fs.rs:39  collect_copy_conflicts()
          fs.rs:51  collect_copy_conflicts_inner()    — recursive, NO depth limit, NO symlink check
      workspace.rs:199  copy_dir_recursive(source, target)
        fs.rs:4   copy_dir_recursive()               — recursive, NO depth limit, NO symlink check

  app.tsx:4964  if conflicts:
    → window.confirm("Replace?")
    → if yes: workspaceCopyIntoFolder({overwrite: true})
    → if no: window.confirm("Choose another?") → loop back or return
    → NO RENAME OPTION

  app.tsx:4992  ensureWorkspaceForFolder(selectedDirectory)
    workspace.ts:1514  ensureWorkspaceForFolder()
      workspace.ts:1521  findLocalWorkspaceByPath()     — checks if workspace already exists
      workspace.ts:1524  if not: createLocalWorkspace("starter", folder)
        → workspace_create() → ensure_workspace_files()
        → This re-provisions the target folder even though files were just copied

  app.tsx:4994  ensureLocalWorkspaceActive(targetWorkspace.id)
    → full activation flow (section 2)
    → engine restarts on the new permanent directory

  app.tsx:4997  persistSessionDirectoryOverride(sessionID, path)
  app.tsx:5004  update session-to-workspace mapping
  app.tsx:5011  update sidebar sessions
  app.tsx:5016  selectSession(sessionID)
  app.tsx:5017  refreshSidebarWorkspaceSessions(targetWorkspace.id)

  app.tsx:5019  if sourceWorkspaceId !== targetWorkspace.id:
    app.tsx:5020  forgetWorkspace(sourceWorkspaceId)
      workspace.ts:1556  forgetWorkspace()
        tauri.ts  workspaceForget(id)
          workspace.rs:52  workspace_forget()
            → removes from veslo-workspaces.json
            → does NOT delete temp directory from disk
```

### Failure points for join/move

1. **`copy_dir_recursive` with no symlink protection** (`fs.rs:21`):
   `file_type.is_dir()` returns true for symlinks to directories. If temp workspace contains a symlink pointing back to a parent, this infinite-loops. No depth limit either.

2. **`copy_dir_recursive` with no cancellation or progress**: Large temp workspaces with many provisioned files copy silently. No way to cancel, no progress reported to UI. The Tauri IPC thread blocks.

3. **Double provisioning** (`app.tsx:4992`): After copying files to the target, `ensureWorkspaceForFolder` calls `createLocalWorkspace` which calls `workspace_create` which calls `ensure_workspace_files`. Most seeding functions check if files exist and skip, but `provision_internal_workspace_assets` always runs and compares every file. This is unnecessary I/O.

4. **No conflict renaming**: Current behavior is overwrite-or-block. User requirement is to rename conflicting files (e.g., `file.txt` → `file_1.txt`).

5. **No atomicity**: If any step fails mid-sequence, state is inconsistent. Files copied but workspace not created; workspace created but session mapping not updated; old workspace not forgotten. No rollback.

6. **Temp directory not deleted from disk**: `forgetWorkspace` removes from state only. Stale temp directories accumulate at `{appDataDir}/private-workspaces/`.

---

## 4. App Startup With Temp Workspace as Last Active

**Entry point:** App launches, last active workspace was a temp folder.

### Call chain

```
app.tsx:5049  onMount()
  app.tsx:5050  startupGuard(15s timeout → force setBooting(false))
  app.tsx:5339  bootstrapOnboarding()
    workspace.ts:1867  bootstrapOnboarding()
      workspace.ts:1882  workspaceBootstrap()  (10s timeout)
        workspace.rs:22  workspace_bootstrap()       ← Tauri IPC
          workspace.rs:30  for each local workspace:
            workspace.rs:34  ensure_workspace_files() — runs for EVERY workspace including temp ones
          workspace.rs:42  save_workspace_state()
          workspace.rs:44  update_workspace_watch(active workspace)

      workspace.ts:1899  refreshEngine()  (10s timeout)
      workspace.ts:1902  refreshEngineDoctor()  (10s timeout)
      workspace.ts:1917  setProjectDir(active.path)    — set to temp folder path
      workspace.ts:1919  workspaceVesloRead()  (10s timeout)

      workspace.ts:2062  if activeWorkspacePath().trim():
        workspace.ts:2089  startHost({workspacePath: tempFolderPath})
          → engine_start() → wait_for_orchestrator(180s)
          → loading overlay stuck for up to 180 seconds
          → NO TIMEOUT on the await at line 2091

  app.tsx:5341  setBooting(false)  ← only after bootstrapOnboarding() completes
  app.tsx:5054  BUT: startupGuard forces setBooting(false) after 15s
```

### Key finding for app startup

At `workspace.ts:2091`, `startHost()` is awaited with **no timeout wrapper**:
```typescript
const ok = await engineStore.startHost({ workspacePath: activeWorkspacePath().trim() });
```

Compare to workspace.ts:977 where it's wrapped in `withTimeoutOrThrow(..., 45s)`.

So during bootstrap:
- `startHost()` calls `engineStart()` which blocks for up to 180s on Rust side
- The 15-second `startupGuard` fires and sets `booting(false)`
- BUT `busy` remains true and `busyLabel` remains `"status.starting_engine"` because `startHost` hasn't returned yet
- `workspaceSwitchOpen` at app.tsx:5851 returns true because of the `busy && busyLabel === "status.starting_engine"` check
- **The loading overlay stays visible for up to 180 seconds**

---

## 5. All Timeouts Summary

| Location | What | Timeout | Notes |
|----------|------|---------|-------|
| `workspace.ts:208` | `WORKSPACE_ACTIVATE_TIMEOUT_MS` | 30s | Safety timeout for entire `activateWorkspace` |
| `workspace.ts:209` | `ORCHESTRATOR_WORKSPACE_ACTIVATE_TIMEOUT_MS` | 15s | `activateOrchestratorWorkspace` wrapper |
| `workspace.ts:204` | `WORKSPACE_IO_TIMEOUT_MS` | 8s | veslo config read |
| `workspace.ts:205` | `WORKSPACE_SET_ACTIVE_TIMEOUT_MS` | 8s | set active workspace |
| `workspace.ts:206` | `ENGINE_INFO_TIMEOUT_MS` | 12s | engine info query |
| `workspace.ts:207` | `START_HOST_TIMEOUT_MS` | 45s | startHost in workspace switch |
| `workspace.ts:1882` | `workspaceBootstrap` | 10s | bootstrap Tauri call |
| `app.tsx:5051` | startup guard | 15s | forces `booting(false)` |
| `engine.rs:558` | orchestrator health wait | **180s** | **busy-loop in Rust, blocks Tauri thread** |
| `orchestrator/mod.rs:150` | individual health fetch | 1.2s | per-poll HTTP timeout |
| `workspace.ts:2091` | `startHost` during bootstrap | **NONE** | **no timeout wrapper** |

### The gap

The **180-second** Rust-side timeout on `wait_for_orchestrator` is far longer than any frontend timeout. When `startHost()` is called:
- During workspace switch: 45s JS timeout, but Rust blocks for 180s (thread wasted)
- During bootstrap: **no JS timeout at all**, full 180s block

---

## 6. Complete File Inventory

### Rust (Tauri backend)

| File | Functions | Role |
|------|-----------|------|
| `src-tauri/src/fs.rs` | `copy_dir_recursive()`, `collect_copy_conflicts()`, `collect_copy_conflicts_inner()` | File copy with conflict detection |
| `src-tauri/src/commands/workspace.rs` | `workspace_bootstrap()`, `workspace_create()`, `workspace_copy_into_folder()`, `workspace_forget()`, `workspace_set_active()` | Workspace CRUD |
| `src-tauri/src/workspace/files.rs` | `ensure_workspace_files()`, `seed_enterprise_creator_skills()`, `seed_workspace_guide()`, `seed_get_started_skill()`, `seed_commands()` | Workspace provisioning |
| `src-tauri/src/workspace/internal_provision.rs` | `provision_internal_workspace_assets()` | Internal pack provisioning |
| `src-tauri/src/workspace/state.rs` | `load_workspace_state()`, `save_workspace_state()`, `stable_workspace_id()` | State persistence |
| `src-tauri/src/workspace/watch.rs` | `update_workspace_watch()` | File system watcher |
| `src-tauri/src/commands/engine.rs` | `engine_start()` | Engine process lifecycle |
| `src-tauri/src/orchestrator/mod.rs` | `wait_for_orchestrator()`, `spawn_orchestrator_daemon()`, `fetch_orchestrator_health()`, `orchestrator_workspace_activate()` | Orchestrator management |

### TypeScript (Frontend)

| File | Functions | Role |
|------|-----------|------|
| `context/workspace.ts` | `createScratchWorkspace()`, `ensureWorkspaceForFolder()`, `ensureLocalWorkspaceActive()`, `activateWorkspace()`, `forgetWorkspace()`, `bootstrapOnboarding()`, `activateOrchestratorWorkspace()`, `isPrivateWorkspacePath()` | Workspace orchestration |
| `app.tsx` | `openNewSessionWithDirectory()`, `chooseFolderForCurrentSession()` | User-facing flows |
| `stores/engine-store.ts` | `startHost()` | Engine lifecycle |
| `lib/tauri.ts` | `workspaceCreate()`, `workspaceCopyIntoFolder()`, `workspaceBootstrap()`, `workspaceForget()`, `engineStart()`, `orchestratorWorkspaceActivate()` | Tauri IPC bindings |
| `utils/temp-folder-isolation.test.ts` | Tests | Documents premature projectDir bug |

---

## 7. Every Way This Can Break

### Freeze / Infinite Loading

| # | Scenario | Root Cause | Duration |
|---|----------|-----------|----------|
| 1 | App starts with temp workspace as last active | `startHost()` at `workspace.ts:2091` has **no timeout**, `engine_start()` blocks for up to 180s in `wait_for_orchestrator` | Up to 180s |
| 2 | Switching to a temp workspace (non-orchestrator) | `engineStart()` via `runWorkspaceEngineRestartWithTimeouts` blocks for 180s | Up to 180s |
| 3 | Copy from temp to permanent with symlinks | `copy_dir_recursive()` follows dir symlinks with no depth limit | Infinite |
| 4 | `workspace_bootstrap()` with many stale temp workspaces | `ensure_workspace_files()` runs for each; 10s frontend timeout but Rust thread not cancelled | 10s visible + background waste |

### Data Corruption / Inconsistency

| # | Scenario | Root Cause |
|---|----------|-----------|
| 5 | Join fails after copy but before workspace creation | Files copied to target, no workspace registered for it, old workspace still active |
| 6 | Join fails after workspace creation but before session mapping | Session still points to old temp workspace |
| 7 | Join fails after engine restart but before forgetWorkspace | Both old and new workspaces in state, stale temp dir |
| 8 | Premature projectDir update | `createLocalWorkspace` sets projectDir before engine restart — workaround exists at workspace.ts:828 |

### Missing Functionality

| # | What | Current State |
|---|------|---------------|
| 9 | Conflict renaming during join | Only overwrite or block. No rename. |
| 10 | Temp dir cleanup on disk | `forgetWorkspace` only removes from state, not from disk |
| 11 | Cancel long operations | No way to cancel copy, engine start, or provisioning |
