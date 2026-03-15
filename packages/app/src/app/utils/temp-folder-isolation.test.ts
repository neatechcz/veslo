import assert from "node:assert/strict";
import test from "node:test";

import {
  sessionDirectoryMatchesRoot,
  normalizeDirectoryPath,
  commandPathFromWorkspaceRoot,
} from "./index.js";

// ---------------------------------------------------------------------------
// Temporary folder isolation tests
//
// Bug: user creates a temporary (scratch/private) workspace session, sends a
// prompt, and the output is saved to a named workspace folder ("Mojda")
// instead of the temporary folder.
//
// Root cause: createLocalWorkspace() calls setProjectDir(scratchPath) BEFORE
// the engine is restarted.  When activateWorkspace() runs afterwards, it reads
// projectDir() which already shows the scratch path, computes
// workspaceChanged = false, and SKIPS the engine restart / client reconnect.
// The engine and SDK client remain bound to the previous workspace (Mojda),
// so all file writes go there.
// ---------------------------------------------------------------------------

const TEMP_FOLDER = "/Users/alice/Library/Application Support/private-workspaces/tmp-abc123";
const MOJDA_FOLDER = "/Users/alice/projects/Mojda";
const WORK_FOLDER = "/Users/alice/projects/Work";

// ===================================================================
// PART A — Integration-level tests: workspace activation state machine
//
// These simulate the actual app state during workspace switching and
// verify that the directory visible to session.create(), the client,
// and the engine are all consistent.
// ===================================================================

// Minimal simulation of the reactive signals involved in workspace switching.
function createWorkspaceStateMachine() {
  // Signals (mutable state, mimicking SolidJS signals)
  let projectDir = "";
  let activeWorkspaceId = "";
  let clientDirectory = "";    // directory the SDK client was created with
  let engineDirectory = "";    // directory the engine process is running in
  let connectingWorkspaceId: string | null = null;

  const workspaces: Array<{ id: string; path: string }> = [];

  // --- createLocalWorkspace: creates workspace & prematurely sets projectDir ---
  function createLocalWorkspace(id: string, path: string) {
    workspaces.push({ id, path });
    activeWorkspaceId = id;
    projectDir = path;           // <— premature update (the real bug)
    return { id, path };
  }

  // --- activateWorkspace: should detect directory change & reconnect engine ---
  async function activateWorkspace(id: string) {
    const next = workspaces.find((w) => w.id === id);
    if (!next) return false;

    const oldWorkspacePath = projectDir;         // reads current projectDir
    const nextRoot = next.path;
    const workspaceChanged = oldWorkspacePath !== nextRoot;

    activeWorkspaceId = id;
    projectDir = nextRoot;

    // Simulate engine restart + client reconnect when workspace changes.
    // If workspaceChanged is false, this is SKIPPED — which is the bug.
    if (workspaceChanged) {
      engineDirectory = nextRoot;
      clientDirectory = nextRoot;
    }

    return true;
  }

  // --- createSessionAndOpen: reads activeWorkspaceRoot, creates session ---
  function resolveSessionDirectory() {
    if (connectingWorkspaceId) {
      throw new Error("Blocked: workspace switch in progress");
    }
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    const activeRoot = ws?.path?.trim() ?? "";
    if (!activeRoot) throw new Error("activeWorkspaceRoot is empty");
    return activeRoot;
  }

  return {
    get projectDir() { return projectDir; },
    get activeWorkspaceId() { return activeWorkspaceId; },
    get clientDirectory() { return clientDirectory; },
    get engineDirectory() { return engineDirectory; },
    get connectingWorkspaceId() { return connectingWorkspaceId; },
    set connectingWorkspaceId(v: string | null) { connectingWorkspaceId = v; },

    setEngineDirectory(dir: string) { engineDirectory = dir; },
    setClientDirectory(dir: string) { clientDirectory = dir; },

    createLocalWorkspace,
    activateWorkspace,
    resolveSessionDirectory,
  };
}

// ---------------------------------------------------------------------------
// A1. THE EXACT BUG: premature projectDir update causes skipped engine restart
// ---------------------------------------------------------------------------

test("BUG: createLocalWorkspace premature setProjectDir causes activateWorkspace to skip engine restart", async () => {
  const sm = createWorkspaceStateMachine();

  // Initial state: engine running with Mojda
  sm.createLocalWorkspace("ws-mojda", MOJDA_FOLDER);
  sm.setEngineDirectory(MOJDA_FOLDER);
  sm.setClientDirectory(MOJDA_FOLDER);
  await sm.activateWorkspace("ws-mojda");

  assert.equal(sm.engineDirectory, MOJDA_FOLDER, "engine starts with Mojda");
  assert.equal(sm.clientDirectory, MOJDA_FOLDER, "client starts with Mojda");

  // User creates a scratch workspace (mirrors createScratchWorkspace flow).
  // createLocalWorkspace prematurely sets projectDir to the scratch path.
  const scratch = sm.createLocalWorkspace("ws-scratch", TEMP_FOLDER);

  // At this point, projectDir = TEMP_FOLDER but engine is still on MOJDA.
  assert.equal(sm.projectDir, TEMP_FOLDER, "projectDir prematurely updated");
  assert.equal(sm.engineDirectory, MOJDA_FOLDER, "engine NOT yet restarted");

  // ensureLocalWorkspaceActive calls activateWorkspace.
  // Because projectDir was already set to TEMP_FOLDER, workspaceChanged = false.
  await sm.activateWorkspace(scratch.id);

  // THE BUG: engine and client are STILL on Mojda because restart was skipped.
  // These assertions document the buggy behavior:
  assert.equal(
    sm.engineDirectory,
    MOJDA_FOLDER,
    "BUG: engine directory is still Mojda after scratch workspace activation",
  );
  assert.equal(
    sm.clientDirectory,
    MOJDA_FOLDER,
    "BUG: client directory is still Mojda after scratch workspace activation",
  );

  // The session directory looks correct (from activeWorkspaceRoot) ...
  const sessionDir = sm.resolveSessionDirectory();
  assert.equal(sessionDir, TEMP_FOLDER, "session directory resolves to scratch path");

  // ... but it doesn't match what the client/engine will actually use:
  assert.notEqual(
    sessionDir,
    sm.clientDirectory,
    "BUG: session directory and client directory DISAGREE — output goes to wrong folder",
  );
  assert.notEqual(
    sessionDir,
    sm.engineDirectory,
    "BUG: session directory and engine directory DISAGREE — output goes to wrong folder",
  );
});

// ---------------------------------------------------------------------------
// A2. CORRECT behavior: activateWorkspace must detect engine directory mismatch
// ---------------------------------------------------------------------------

function createFixedWorkspaceStateMachine() {
  let projectDir = "";
  let activeWorkspaceId = "";
  let clientDirectory = "";
  let engineDirectory = "";
  let connectingWorkspaceId: string | null = null;

  const workspaces: Array<{ id: string; path: string }> = [];

  function createLocalWorkspace(id: string, path: string) {
    workspaces.push({ id, path });
    activeWorkspaceId = id;
    projectDir = path;
    return { id, path };
  }

  // FIXED activateWorkspace: compares against engineDirectory, not projectDir
  async function activateWorkspace(id: string) {
    const next = workspaces.find((w) => w.id === id);
    if (!next) return false;

    // FIX: detect mismatch by comparing against actual engine directory,
    // not the potentially-stale projectDir signal.
    const workspaceChanged =
      engineDirectory !== next.path || clientDirectory !== next.path;

    activeWorkspaceId = id;
    projectDir = next.path;

    if (workspaceChanged) {
      engineDirectory = next.path;
      clientDirectory = next.path;
    }

    return true;
  }

  function resolveSessionDirectory() {
    if (connectingWorkspaceId) {
      throw new Error("Blocked: workspace switch in progress");
    }
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    const activeRoot = ws?.path?.trim() ?? "";
    if (!activeRoot) throw new Error("activeWorkspaceRoot is empty");
    return activeRoot;
  }

  return {
    get projectDir() { return projectDir; },
    get activeWorkspaceId() { return activeWorkspaceId; },
    get clientDirectory() { return clientDirectory; },
    get engineDirectory() { return engineDirectory; },
    get connectingWorkspaceId() { return connectingWorkspaceId; },
    set connectingWorkspaceId(v: string | null) { connectingWorkspaceId = v; },

    setEngineDirectory(dir: string) { engineDirectory = dir; },
    setClientDirectory(dir: string) { clientDirectory = dir; },

    createLocalWorkspace,
    activateWorkspace,
    resolveSessionDirectory,
  };
}

test("FIXED: activateWorkspace detects engine mismatch and restarts after premature projectDir update", async () => {
  const sm = createFixedWorkspaceStateMachine();

  // Initial state: engine running with Mojda
  sm.createLocalWorkspace("ws-mojda", MOJDA_FOLDER);
  sm.setEngineDirectory(MOJDA_FOLDER);
  sm.setClientDirectory(MOJDA_FOLDER);
  await sm.activateWorkspace("ws-mojda");

  // User creates scratch workspace (premature projectDir update still happens)
  const scratch = sm.createLocalWorkspace("ws-scratch", TEMP_FOLDER);

  // activateWorkspace now compares against engineDirectory, not projectDir
  await sm.activateWorkspace(scratch.id);

  // FIXED: engine and client are updated to scratch path
  assert.equal(sm.engineDirectory, TEMP_FOLDER, "engine must restart to scratch path");
  assert.equal(sm.clientDirectory, TEMP_FOLDER, "client must reconnect to scratch path");

  const sessionDir = sm.resolveSessionDirectory();
  assert.equal(sessionDir, TEMP_FOLDER);
  assert.equal(sessionDir, sm.clientDirectory, "session and client directories must agree");
  assert.equal(sessionDir, sm.engineDirectory, "session and engine directories must agree");
});

// ---------------------------------------------------------------------------
// A3. After multiple workspace switches, all three directories stay consistent
// ---------------------------------------------------------------------------

test("FIXED: multiple switches Mojda → scratch → Work → scratch keep directories consistent", async () => {
  const sm = createFixedWorkspaceStateMachine();

  sm.createLocalWorkspace("ws-mojda", MOJDA_FOLDER);
  sm.setEngineDirectory(MOJDA_FOLDER);
  sm.setClientDirectory(MOJDA_FOLDER);
  await sm.activateWorkspace("ws-mojda");

  const scratch = sm.createLocalWorkspace("ws-scratch", TEMP_FOLDER);
  await sm.activateWorkspace(scratch.id);
  assert.equal(sm.engineDirectory, TEMP_FOLDER);
  assert.equal(sm.clientDirectory, TEMP_FOLDER);

  sm.createLocalWorkspace("ws-work", WORK_FOLDER);
  await sm.activateWorkspace("ws-work");
  assert.equal(sm.engineDirectory, WORK_FOLDER);
  assert.equal(sm.clientDirectory, WORK_FOLDER);

  // Switch back to scratch
  await sm.activateWorkspace("ws-scratch");
  assert.equal(sm.engineDirectory, TEMP_FOLDER);
  assert.equal(sm.clientDirectory, TEMP_FOLDER);

  const sessionDir = sm.resolveSessionDirectory();
  assert.equal(sessionDir, TEMP_FOLDER);
  assert.equal(sessionDir, sm.clientDirectory);
  assert.equal(sessionDir, sm.engineDirectory);
});

// ---------------------------------------------------------------------------
// A4. connectingWorkspaceId guard blocks session creation during switch
// ---------------------------------------------------------------------------

test("session creation is blocked while workspace switch is in progress", () => {
  const sm = createFixedWorkspaceStateMachine();

  sm.createLocalWorkspace("ws-mojda", MOJDA_FOLDER);
  sm.setEngineDirectory(MOJDA_FOLDER);
  sm.setClientDirectory(MOJDA_FOLDER);

  sm.connectingWorkspaceId = "ws-scratch";

  assert.throws(
    () => sm.resolveSessionDirectory(),
    /workspace switch in progress/,
    "must block session creation while workspace switch is in flight",
  );
});

// ---------------------------------------------------------------------------
// A5. Engine directory must never silently fall back to previous workspace
// ---------------------------------------------------------------------------

test("engine directory never falls back to Mojda after scratch activation failure", async () => {
  const sm = createFixedWorkspaceStateMachine();

  sm.createLocalWorkspace("ws-mojda", MOJDA_FOLDER);
  sm.setEngineDirectory(MOJDA_FOLDER);
  sm.setClientDirectory(MOJDA_FOLDER);
  await sm.activateWorkspace("ws-mojda");

  // Scratch workspace created but activation fails (workspace not found)
  const activated = await sm.activateWorkspace("ws-nonexistent");
  assert.equal(activated, false);

  // Engine must NOT have changed to some random directory
  assert.equal(sm.engineDirectory, MOJDA_FOLDER, "engine stays on last known-good workspace");
  assert.equal(sm.clientDirectory, MOJDA_FOLDER, "client stays on last known-good workspace");
});

// ===================================================================
// PART B — Utility-level tests: sessionDirectoryMatchesRoot isolation
// ===================================================================

test("temp session directory matches its own temp folder root", () => {
  assert.equal(sessionDirectoryMatchesRoot(TEMP_FOLDER, TEMP_FOLDER), true);
});

test("temp session directory does NOT match a named workspace (Mojda)", () => {
  assert.equal(sessionDirectoryMatchesRoot(TEMP_FOLDER, MOJDA_FOLDER), false);
});

test("named workspace (Mojda) session does NOT match temp folder root", () => {
  assert.equal(sessionDirectoryMatchesRoot(MOJDA_FOLDER, TEMP_FOLDER), false);
});

test("empty session directory matches active root (temp workspace)", () => {
  assert.equal(sessionDirectoryMatchesRoot("", TEMP_FOLDER), true);
});

test("empty session directory matches active root (named workspace)", () => {
  assert.equal(sessionDirectoryMatchesRoot("", MOJDA_FOLDER), true);
});

test("two different temp folders are isolated from each other", () => {
  const tempA = "/Users/alice/Library/Application Support/private-workspaces/tmp-111";
  const tempB = "/Users/alice/Library/Application Support/private-workspaces/tmp-222";
  assert.equal(sessionDirectoryMatchesRoot(tempA, tempB), false);
  assert.equal(sessionDirectoryMatchesRoot(tempB, tempA), false);
});

test("temp folder does not match parent private-workspaces directory", () => {
  const child = "/Users/alice/Library/Application Support/private-workspaces/tmp-111";
  const parent = "/Users/alice/Library/Application Support/private-workspaces";
  assert.equal(sessionDirectoryMatchesRoot(child, parent), false);
  assert.equal(sessionDirectoryMatchesRoot(parent, child), false);
});

test("trailing slashes do not break isolation", () => {
  assert.equal(sessionDirectoryMatchesRoot(TEMP_FOLDER + "/", MOJDA_FOLDER), false);
  assert.equal(sessionDirectoryMatchesRoot(TEMP_FOLDER + "/", TEMP_FOLDER), true);
});

test("null/empty workspace root rejects everything", () => {
  assert.equal(sessionDirectoryMatchesRoot(TEMP_FOLDER, null), false);
  assert.equal(sessionDirectoryMatchesRoot(TEMP_FOLDER, undefined), false);
  assert.equal(sessionDirectoryMatchesRoot(TEMP_FOLDER, ""), false);
});

test("command path resolves under temp folder, not Mojda", () => {
  const tempCmd = commandPathFromWorkspaceRoot(TEMP_FOLDER, "test-skill");
  assert.ok(tempCmd!.startsWith(TEMP_FOLDER));
  assert.ok(!tempCmd!.startsWith(MOJDA_FOLDER));
});

test("normalized temp and named paths remain distinct", () => {
  assert.notEqual(normalizeDirectoryPath(TEMP_FOLDER), normalizeDirectoryPath(MOJDA_FOLDER));
});

// ===================================================================
// PART C — Session list filtering after workspace switch / restart
// ===================================================================

test("after restart with temp workspace active, only temp sessions are visible", () => {
  const sessions = [
    { id: "sess-1", directory: TEMP_FOLDER },
    { id: "sess-2", directory: MOJDA_FOLDER },
    { id: "sess-3", directory: TEMP_FOLDER },
    { id: "sess-4", directory: "" },
  ];

  const visible = sessions
    .filter((s) => sessionDirectoryMatchesRoot(s.directory, TEMP_FOLDER))
    .map((s) => s.id);

  assert.deepEqual(visible, ["sess-1", "sess-3", "sess-4"]);
});

test("after restart with Mojda active, temp sessions are excluded", () => {
  const sessions = [
    { id: "sess-1", directory: TEMP_FOLDER },
    { id: "sess-2", directory: MOJDA_FOLDER },
    { id: "sess-3", directory: WORK_FOLDER },
    { id: "sess-4", directory: "" },
  ];

  const visible = sessions
    .filter((s) => sessionDirectoryMatchesRoot(s.directory, MOJDA_FOLDER))
    .map((s) => s.id);

  assert.deepEqual(visible, ["sess-2", "sess-4"]);
});

test("SSE event from wrong workspace is rejected", () => {
  const activeRoot = normalizeDirectoryPath(MOJDA_FOLDER);
  const incoming = normalizeDirectoryPath(TEMP_FOLDER);

  const accepted =
    !activeRoot || !incoming || sessionDirectoryMatchesRoot(incoming, activeRoot);

  assert.equal(accepted, false);
});
