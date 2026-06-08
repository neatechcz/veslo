import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolvePendingDraftKey } from "../lib/pending-session-drafts.js";
import {
  createSessionFromDirectorySelection,
  createSessionWithWorkspaceActivation,
  openSessionWithWorkspaceActivation,
} from "./session-navigation.js";
import * as sessionNavigation from "./session-navigation.js";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const sessionPageSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");

const openNewSessionStart = appSource.indexOf("  const openNewSessionWithDirectory = async () => {");
const openNewSessionEnd = appSource.indexOf("  const openDirectorySessionFromPicker = async () => {", openNewSessionStart);
const openNewSessionSource =
  openNewSessionStart >= 0 && openNewSessionEnd >= 0
    ? appSource.slice(openNewSessionStart, openNewSessionEnd)
    : "";
const openDirectorySessionStart = appSource.indexOf("  const openDirectorySessionFromPicker = async () => {");
const openDirectorySessionEnd = appSource.indexOf("  const chooseFolderForCurrentSession = async () => {", openDirectorySessionStart);
const openDirectorySessionSource =
  openDirectorySessionStart >= 0 && openDirectorySessionEnd >= 0
    ? appSource.slice(openDirectorySessionStart, openDirectorySessionEnd)
    : "";
const openDirectoryPendingDraftStart = appSource.indexOf("  const openDirectoryPendingDraft = async (input: { workspaceId: string; directory: string }) => {");
const openDirectoryPendingDraftEnd = appSource.indexOf("  const openPendingDirectoryDraftInWorkspace = async (workspaceId: string) => {", openDirectoryPendingDraftStart);
const openDirectoryPendingDraftSource =
  openDirectoryPendingDraftStart >= 0 && openDirectoryPendingDraftEnd >= 0
    ? appSource.slice(openDirectoryPendingDraftStart, openDirectoryPendingDraftEnd)
    : "";
const openPendingDirectoryDraftInWorkspaceStart = appSource.indexOf(
  "  const openPendingDirectoryDraftInWorkspace = async (workspaceId: string) => {",
);
const openPendingDirectoryDraftInWorkspaceEnd = appSource.indexOf(
  "  const openDirectorySessionFromPicker = async () => {",
  openPendingDirectoryDraftInWorkspaceStart,
);
const openPendingDirectoryDraftInWorkspaceSource =
  openPendingDirectoryDraftInWorkspaceStart >= 0 && openPendingDirectoryDraftInWorkspaceEnd >= 0
    ? appSource.slice(openPendingDirectoryDraftInWorkspaceStart, openPendingDirectoryDraftInWorkspaceEnd)
    : "";
const scopedSendActivationStart = appSource.indexOf("  async function ensureSelectedSessionWorkspaceActiveForSend(");
const scopedSendActivationEnd = appSource.indexOf("  async function sendPrompt(", scopedSendActivationStart);
const scopedSendActivationSource =
  scopedSendActivationStart >= 0 && scopedSendActivationEnd >= 0
    ? appSource.slice(scopedSendActivationStart, scopedSendActivationEnd)
    : "";
const abortSessionStart = appSource.indexOf("  async function abortSession(");
const abortSessionEnd = appSource.indexOf("  function retryLastPrompt()", abortSessionStart);
const abortSessionSource =
  abortSessionStart >= 0 && abortSessionEnd >= 0
    ? appSource.slice(abortSessionStart, abortSessionEnd)
    : "";
const compactCurrentSessionStart = appSource.indexOf("  async function compactCurrentSession(");
const compactCurrentSessionEnd = appSource.indexOf("  const triggerAutoCompaction = async (sessionID: string) => {", compactCurrentSessionStart);
const compactCurrentSessionSource =
  compactCurrentSessionStart >= 0 && compactCurrentSessionEnd >= 0
    ? appSource.slice(compactCurrentSessionStart, compactCurrentSessionEnd)
    : "";
const replaceUserMessageStart = appSource.indexOf("  async function replaceUserMessage(");
const replaceUserMessageEnd = appSource.indexOf("  async function undoLastUserMessage() {", replaceUserMessageStart);
const replaceUserMessageSource =
  replaceUserMessageStart >= 0 && replaceUserMessageEnd >= 0
    ? appSource.slice(replaceUserMessageStart, replaceUserMessageEnd)
    : "";
const undoLastUserMessageStart = appSource.indexOf("  async function undoLastUserMessage() {");
const undoLastUserMessageEnd = appSource.indexOf("  async function redoLastUserMessage() {", undoLastUserMessageStart);
const undoLastUserMessageSource =
  undoLastUserMessageStart >= 0 && undoLastUserMessageEnd >= 0
    ? appSource.slice(undoLastUserMessageStart, undoLastUserMessageEnd)
    : "";
const redoLastUserMessageStart = appSource.indexOf("  async function redoLastUserMessage() {");
const redoLastUserMessageEnd = appSource.indexOf("  async function renameSessionTitle(", redoLastUserMessageStart);
const redoLastUserMessageSource =
  redoLastUserMessageStart >= 0 && redoLastUserMessageEnd >= 0
    ? appSource.slice(redoLastUserMessageStart, redoLastUserMessageEnd)
    : "";
const renameSessionTitleStart = appSource.indexOf("  async function renameSessionTitle(");
const renameSessionTitleEnd = appSource.indexOf("  async function deleteSessionById(", renameSessionTitleStart);
const renameSessionTitleSource =
  renameSessionTitleStart >= 0 && renameSessionTitleEnd >= 0
    ? appSource.slice(renameSessionTitleStart, renameSessionTitleEnd)
    : "";
const sendPromptStart = appSource.indexOf("  async function sendPrompt(");
const sendPromptEnd = appSource.indexOf("  async function abortSession(", sendPromptStart);
const sendPromptSource =
  sendPromptStart >= 0 && sendPromptEnd >= 0
    ? appSource.slice(sendPromptStart, sendPromptEnd)
    : "";

function assertScopedWorkspaceGuardBeforeClient(source: string, name: string): void {
  const guardIndex = source.search(/if \(!\(await ensureSelectedSessionWorkspaceActiveForSend\((?:id|sessionID)\)\)\) (?:\{[\s\S]*?return|return)/s);
  assert.notEqual(guardIndex, -1, `${name} should return when scoped workspace activation fails`);

  const clientIndex = source.search(/\b(?:const|let)\s+\w+\s*=\s*client\(\)/);
  if (clientIndex === -1) return;
  assert.ok(
    guardIndex < clientIndex,
    `${name} should activate the scoped workspace before using the active runtime client`,
  );
}

const openPendingDraftWithWorkspaceActivation = () => {
  const fn = (
    sessionNavigation as typeof sessionNavigation & {
      openPendingDraftWithWorkspaceActivation?: (
        input: {
          activeWorkspaceId: string;
          getActiveWorkspaceId?: () => string;
          workspaceId: string;
          activateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
          openPendingDraft: () => Promise<string | boolean | undefined> | string | boolean | undefined | void;
        },
      ) => Promise<boolean>;
    }
  ).openPendingDraftWithWorkspaceActivation;
  assert.equal(
    typeof fn,
    "function",
    "session-navigation should export a pending-draft activation helper alongside real-session creation",
  );
  return fn;
};

const openPendingDraftFromDirectorySelection = () => {
  const fn = (
    sessionNavigation as typeof sessionNavigation & {
      openPendingDraftFromDirectorySelection?: (
        input: {
          activeWorkspaceId: string;
          getActiveWorkspaceId?: () => string;
          pickDirectory: () => Promise<string | null> | string | null;
          ensureWorkspaceForFolder: (
            folder: string,
          ) => Promise<{ id: string } | null> | { id: string } | null;
          activateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
          openPendingDraft: (
            target: { workspaceId: string; directory: string },
          ) => Promise<string | boolean | undefined> | string | boolean | undefined | void;
          onWorkspaceRegistered?: (
            target: { workspaceId: string; directory: string },
          ) => Promise<void> | void;
        },
      ) => Promise<"cancelled" | "blocked" | "opened">;
    }
  ).openPendingDraftFromDirectorySelection;
  assert.equal(
    typeof fn,
    "function",
    "session-navigation should export a picker flow for pending directory drafts",
  );
  return fn;
};

test("app passes active pending draft key into session view props", () => {
  assert.match(
    appSource,
    /activePendingDraftKey: activePendingDraftKey\(\),/,
    "session props should pass the active pending draft key into SessionView",
  );
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("opens immediately when session is in active workspace", async () => {
  const opened: string[] = [];
  const activated: string[] = [];

  const result = await openSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-active",
    sessionId: "sess-1",
    activateWorkspace: async (id) => {
      activated.push(id);
      return true;
    },
    openSession: (id) => opened.push(id),
  });

  assert.equal(result, "opened");
  assert.deepEqual(activated, []);
  assert.deepEqual(opened, ["sess-1"]);
});

test("session list clicks record browse scope before route navigation", () => {
  for (const source of [sessionPageSource, dashboardSource]) {
    const openSessionStart = source.indexOf("  const openSessionFromList = (workspaceId: string, sessionId: string) => {");
    assert.notEqual(openSessionStart, -1, "openSessionFromList should exist");
    const openSessionEnd = source.indexOf("  const resolveVesloWorkspaceId = (workspaceId: string) => {", openSessionStart);
    assert.notEqual(openSessionEnd, -1, "openSessionFromList block end should exist");
    const openSessionSource = source.slice(openSessionStart, openSessionEnd);

    assert.match(
      openSessionSource,
      /props\.setSessionBrowseScope\(\{[\s\S]*sessionId: nextSessionId,[\s\S]*workspaceId,[\s\S]*workspaceRoot:/,
      "existing-session navigation should record the workspace scope for DB transcript browsing",
    );
    assert.match(
      openSessionSource,
      /props\.setSessionBrowseScope\(\{[\s\S]*directory: session\?\.directory \?\? workspaceRoot,[\s\S]*conversationId: session\?\.conversationId \?\? null,[\s\S]*opencodeSessionId: session\?\.opencodeSessionId \?\? nextSessionId,/s,
      "existing-session navigation should carry conversation sidecars with the browse scope",
    );
    assert.match(
      openSessionSource,
      /props\.setSessionBrowseScope\(\{[\s\S]*\}\);\s*props\.setView\("session", nextSessionId\);/s,
      "session browse scope must be recorded before route navigation triggers selectSession",
    );
  }
});

test("app routes selected session browsing through DB scope", () => {
  assert.match(
    appSource,
    /const \[selectedSessionBrowseScope, setSelectedSessionBrowseScope\] = createSignal<SelectedSessionBrowseScope \| null>\(null\);/,
    "app should track the workspace scope of the selected browsed session",
  );
  assert.match(
    appSource,
    /shouldBrowseSessionFromDb: \(sessionId\) => \{[\s\S]*const transcriptScope = resolveSelectedSessionBrowseScope\(sessionId\);[\s\S]*if \(transcriptScope\) return true;[\s\S]*return !engineReady\(\);[\s\S]*\},/s,
    "session store should force DB browsing for scoped sidebar selections",
  );
  assert.match(
    appSource,
    /loadOfflineTranscript: async \(sessionId, limit\) => \{[\s\S]*const transcriptScope = resolveSelectedSessionBrowseScope\(sessionId\);[\s\S]*const transcriptWorkspaceId = transcriptScope\?\.workspaceId \?\? workspaceStore\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*const transcriptDirectory = transcriptScope\?\.directory \|\| workspaceRoot;[\s\S]*getTranscriptFromVesloReadApi\([\s\S]*transcriptWorkspaceId,[\s\S]*sessionId,[\s\S]*limit,[\s\S]*transcriptDirectory \|\| undefined,/s,
    "offline transcript snapshots should read through Veslo using the clicked session's workspace and directory scope",
  );
});

test("app activates selected session workspace at send time, not browse time", () => {
  assert.match(
    scopedSendActivationSource,
    /const transcriptScope = resolveSelectedSessionBrowseScope\(sessionId\);[\s\S]*await workspaceStore\.activateWorkspace\(targetWorkspaceId\);/s,
    "send path should activate the workspace from the selected session scope",
  );
  assert.match(
    sendPromptSource,
    /if \(sessionID && !\(await ensureSelectedSessionWorkspaceActiveForSend\(sessionID\)\)\) \{[\s\S]*recordSendTrace\("sendPrompt:blocked-scoped-workspace"\);[\s\S]*return false;[\s\S]*\}[\s\S]*resolvedDraft = await maybeResolveSkillCommand\(resolvedDraft\);/s,
    "scoped workspace activation should run during send before workspace-sensitive prompt routing",
  );
});

test("cross-workspace browse mode activates the selected workspace before session actions", () => {
  for (const [name, source] of [
    ["abortSession", abortSessionSource],
    ["compactCurrentSession", compactCurrentSessionSource],
    ["replaceUserMessage", replaceUserMessageSource],
    ["undoLastUserMessage", undoLastUserMessageSource],
    ["redoLastUserMessage", redoLastUserMessageSource],
    ["renameSessionTitle", renameSessionTitleSource],
  ] as const) {
    assert.notEqual(source, "", `${name} source should exist`);
    assertScopedWorkspaceGuardBeforeClient(source, name);
  }
});

test("opens cross-workspace session without activating the workspace", async () => {
  const opened: string[] = [];
  const activated: string[] = [];

  const result = await openSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-other",
    sessionId: "sess-2",
    activateWorkspace: async (id) => {
      activated.push(id);
      return false;
    },
    openSession: (id) => opened.push(id),
  });

  assert.equal(result, "opened");
  assert.deepEqual(activated, []);
  assert.deepEqual(opened, ["sess-2"]);
});

test("can opt pending placeholder navigation into workspace activation before opening", async () => {
  const opened: string[] = [];
  const activated: string[] = [];
  let activeWorkspaceId = "ws-active";

  const result = await openSessionWithWorkspaceActivation({
    activeWorkspaceId,
    getActiveWorkspaceId: () => activeWorkspaceId,
    workspaceId: "ws-other",
    sessionId: "pending-session:one",
    activateWorkspace: async (id) => {
      activated.push(id);
      activeWorkspaceId = id;
      return true;
    },
    activateWorkspaceBeforeOpen: true,
    openSession: (id) => opened.push(`${activeWorkspaceId}:${id}`),
  });

  assert.equal(result, "opened");
  assert.deepEqual(activated, ["ws-other"]);
  assert.deepEqual(opened, ["ws-other:pending-session:one"]);
});

test("serializes rapid cross-workspace session clicks and only opens the latest session", async () => {
  const opened: string[] = [];
  const activationEvents: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const activateWorkspace = async (id: string) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    activationEvents.push(`start:${id}`);
    concurrent -= 1;
    activationEvents.push(`end:${id}`);
    return true;
  };

  const first = openSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-one",
    sessionId: "sess-1",
    activateWorkspace,
    openSession: (id) => opened.push(id),
  });

  const second = openSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-two",
    sessionId: "sess-2",
    activateWorkspace,
    openSession: (id) => opened.push(id),
  });

  const firstResult = await first;
  const secondResult = await second;

  assert.equal(firstResult, "superseded");
  assert.equal(secondResult, "opened");
  assert.equal(maxConcurrent, 0);
  assert.deepEqual(activationEvents, []);
  assert.deepEqual(opened, ["sess-2"]);
});

test("does not create session when cross-workspace activation fails", async () => {
  const activated: string[] = [];
  const created: string[] = [];

  const result = await createSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-other",
    activateWorkspace: async (id) => {
      activated.push(id);
      return false;
    },
    createSession: async () => {
      created.push("created");
      return "sess-created";
    },
  });

  assert.equal(result, false);
  assert.deepEqual(activated, ["ws-other"]);
  assert.deepEqual(created, []);
});

test("creates session after successful cross-workspace activation", async () => {
  const activated: string[] = [];
  const created: string[] = [];

  const result = await createSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-other",
    activateWorkspace: async (id) => {
      activated.push(id);
      return true;
    },
    createSession: async () => {
      created.push("created");
      return "sess-created";
    },
  });

  assert.equal(result, true);
  assert.deepEqual(activated, ["ws-other"]);
  assert.deepEqual(created, ["created"]);
});

test("pending draft activation opens the workspace draft without creating a real session immediately", async () => {
  const activated: string[] = [];
  const openedDrafts: string[] = [];

  const result = await openPendingDraftWithWorkspaceActivation()({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-other",
    activateWorkspace: async (id) => {
      activated.push(id);
      return true;
    },
    openPendingDraft: async () => {
      openedDrafts.push("pending:ws-other");
      return "pending:ws-other";
    },
  });

  assert.equal(result, true);
  assert.deepEqual(activated, ["ws-other"]);
  assert.deepEqual(openedDrafts, ["pending:ws-other"]);
});

test("picker-driven directory session flow cancels cleanly when no folder is selected", async () => {
  const ensured: string[] = [];
  const activated: string[] = [];
  const created: string[] = [];

  const result = await createSessionFromDirectorySelection({
    activeWorkspaceId: "ws-active",
    pickDirectory: async () => null,
    ensureWorkspaceForFolder: async (folder) => {
      ensured.push(folder);
      return { id: "ws-folder" };
    },
    activateWorkspace: async (id) => {
      activated.push(id);
      return true;
    },
    createSession: async () => {
      created.push("created");
      return "sess-created";
    },
  });

  assert.equal(result, "cancelled");
  assert.deepEqual(ensured, []);
  assert.deepEqual(activated, []);
  assert.deepEqual(created, []);
});

test("picker-driven directory session flow reuses the ensured workspace and creates a session", async () => {
  const ensured: string[] = [];
  const activated: string[] = [];
  const created: string[] = [];
  let currentActive = "ws-active";

  const result = await createSessionFromDirectorySelection({
    activeWorkspaceId: currentActive,
    getActiveWorkspaceId: () => currentActive,
    pickDirectory: async () => "/tmp/project-a",
    ensureWorkspaceForFolder: async (folder) => {
      ensured.push(folder);
      return { id: "ws-project", path: folder };
    },
    activateWorkspace: async (id) => {
      activated.push(id);
      currentActive = id;
      return true;
    },
    createSession: async () => {
      created.push("created");
      return "sess-new";
    },
  });

  assert.equal(result, "created");
  assert.deepEqual(ensured, ["/tmp/project-a"]);
  assert.deepEqual(activated, ["ws-project"]);
  assert.deepEqual(created, ["created"]);
});

test("picker-driven directory session flow still activates when ensuring a new workspace mutates active workspace state", async () => {
  const ensured: string[] = [];
  const activated: string[] = [];
  const created: string[] = [];
  let currentActive = "ws-active";

  const result = await createSessionFromDirectorySelection({
    activeWorkspaceId: currentActive,
    getActiveWorkspaceId: () => currentActive,
    pickDirectory: async () => "/tmp/project-side-effect",
    ensureWorkspaceForFolder: async (folder) => {
      ensured.push(folder);
      // Mirrors createLocalWorkspace()/workspace_create: the new workspace is
      // registered as active before the engine switch has actually happened.
      currentActive = "ws-project-side-effect";
      return { id: currentActive, path: folder };
    },
    activateWorkspace: async (id) => {
      activated.push(id);
      return true;
    },
    createSession: async () => {
      created.push("created");
      return "sess-side-effect";
    },
  });

  assert.equal(result, "created");
  assert.deepEqual(ensured, ["/tmp/project-side-effect"]);
  assert.deepEqual(
    activated,
    ["ws-project-side-effect"],
    "creating a new workspace must still force activation before session creation",
  );
  assert.deepEqual(created, ["created"]);
});

test("picker-driven directory session flow stops when ensured workspace cannot activate", async () => {
  const ensured: string[] = [];
  const activated: string[] = [];
  const created: string[] = [];

  const result = await createSessionFromDirectorySelection({
    activeWorkspaceId: "ws-active",
    pickDirectory: async () => "/tmp/project-b",
    ensureWorkspaceForFolder: async (folder) => {
      ensured.push(folder);
      return { id: "ws-project-b", path: folder };
    },
    activateWorkspace: async (id) => {
      activated.push(id);
      return false;
    },
    createSession: async () => {
      created.push("created");
      return "sess-should-not-exist";
    },
  });

  assert.equal(result, "blocked");
  assert.deepEqual(ensured, ["/tmp/project-b"]);
  assert.deepEqual(activated, ["ws-project-b"]);
  assert.deepEqual(created, []);
});

test("picker-driven pending directory draft flow reopens the same target for the same normalized directory", async () => {
  const openedTargets: string[] = [];
  let currentActive = "ws-active";

  const openDirectoryDraft = openPendingDraftFromDirectorySelection();

  const first = await openDirectoryDraft({
    activeWorkspaceId: currentActive,
    getActiveWorkspaceId: () => currentActive,
    pickDirectory: async () => "/tmp/project-a/",
    ensureWorkspaceForFolder: async () => ({ id: "ws-project-a" }),
    activateWorkspace: async (id) => {
      currentActive = id;
      return true;
    },
    openPendingDraft: async ({ workspaceId, directory }) => {
      const target = resolvePendingDraftKey({ kind: "directory", workspaceId, directory });
      openedTargets.push(target);
      return target;
    },
  });

  currentActive = "ws-active";

  const second = await openDirectoryDraft({
    activeWorkspaceId: currentActive,
    getActiveWorkspaceId: () => currentActive,
    pickDirectory: async () => "/tmp/project-a",
    ensureWorkspaceForFolder: async () => ({ id: "ws-project-a" }),
    activateWorkspace: async (id) => {
      currentActive = id;
      return true;
    },
    openPendingDraft: async ({ workspaceId, directory }) => {
      const target = resolvePendingDraftKey({ kind: "directory", workspaceId, directory });
      openedTargets.push(target);
      return target;
    },
  });

  assert.equal(first, "opened");
  assert.equal(second, "opened");
  assert.equal(openedTargets[0], openedTargets[1]);
});

test("picker-driven pending directory draft flow keeps different projects on different targets", async () => {
  const openedTargets: string[] = [];
  let currentActive = "ws-active";

  const openDirectoryDraft = openPendingDraftFromDirectorySelection();

  const first = await openDirectoryDraft({
    activeWorkspaceId: currentActive,
    getActiveWorkspaceId: () => currentActive,
    pickDirectory: async () => "/tmp/project-shared",
    ensureWorkspaceForFolder: async () => ({ id: "ws-project-a" }),
    activateWorkspace: async (id) => {
      currentActive = id;
      return true;
    },
    openPendingDraft: async ({ workspaceId, directory }) => {
      const target = resolvePendingDraftKey({ kind: "directory", workspaceId, directory });
      openedTargets.push(target);
      return target;
    },
  });

  currentActive = "ws-active";

  const second = await openDirectoryDraft({
    activeWorkspaceId: currentActive,
    getActiveWorkspaceId: () => currentActive,
    pickDirectory: async () => "/tmp/project-shared",
    ensureWorkspaceForFolder: async () => ({ id: "ws-project-b" }),
    activateWorkspace: async (id) => {
      currentActive = id;
      return true;
    },
    openPendingDraft: async ({ workspaceId, directory }) => {
      const target = resolvePendingDraftKey({ kind: "directory", workspaceId, directory });
      openedTargets.push(target);
      return target;
    },
  });

  assert.equal(first, "opened");
  assert.equal(second, "opened");
  assert.notEqual(openedTargets[0], openedTargets[1]);
});

test("picker-driven pending directory draft flow publishes the workspace before activation", async () => {
  const events: string[] = [];
  let currentActive = "ws-active";

  const result = await openPendingDraftFromDirectorySelection()({
    activeWorkspaceId: currentActive,
    getActiveWorkspaceId: () => currentActive,
    pickDirectory: async () => "/tmp/project-visible-now",
    ensureWorkspaceForFolder: async (folder) => {
      events.push(`ensure:${folder}`);
      return { id: "ws-visible-now" };
    },
    activateWorkspace: async (id) => {
      events.push(`activate:${id}`);
      currentActive = id;
      return true;
    },
    openPendingDraft: async ({ workspaceId, directory }) => {
      events.push(`open:${workspaceId}:${directory}`);
      return "pending-visible-now";
    },
    onWorkspaceRegistered: ({ workspaceId, directory }) => {
      events.push(`registered:${workspaceId}:${directory}`);
    },
  });

  assert.equal(result, "opened");
  assert.deepEqual(events, [
    "ensure:/tmp/project-visible-now",
    "registered:ws-visible-now:/tmp/project-visible-now",
    "activate:ws-visible-now",
    "open:ws-visible-now:/tmp/project-visible-now",
  ]);
});

test("first New session creates one private workspace and opens a persisted pending draft", () => {
  assert.notEqual(openNewSessionSource, "", "New session flow should exist in app.tsx");
  assert.match(
    openNewSessionSource,
    /const newPrivatePendingDraftKey = resolvePendingDraftKey\(\{ kind: "new-private" \}\);[\s\S]*const pendingDrafts = \(await pendingSessionDraftsList\(\)\)\.filter\(\(draft\) => !isConsumedPendingDraftId\(draft\.id\)\);[\s\S]*const existingPendingDraft = pendingDrafts\.find\(\(draft\) => draft\.kind === "new-private"\) \?\? null;/s,
    "New session should look for an existing private pending draft before creating a workspace",
  );
  assert.match(
    openNewSessionSource,
    /const scratch = await workspaceStore\.createScratchWorkspace\(\);[\s\S]*const cleanupFreshScratchWorkspace = async \(\) => \{[\s\S]*const cleanupSucceeded = await workspaceStore\.forgetWorkspace\(scratch\.id, \{ deleteLocalData: true \}\);[\s\S]*if \(!cleanupSucceeded\) \{[\s\S]*throw new Error\(`Failed to clean up failed scratch workspace \$\{scratch\.id\}\.`\);[\s\S]*\}[\s\S]*\};[\s\S]*const emptyPendingDraft = createEmptyComposerDraft\(\);[\s\S]*const now = Date\.now\(\);[\s\S]*try \{[\s\S]*const activatedScratchWorkspace = await workspaceStore\.activateWorkspace\(scratch\.id\);[\s\S]*if \(!activatedScratchWorkspace\) \{[\s\S]*await cleanupFreshScratchWorkspace\(\);[\s\S]*return;[\s\S]*\}[\s\S]*const pendingDraft = await pendingSessionDraftsPut\(\{[\s\S]*kind: "new-private"[\s\S]*workspaceId: scratch\.id[\s\S]*privateWorkspaceId: scratch\.id[\s\S]*createdAt: now[\s\S]*updatedAt: now[\s\S]*composer: emptyPendingDraft[\s\S]*\}\);[\s\S]*setActivePendingDraftKey\(newPrivatePendingDraftKey\);[\s\S]*setActivePendingDraftMeta\(pendingDraft\);[\s\S]*setComposerDraftBySessionId\(\(current\) => setSessionComposerDraft\([\s\S]*?\{ storageKey: newPrivatePendingDraftKey \}[\s\S]*?emptyPendingDraft[\s\S]*?\)\);[\s\S]*setView\("session"\);[\s\S]*return;[\s\S]*\} catch \(error\) \{[\s\S]*await cleanupFreshScratchWorkspace\(\);[\s\S]*throw error;[\s\S]*\}/s,
    "the first New session should create one private workspace, persist one pending draft, and open the draft route",
  );
  assert.doesNotMatch(
    openNewSessionSource,
    /const pendingDraft = await pendingSessionDraftsPut\(\{[\s\S]*\}\);[\s\S]*const activatedScratchWorkspace = await workspaceStore\.activateWorkspace\(scratch\.id\);/s,
    "the fresh private pending draft must not be persisted before scratch workspace activation succeeds",
  );
});

test("second New session reopens the same pending draft and does not create another private workspace", () => {
  assert.notEqual(openNewSessionSource, "", "New session flow should exist in app.tsx");
  assert.match(
    openNewSessionSource,
    /if \(existingPendingDraft\) \{\s*const pendingDraft = await pendingSessionDraftsGet\(existingPendingDraft\.id\);[\s\S]*if \(pendingDraft\) \{\s*const restoreError = formatPendingDraftAttachmentRestoreError\(pendingDraft\.attachmentFailures\);[\s\S]*if \(restoreError\) \{\s*setError\(restoreError\);[\s\S]*\}\s*const pendingWorkspaceId = \(existingPendingDraft\.privateWorkspaceId \?\? existingPendingDraft\.workspaceId\)\.trim\(\);[\s\S]*const activatedPendingWorkspace = await workspaceStore\.activateWorkspace\(pendingWorkspaceId\);[\s\S]*if \(!activatedPendingWorkspace\) \{[\s\S]*await pendingSessionDraftsDelete\(existingPendingDraft\.id\);[\s\S]*markPendingDraftConsumed\(existingPendingDraft\.id\);[\s\S]*\} else \{[\s\S]*setActivePendingDraftKey\(newPrivatePendingDraftKey\);[\s\S]*setActivePendingDraftMeta\(existingPendingDraft\);[\s\S]*setComposerDraftBySessionId\(\(current\) => setSessionComposerDraft\([\s\S]*?\{ storageKey: newPrivatePendingDraftKey \}[\s\S]*?pendingDraft\.draft\.composer[\s\S]*?\)\);[\s\S]*setView\("session"\);[\s\S]*return;[\s\S]*\}[\s\S]*\}[\s\S]*\}/s,
    "repeat New session should reopen the existing private pending draft instead of creating a new workspace",
  );
  const existingBranchMatch = openNewSessionSource.match(/if \(existingPendingDraft\) \{[\s\S]*?return;\s*\}/);
  const existingBranch = existingBranchMatch?.[0] ?? "";
  assert.doesNotMatch(
    existingBranch,
    /createScratchWorkspace/,
    "reopening an existing private pending draft must not create another scratch workspace",
  );
  assert.doesNotMatch(
    openNewSessionSource,
    /deleteSessionComposerDraft\(current, null\)/,
    "repeat New session should not clear the draft bucket before reopening the same pending draft",
  );
});

test("New session skips stale existing private pending draft when workspace activation fails", () => {
  assert.notEqual(openNewSessionSource, "", "New session flow should exist in app.tsx");
  assert.match(
    openNewSessionSource,
    /const activatedPendingWorkspace = await workspaceStore\.activateWorkspace\(pendingWorkspaceId\);[\s\S]*if \(!activatedPendingWorkspace\) \{[\s\S]*await pendingSessionDraftsDelete\(existingPendingDraft\.id\);[\s\S]*markPendingDraftConsumed\(existingPendingDraft\.id\);[\s\S]*\} else \{[\s\S]*setActivePendingDraftKey\(newPrivatePendingDraftKey\);[\s\S]*setActivePendingDraftMeta\(existingPendingDraft\);[\s\S]*setView\("session"\);[\s\S]*return;[\s\S]*\}/s,
    "reopening an existing private pending draft must remove stale draft state and continue to fresh workspace creation when activation fails",
  );
  assert.match(
    openNewSessionSource,
    /const activatedScratchWorkspace = await workspaceStore\.activateWorkspace\(scratch\.id\);[\s\S]*if \(!activatedScratchWorkspace\) \{[\s\S]*await cleanupFreshScratchWorkspace\(\);[\s\S]*return;[\s\S]*\}[\s\S]*const pendingDraft = await pendingSessionDraftsPut\(\{[\s\S]*\}\);[\s\S]*setActivePendingDraftKey\(newPrivatePendingDraftKey\);[\s\S]*setActivePendingDraftMeta\(pendingDraft\);[\s\S]*setView\("session"\);/s,
    "creating a fresh private pending draft must stop before route activation when workspace activation fails",
  );
});

test("fresh New session cleans up the scratch workspace when activation or persistence throws", () => {
  assert.notEqual(openNewSessionSource, "", "New session flow should exist in app.tsx");
  assert.match(
    openNewSessionSource,
    /const cleanupFreshScratchWorkspace = async \(\) => \{[\s\S]*const cleanupSucceeded = await workspaceStore\.forgetWorkspace\(scratch\.id, \{ deleteLocalData: true \}\);[\s\S]*if \(!cleanupSucceeded\) \{[\s\S]*throw new Error\(`Failed to clean up failed scratch workspace \$\{scratch\.id\}\.`\);[\s\S]*\}[\s\S]*\};[\s\S]*try \{[\s\S]*const activatedScratchWorkspace = await workspaceStore\.activateWorkspace\(scratch\.id\);[\s\S]*const pendingDraft = await pendingSessionDraftsPut\(\{[\s\S]*\}\);[\s\S]*\} catch \(error\) \{[\s\S]*await cleanupFreshScratchWorkspace\(\);[\s\S]*throw error;[\s\S]*\}/s,
    "fresh New session must roll back the scratch workspace when activation or draft persistence throws",
  );
});

test("fresh New session surfaces cleanup failure instead of silently assuming rollback succeeded", () => {
  assert.notEqual(openNewSessionSource, "", "New session flow should exist in app.tsx");
  assert.match(
    openNewSessionSource,
    /const cleanupSucceeded = await workspaceStore\.forgetWorkspace\(scratch\.id, \{ deleteLocalData: true \}\);[\s\S]*if \(!cleanupSucceeded\) \{[\s\S]*throw new Error\(`Failed to clean up failed scratch workspace \$\{scratch\.id\}\.`\);[\s\S]*\}/s,
    "fresh New session must treat scratch-workspace cleanup failure as an error",
  );
});

test("picker-driven directory session flow forwards the selected path unchanged to workspace resolution", async () => {
  const ensured: string[] = [];

  const result = await createSessionFromDirectorySelection({
    activeWorkspaceId: "ws-active",
    pickDirectory: async () => "  /tmp/project with spaces  ",
    ensureWorkspaceForFolder: async (folder) => {
      ensured.push(folder);
      return null;
    },
    activateWorkspace: async () => true,
    createSession: async () => "sess-should-not-exist",
  });

  assert.equal(result, "blocked");
  assert.deepEqual(ensured, ["  /tmp/project with spaces  "]);
});

test("directory picker flow opens a pending draft instead of creating a real session immediately", () => {
  assert.notEqual(openDirectorySessionSource, "", "Directory picker flow should exist in app.tsx");
  assert.match(
    openDirectorySessionSource,
    /return await openPendingDraftFromDirectorySelection\(\{[\s\S]*pickDirectory: \(\) => workspaceStore\.pickWorkspaceFolder\(\),[\s\S]*ensureWorkspaceForFolder: workspaceStore\.ensureWorkspaceForFolder,[\s\S]*activateWorkspace: \(workspaceId\) => workspaceStore\.activateWorkspace\(workspaceId, \{ promoteToFront: true \}\),/s,
    "the picker flow should use the pending-draft navigation helper with the existing workspace activation contract",
  );
  assert.doesNotMatch(
    openDirectorySessionSource,
    /createSession: \(\) => createSessionAndOpen\(\)/,
    "the picker flow should stop creating real sessions immediately",
  );
});

test("directory picker flow publishes the registered workspace into the sidebar before continuing", () => {
  assert.notEqual(openDirectorySessionSource, "", "Directory picker flow should exist in app.tsx");
  assert.match(
    appSource,
    /const publishRegisteredWorkspaceToSidebar = \(workspaceId: string\) => \{[\s\S]*setSidebarSessionsByWorkspaceId\(\(prev\) =>[\s\S]*setSidebarSessionStatusByWorkspaceId\(\(prev\) =>[\s\S]*setSidebarSessionErrorByWorkspaceId\(\(prev\) =>[\s\S]*setSidebarSessionHasMoreByWorkspaceId\(\(prev\) =>/s,
    "app should expose a scoped sidebar publication helper for registered workspaces",
  );
  assert.match(
    appSource,
    /const projectKey = workspace\?\.workspaceType === "local"[\s\S]*workspaceStore\.isPrivateWorkspacePath\(projectKey\)[\s\S]*promoteStoredProjectOrderKey\(projectKey\)/s,
    "registered local workspaces should be promoted to the top of the by-project sidebar order",
  );
  assert.match(
    openDirectorySessionSource,
    /ensureWorkspaceForFolder: workspaceStore\.ensureWorkspaceForFolder,[\s\S]*onWorkspaceRegistered: \(\{ workspaceId \}\) => publishRegisteredWorkspaceToSidebar\(workspaceId\),[\s\S]*activateWorkspace: \(workspaceId\) => workspaceStore\.activateWorkspace\(workspaceId, \{ promoteToFront: true \}\),/s,
    "the picker flow should publish the registered workspace before the existing activation continuation",
  );
});

test("project plus resolves the directory after workspace activation instead of failing early on stale metadata", () => {
  assert.notEqual(
    openPendingDirectoryDraftInWorkspaceSource,
    "",
    "Project plus flow should exist in app.tsx",
  );
  assert.doesNotMatch(
    openPendingDirectoryDraftInWorkspaceSource,
    /const workspace =[\s\S]*const directory = workspace\?\.directory\?\.trim\(\) \|\| workspace\?\.path\?\.trim\(\) \|\| "";\s*if \(!directory\) return false;/s,
    "project plus should not depend on pre-activation directory metadata before it even tries to activate the workspace",
  );
  assert.match(
    openPendingDirectoryDraftInWorkspaceSource,
    /openPendingDraft: \(\) => \{[\s\S]*const activeWorkspace = workspaceStore\.activeWorkspaceDisplay\(\);[\s\S]*const directory = activeWorkspace\.directory\?\.trim\(\) \|\| activeWorkspace\.path\?\.trim\(\) \|\| "";\s*if \(!directory\) return "";\s*return openDirectoryPendingDraft\(\{ workspaceId: id, directory \}\);[\s\S]*\}/s,
    "project plus should resolve the directory from the activated workspace state right before opening the pending draft",
  );
});

test("fresh directory pending drafts use collision-resistant ids", () => {
  assert.notEqual(openDirectoryPendingDraftSource, "", "Directory pending draft flow should exist in app.tsx");
  assert.doesNotMatch(
    openDirectoryPendingDraftSource,
    /id: `pending-directory-\$\{workspaceId\}-\$\{now\}`/,
    "fresh directory drafts should not rely on workspace id plus millisecond clock for uniqueness",
  );
  assert.match(
    openDirectoryPendingDraftSource,
    /typeof crypto !== "undefined" && typeof crypto\.randomUUID === "function"[\s\S]*crypto\.randomUUID\(\)[\s\S]*Math\.random\(\)\.toString\(16\)\.slice\(2\)/s,
    "fresh directory drafts should add a collision-resistant suffix independent of clock granularity",
  );
});

// ---------------------------------------------------------------------------
// Rapid back-and-forth session browsing stress tests
//
// These reproduce the freeze that occurs when users click back and forth
// between sessions/projects several times in quick succession.
// ---------------------------------------------------------------------------

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

test("rapid back-and-forth between two workspaces completes without hanging", async () => {
  const TIMEOUT_MS = 3_000;
  const opened: string[] = [];
  const activations: string[] = [];
  let currentActive = "ws-A";

  const activateWorkspace = async (id: string) => {
    activations.push(id);
    // This should never run for existing-session browsing.
    await delay(50);
    currentActive = id;
    return true;
  };

  const clicks: Promise<"opened" | "blocked" | "superseded">[] = [];

  // Simulate 10 rapid back-and-forth clicks between ws-A and ws-B
  for (let i = 0; i < 10; i++) {
    const targetWs = i % 2 === 0 ? "ws-B" : "ws-A";
    const sessionId = `sess-${i}`;
    clicks.push(
      openSessionWithWorkspaceActivation({
        activeWorkspaceId: currentActive,
        getActiveWorkspaceId: () => currentActive,
        workspaceId: targetWs,
        sessionId,
        activateWorkspace,
        openSession: (id) => opened.push(id),
      }),
    );
  }

  // Must settle within the timeout — if it hangs, the test fails
  const results = await Promise.race([
    Promise.all(clicks),
    delay(TIMEOUT_MS).then(() => {
      throw new Error(
        `Rapid back-and-forth switching did not settle within ${TIMEOUT_MS}ms — system froze`,
      );
    }),
  ]);

  // Only the last click should have actually opened a session
  assert.equal(results[results.length - 1], "opened", "last click should succeed");
  assert.ok(opened.length >= 1, "at least one session must be opened");
  assert.equal(opened[opened.length - 1], "sess-9", "the last opened session should be the final click");
  assert.deepEqual(activations, [], "existing-session browsing must not activate workspaces");
});

test("rapid back-and-forth ignores slow activation callbacks for existing sessions", async () => {
  const TIMEOUT_MS = 5_000;
  const opened: string[] = [];
  const activationStarts: string[] = [];
  const activationEnds: string[] = [];
  let currentActive = "ws-A";
  let concurrentActivations = 0;
  let maxConcurrent = 0;

  const activateWorkspace = async (id: string) => {
    concurrentActivations++;
    maxConcurrent = Math.max(maxConcurrent, concurrentActivations);
    activationStarts.push(id);
    // This should never run for existing-session browsing.
    await delay(200);
    activationEnds.push(id);
    concurrentActivations--;
    currentActive = id;
    return true;
  };

  const clicks: Promise<"opened" | "blocked" | "superseded">[] = [];

  // 7 rapid back-and-forth clicks. Existing-session browsing should stay
  // navigation-only even when the target workspace differs from the active one.
  for (let i = 0; i < 7; i++) {
    const targetWs = i % 2 === 0 ? "ws-B" : "ws-A";
    clicks.push(
      openSessionWithWorkspaceActivation({
        activeWorkspaceId: currentActive,
        getActiveWorkspaceId: () => currentActive,
        workspaceId: targetWs,
        sessionId: `sess-${i}`,
        activateWorkspace,
        openSession: (id) => opened.push(id),
      }),
    );
  }

  const results = await Promise.race([
    Promise.all(clicks),
    delay(TIMEOUT_MS).then(() => {
      throw new Error(
        `Slow-activation back-and-forth browsing did not settle within ${TIMEOUT_MS}ms — system froze`,
      );
    }),
  ]);

  assert.equal(maxConcurrent, 0, "existing-session browsing must not activate workspaces");
  assert.deepEqual(activationStarts, []);
  assert.deepEqual(activationEnds, []);
  assert.equal(results[results.length - 1], "opened");
  assert.ok(opened.length >= 1);
  assert.equal(opened[opened.length - 1], "sess-6");
});

test("rapid switching among three workspaces (regular + temp folder) settles", async () => {
  const TIMEOUT_MS = 3_000;
  const opened: string[] = [];
  let currentActive = "ws-regular-1";

  const workspaceIds = ["ws-regular-1", "ws-regular-2", "ws-temp-folder"];

  const activateWorkspace = async (id: string) => {
    await delay(30);
    currentActive = id;
    return true;
  };

  const clicks: Promise<"opened" | "blocked" | "superseded">[] = [];

  // 12 rapid clicks cycling through 3 workspaces
  for (let i = 0; i < 12; i++) {
    const targetWs = workspaceIds[i % workspaceIds.length];
    clicks.push(
      openSessionWithWorkspaceActivation({
        activeWorkspaceId: currentActive,
        getActiveWorkspaceId: () => currentActive,
        workspaceId: targetWs,
        sessionId: `sess-${i}`,
        activateWorkspace,
        openSession: (id) => opened.push(id),
      }),
    );
  }

  const results = await Promise.race([
    Promise.all(clicks),
    delay(TIMEOUT_MS).then(() => {
      throw new Error(
        `Three-workspace rapid switching did not settle within ${TIMEOUT_MS}ms — system froze`,
      );
    }),
  ]);

  assert.equal(results[results.length - 1], "opened");
  assert.ok(opened.length >= 1);
  assert.equal(opened[opened.length - 1], "sess-11");
});

test("rapid back-and-forth createSession does not hang", async () => {
  const TIMEOUT_MS = 3_000;
  const created: string[] = [];
  let currentActive = "ws-A";
  let sessionCounter = 0;

  const activateWorkspace = async (id: string) => {
    await delay(40);
    currentActive = id;
    return true;
  };

  const clicks: Promise<boolean>[] = [];

  for (let i = 0; i < 8; i++) {
    const targetWs = i % 2 === 0 ? "ws-B" : "ws-A";
    clicks.push(
      createSessionWithWorkspaceActivation({
        activeWorkspaceId: currentActive,
        getActiveWorkspaceId: () => currentActive,
        workspaceId: targetWs,
        activateWorkspace,
        createSession: async () => {
          const id = `created-${++sessionCounter}`;
          created.push(id);
          return id;
        },
      }),
    );
  }

  const results = await Promise.race([
    Promise.all(clicks),
    delay(TIMEOUT_MS).then(() => {
      throw new Error(
        `Rapid createSession back-and-forth did not settle within ${TIMEOUT_MS}ms — system froze`,
      );
    }),
  ]);

  assert.equal(results[results.length - 1], true);
  assert.ok(created.length >= 1);
});

test("activation failure callback is ignored during rapid existing-session browsing", async () => {
  const TIMEOUT_MS = 3_000;
  const opened: string[] = [];
  let currentActive = "ws-A";
  let callCount = 0;

  const activateWorkspace = async (id: string) => {
    callCount++;
    await delay(30);
    // This should never run for existing-session browsing.
    if (callCount % 2 === 0) return false;
    currentActive = id;
    return true;
  };

  const clicks: Promise<"opened" | "blocked" | "superseded">[] = [];

  for (let i = 0; i < 8; i++) {
    const targetWs = i % 2 === 0 ? "ws-B" : "ws-A";
    clicks.push(
      openSessionWithWorkspaceActivation({
        activeWorkspaceId: currentActive,
        getActiveWorkspaceId: () => currentActive,
        workspaceId: targetWs,
        sessionId: `sess-${i}`,
        activateWorkspace,
        openSession: (id) => opened.push(id),
      }),
    );
  }

  const results = await Promise.race([
    Promise.all(clicks),
    delay(TIMEOUT_MS).then(() => {
      throw new Error(
        `Queue did not drain after activation failures within ${TIMEOUT_MS}ms — system froze`,
      );
    }),
  ]);

  assert.ok(Array.isArray(results), "all promises must settle");
  assert.equal(callCount, 0, "existing-session browsing must not activate workspaces");
  assert.equal(opened[opened.length - 1], "sess-7");
});

test("activation throwing callback is ignored during rapid existing-session browsing", async () => {
  const TIMEOUT_MS = 3_000;
  const opened: string[] = [];
  let currentActive = "ws-A";
  let callCount = 0;

  const activateWorkspace = async (id: string) => {
    callCount++;
    await delay(20);
    // This should never run for existing-session browsing.
    if (callCount % 3 === 0) throw new Error("Connection lost");
    currentActive = id;
    return true;
  };

  const clicks: Promise<"opened" | "blocked" | "superseded">[] = [];

  for (let i = 0; i < 10; i++) {
    const targetWs = i % 2 === 0 ? "ws-B" : "ws-A";
    clicks.push(
      openSessionWithWorkspaceActivation({
        activeWorkspaceId: currentActive,
        getActiveWorkspaceId: () => currentActive,
        workspaceId: targetWs,
        sessionId: `sess-${i}`,
        activateWorkspace,
        openSession: (id) => opened.push(id),
      }).catch(() => "blocked"),
    );
  }

  const results = await Promise.race([
    Promise.all(clicks),
    delay(TIMEOUT_MS).then(() => {
      throw new Error(
        `Queue did not drain after activation errors within ${TIMEOUT_MS}ms — system froze`,
      );
    }),
  ]);

  assert.ok(Array.isArray(results), "all promises must settle");
  assert.equal(callCount, 0, "existing-session browsing must not activate workspaces");
  assert.equal(opened[opened.length - 1], "sess-9");
});
