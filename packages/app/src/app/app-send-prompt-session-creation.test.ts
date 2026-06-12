import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("./types.ts", import.meta.url), "utf8");

test("sendPrompt keeps the session id returned by createSessionAndOpen before prompting", () => {
  assert.match(
    source,
    /const selectedSessionCandidate = selectedSessionId\(\);\s*const selectedRealSessionId = isPendingSessionInstanceId\(selectedSessionCandidate\) \? null : selectedSessionCandidate;\s*let sessionID = isPendingSessionInstanceId\(options\.targetSessionId\) \? null : options\.targetSessionId\?\.trim\(\) \|\| selectedRealSessionId;\s*[\s\S]*?const initialSessionTitle = resolvedDraft\.text\.trim\(\);\s*const initialContent = \(resolvedDraft\.resolvedText \?\? resolvedDraft\.text\)\.trim\(\);[\s\S]*?if \(!sessionID\) \{\s*recordSendTrace\("sendPrompt:create-session-needed"\);[\s\S]*const createdSessionId = await createSessionAndOpen\(initialSessionTitle, \{[\s\S]*pendingSession: pendingSidebarSession,[\s\S]*\}\);[\s\S]*const materializedSessionId = createdSessionId\?\.trim\(\);[\s\S]*if \(materializedSessionId\) \{\s*sessionID = materializedSessionId;\s*options\.onMaterializedSessionId\?\.\(materializedSessionId\);[\s\S]*\} else \{\s*const selectedAfterCreate = selectedSessionId\(\);[\s\S]*sessionID = isPendingSessionInstanceId\(selectedAfterCreate\) \? null : selectedAfterCreate;[\s\S]*\}\s*\}\s*if \(!sessionID\) \{\s*recordSendTrace\("sendPrompt:blocked-no-session"\);\s*stopSendPromptBusy\(\);\s*return false;\s*\}/s,
    "sendPrompt should use the session id returned by createSessionAndOpen so the first prompt is not dropped while selection state catches up",
  );
});

test("sidebar session items can represent UI-only pending session placeholders", () => {
  assert.match(
    typesSource,
    /export type PendingSidebarSessionMetadata = \{[\s\S]*id: string;[\s\S]*workspaceId: string;[\s\S]*workspaceRoot: string;[\s\S]*title: string;[\s\S]*createdAt: number;[\s\S]*\};/,
    "pending sidebar metadata should capture the pending id, workspace id/root, title, and creation time",
  );
  assert.match(
    typesSource,
    /pendingSessionInstanceId\?: string \| null;/,
    "sidebar rows should carry the pending session instance id used for materialization",
  );
  assert.match(
    typesSource,
    /pending\?: boolean;/,
    "sidebar rows should mark pending placeholders as UI-only",
  );
});

test("sendPrompt registers pending sidebar metadata before creating the first real session", () => {
  const sendPromptStart = source.indexOf("  async function sendPrompt(");
  const sendPromptEnd = source.indexOf("  async function abortSession(", sendPromptStart);
  assert.ok(sendPromptStart >= 0 && sendPromptEnd > sendPromptStart, "sendPrompt should exist");
  const sendPromptSource = source.slice(sendPromptStart, sendPromptEnd);

  assert.match(
    source,
    /import type \{[\s\S]*PendingSidebarSessionMetadata[\s\S]*\} from "\.\/types";/,
    "app should share the pending sidebar metadata type with SessionView",
  );
  assert.match(
    source,
    /import \{ isPendingSessionInstanceId \} from "\.\/components\/session\/pending-session-instance-model";/,
    "app should guard pending-session ids before treating selected ids as real sessions",
  );
  assert.match(
    sendPromptSource,
    /options: \{[\s\S]*pendingSession\?: PendingSidebarSessionMetadata \| null;[\s\S]*\} = \{\},/,
    "sendPrompt options should accept pending sidebar metadata",
  );
  assert.match(
    sendPromptSource,
    /const pendingSidebarSession = options\.pendingSession \?\? null;/,
    "sendPrompt should snapshot pending sidebar metadata for this handoff",
  );
  assert.match(
    sendPromptSource,
    /const pendingSidebarSession = options\.pendingSession \?\? null;\s*if \(!sessionID && pendingSidebarSession\) \{\s*registerPendingSidebarSession\(pendingSidebarSession\);\s*\}[\s\S]*const createdSessionId = await createSessionAndOpen\(initialSessionTitle, \{[\s\S]*pendingSession: pendingSidebarSession,/,
    "sendPrompt should register the placeholder before blocking preflight work and pass the same metadata into createSessionAndOpen",
  );
  assert.ok(
    sendPromptSource.indexOf("registerPendingSidebarSession(pendingSidebarSession)") <
      sendPromptSource.indexOf("resolvedDraft = await maybeResolveSkillCommand(resolvedDraft);"),
    "pending first-send rows should be registered before skill-command resolution or runtime preflight can delay session creation",
  );
});

test("app registers and materializes sidebar pending placeholders by pending instance id", () => {
  assert.match(
    source,
    /const registerPendingSidebarSession = \(pendingSession: PendingSidebarSessionMetadata \| null \| undefined\) => \{[\s\S]*if \(!isPendingSessionInstanceId\(pendingId\) \|\| !workspaceId\) return;[\s\S]*const placeholder: SidebarSessionItem = \{[\s\S]*id: pendingId,[\s\S]*title,[\s\S]*time: \{ created: createdAt, updated: createdAt \},[\s\S]*directory: workspaceRoot \|\| null,[\s\S]*pending: true,[\s\S]*pendingSessionInstanceId: pendingId,[\s\S]*\};[\s\S]*setSidebarSessionsByWorkspaceId\(\(prev\) => \(\{[\s\S]*\[workspaceId\]: upsertPendingSidebarPlaceholder\(prev\[workspaceId\] \?\? \[\], placeholder\),[\s\S]*\}\)\);[\s\S]*\};/,
    "registerPendingSidebarSession should insert one UI-only placeholder row in the captured workspace group",
  );
  assert.match(
    source,
    /const materializePendingSidebarSession = \(\s*workspaceId: string,[\s\S]*pendingSession: PendingSidebarSessionMetadata \| null \| undefined,[\s\S]*realSession: SidebarSessionItem,[\s\S]*\) => \{[\s\S]*\[id\]: materializePendingSidebarRows\(prev\[id\] \?\? \[\], pendingSession, realSession\),[\s\S]*\};/,
    "materializePendingSidebarSession should replace only the matching pending row in the target workspace",
  );
  assert.match(
    source,
    /const materializePendingSidebarRows = \([\s\S]*pendingSession: PendingSidebarSessionMetadata \| null \| undefined,[\s\S]*realSession: SidebarSessionItem,[\s\S]*\): SidebarSessionItem\[\] => \{[\s\S]*const pendingId = pendingSession\?\.id\?\.trim\(\) \?\? "";[\s\S]*if \(pendingId && rowPendingId === pendingId\) \{[\s\S]*return realSession;[\s\S]*\}[\s\S]*if \(row\.id\.trim\(\) === realSessionId\) \{[\s\S]*return realSession;[\s\S]*\}[\s\S]*return \[realSession, \.\.\.deduped\];[\s\S]*\};/,
    "materialization should dedupe by both pending instance id and real session id",
  );
});

test("materialized pending sidebar rows remain visible until passive history lists the real session", () => {
  const mergeStart = source.indexOf("  const mergeSidebarRowsPreservingPendingPlaceholders = (");
  const mergeEnd = source.indexOf("  const materializePendingSidebarRows = (", mergeStart);
  assert.ok(mergeStart >= 0 && mergeEnd > mergeStart, "sidebar merge source should be present");
  const mergeSource = source.slice(mergeStart, mergeEnd);

  assert.match(
    mergeSource,
    /const retainedPendingRows = existingRows\.filter\(\(row\) => \{[\s\S]*if \(!row\.pending && !row\.pendingSessionInstanceId\) return false;[\s\S]*if \(id && incomingIds\.has\(id\)\) return false;[\s\S]*if \(pendingId && incomingPendingIds\.has\(pendingId\)\) return false;[\s\S]*return true;[\s\S]*\}\);/s,
    "sidebar refreshes should preserve both pending placeholders and just-materialized pending rows until the read model includes them",
  );

  const createStart = source.indexOf("async function createSessionAndOpen(");
  const createEnd = source.indexOf("const openNewSessionWithDirectory = async () =>", createStart);
  assert.ok(createStart >= 0 && createEnd > createStart, "createSessionAndOpen source should be present");
  const createSource = source.slice(createStart, createEnd);

  assert.match(
    createSource,
    /const pendingInstanceId = pendingSidebarSession\?\.id\?\.trim\(\) \|\| null;[\s\S]*const newItem: SidebarSessionItem = \{[\s\S]*pendingSessionInstanceId: pendingInstanceId,[\s\S]*\};/s,
    "materialized rows should keep the originating pending instance id so async sidebar refreshes do not erase them",
  );
});

test("createSessionAndOpen chooses sidebar workspace from pending metadata before fallbacks", () => {
  const createStart = source.indexOf("async function createSessionAndOpen(");
  const createEnd = source.indexOf("const openNewSessionWithDirectory = async () =>", createStart);
  assert.ok(createStart >= 0 && createEnd > createStart, "createSessionAndOpen source should be present");
  const createSource = source.slice(createStart, createEnd);

  assert.match(
    createSource,
    /options: \{[\s\S]*pendingSession\?: PendingSidebarSessionMetadata \| null;[\s\S]*\} = \{\},/,
    "createSessionAndOpen should accept pending metadata for this handoff",
  );
  assert.match(
    createSource,
    /const pendingSidebarSession = options\.pendingSession \?\? null;/,
    "createSessionAndOpen should snapshot pending metadata",
  );
  assert.match(
    createSource,
    /const wsId = pendingSidebarSession\?\.workspaceId\?\.trim\(\) \|\|\s*resolveSidebarWorkspaceIdForSession\(displaySession\) \|\|\s*\(workspaceStore\.connectingWorkspaceId\(\) \?\? workspaceStore\.activeWorkspaceId\(\)\)\.trim\(\);/,
    "createSessionAndOpen should choose sidebar workspace id from pending metadata, then session context, then active workspace",
  );
  assert.match(
    createSource,
    /materializePendingSidebarSession\(wsId, pendingSidebarSession, newItem\);/,
    "createSessionAndOpen should replace the matching pending placeholder instead of blindly prepending",
  );
});

test("pending-session routes select local pending state without transcript APIs", () => {
  const routeStart = source.indexOf('    if (path.startsWith("/session")) {');
  const routeEnd = source.indexOf('    if (path.startsWith("/proto-v1-ux")) {', routeStart);
  assert.notEqual(routeStart, -1, "session route block should exist");
  assert.notEqual(routeEnd, -1, "session route block should end before proto route");
  const routeSource = source.slice(routeStart, routeEnd);

  assert.match(
    routeSource,
    /if \(isPendingSessionInstanceId\(id\)\) \{\s*if \(selectedSessionId\(\) !== id\) \{\s*setSelectedSessionId\(id\);\s*\}[\s\S]*setPendingSessionLoad\(null\);[\s\S]*return;\s*\}/,
    "pending-session routes should select local pending state and skip selectSession",
  );
  assert.doesNotMatch(
    routeSource,
    /if \(isPendingSessionInstanceId\(id\)\) \{[\s\S]*setMessages\(\[\]\);\s*setTodos\(\[\]\);[\s\S]*setSelectedSessionId\(id\);/s,
    "pending-session routes should not delete cached real-session transcripts",
  );
  const pendingRouteIndex = routeSource.indexOf("if (isPendingSessionInstanceId(id)) {");
  const realSelectIndex = routeSource.indexOf("void selectSession(id);");
  assert.ok(
    pendingRouteIndex >= 0 && realSelectIndex > pendingRouteIndex,
    "route selection should check pending-session ids before selecting real sessions",
  );

  const resumeStart = source.indexOf("  let lastRouteClientResumeKey = \"\";");
  const resumeEnd = source.indexOf("  createEffect(() => {\n    const active = workspaceStore.activeWorkspaceDisplay();", resumeStart);
  assert.notEqual(resumeStart, -1, "route resume effect should exist");
  assert.notEqual(resumeEnd, -1, "route resume effect should end before active workspace effect");
  const resumeSource = source.slice(resumeStart, resumeEnd);
  assert.match(
    resumeSource,
    /if \(isPendingSessionInstanceId\(id\)\) \{\s*lastRouteClientResumeKey = connectionKey;\s*return;\s*\}/,
    "route resume effect should not load pending-session ids through selectSession",
  );
});

test("setView selects pending session ids before routing", () => {
  assert.match(
    source,
    /const setView = \(next: View, sessionId\?: string\) => \{[\s\S]*if \(next === "session"\) \{[\s\S]*if \(sessionId\) \{[\s\S]*const trimmedSessionId = sessionId\.trim\(\);[\s\S]*if \(isPendingSessionInstanceId\(sessionId\)\) \{\s*setSelectedSessionId\(trimmedSessionId\);\s*\} else \{[\s\S]*clearActivePendingDraftState\(\);[\s\S]*setSelectedSessionId\(trimmedSessionId\);[\s\S]*\}[\s\S]*goToSession\(trimmedSessionId\);[\s\S]*return;[\s\S]*\}/s,
    "pending sidebar rows should become the selected local session before hash routing settles",
  );
});

test("createSessionAndOpen persists the first composer text as the initial backend title", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("const openNewSessionWithDirectory = async () =>");
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");

  const createSessionAndOpenSource = source.slice(start, end);
  assert.match(
    createSessionAndOpenSource,
    /const initialSessionTitle = initialTitle\.trim\(\);/,
    "createSessionAndOpen should trim the prompt before using it as the local temporary title",
  );
  assert.match(
    createSessionAndOpenSource,
    /createConversationFromVesloWriteApi\(\s*activeWorkspaceId,\s*initialSessionTitle \|\| undefined,\s*\{\s*directory: sessionDirectory,\s*\},\s*\);/s,
    "createSessionAndOpen should persist the first composer text and captured directory as the backend session title/scope",
  );
  assert.doesNotMatch(
    createSessionAndOpenSource,
    /c\.session\.create\(/,
    "createSessionAndOpen must not directly create OpenCode sessions from the UI",
  );
  assert.match(
    createSessionAndOpenSource,
    /registerPendingInitialSessionTitle\(session\.id, initialSessionTitle\);[\s\S]*const sessionForStore = session\.directory\?\.trim\(\) \? session : \{ \.\.\.session, directory: sessionDirectory \};[\s\S]*const displaySession = applyPendingInitialSessionTitle\(sessionForStore\);/,
    "createSessionAndOpen should register the prompt title locally and render it optimistically",
  );
});

test("createConversationFromVesloWriteApi uses captured workspace route instead of the current active workspace", () => {
  const createStart = source.indexOf("  const createConversationFromVesloWriteApi = async (");
  const createEnd = source.indexOf("  const runConversationFromVesloWriteApi = async (", createStart);
  assert.ok(createStart >= 0 && createEnd > createStart, "createConversationFromVesloWriteApi source should be present");
  const createSource = source.slice(createStart, createEnd);

  assert.match(
    createSource,
    /options: \{\s*directory\?: string \| null;\s*\} = \{\}/s,
    "conversation creation should accept a captured directory from the pending/session flow",
  );
  assert.match(
    createSource,
    /const workspaceRoot = options\.directory\?\.trim\(\) \|\| workspaceStore\.activeWorkspaceRoot\(\)\.trim\(\);/s,
    "conversation creation should prefer the captured directory over the active workspace root",
  );
  assert.match(
    createSource,
    /const routeEntry = workspaceRouting\.entry\(workspaceId\);[\s\S]*const workspaceRuntimeBaseUrl = routeEntry\?\.baseUrl\?\.trim\(\) \|\| activeWorkspaceRuntimeBaseUrl;[\s\S]*await syncConversationWorkspaceRuntimeRoute\(\s*client,\s*serverWorkspaceId,\s*workspaceRoot,\s*workspaceRuntimeBaseUrl,\s*\);/s,
    "conversation creation should sync the Veslo server route from the captured workspace routing entry or checked active fallback",
  );
});

test("createConversationFromVesloWriteApi synchronizes runtime route before creating the server conversation", () => {
  const helperStart = source.indexOf("  const syncConversationWorkspaceRuntimeRoute = async (");
  const helperEnd = source.indexOf("  const createConversationFromVesloWriteApi = async (", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "runtime route sync helper should be present before conversation creation");
  const helperSource = source.slice(helperStart, helperEnd);
  assert.match(
    helperSource,
    /await serverClient\.updateWorkspace\(normalizedWorkspaceId,\s*\{[\s\S]*baseUrl: runtimeBaseUrl,[\s\S]*directory: runtimeDirectory,[\s\S]*\}\);/s,
    "the server workspace registry should receive the scoped OpenCode baseUrl and active directory before session creation",
  );

  const createStart = source.indexOf("  const createConversationFromVesloWriteApi = async (");
  const createEnd = source.indexOf("  const runConversationFromVesloWriteApi = async (", createStart);
  assert.ok(createStart >= 0 && createEnd > createStart, "createConversationFromVesloWriteApi source should be present");
  const createSource = source.slice(createStart, createEnd);
  const syncIndex = createSource.indexOf("await syncConversationWorkspaceRuntimeRoute(");
  const createIndex = createSource.indexOf("client.createConversation(");
  assert.ok(
    syncIndex >= 0 && createIndex > syncIndex,
    "the workspace route must be synchronized before the server tries to proxy OpenCode session creation",
  );
  assert.match(
    createSource,
    /client\.createConversation\(serverWorkspaceId,\s*\{\s*directory: workspaceRoot \|\| undefined,\s*title,\s*\}\);/s,
    "conversation creation should carry the active workspace directory explicitly",
  );
});

test("createConversationFromVesloWriteApi does not route a captured workspace through another active workspace url", () => {
  const helperStart = source.indexOf("  const syncConversationWorkspaceRuntimeRoute = async (");
  const helperEnd = source.indexOf("  const isLocalVesloServerAuthError = (error: unknown) =>", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "syncConversationWorkspaceRuntimeRoute helper should be present");
  const helperSource = source.slice(helperStart, helperEnd);

  assert.doesNotMatch(
    helperSource,
    /baseUrlOverride\?\.trim\(\) \|\| baseUrl\(\)\.trim\(\)/,
    "captured conversation creation must not silently fall back to whichever workspace is globally active",
  );

  const createStart = source.indexOf("  const createConversationFromVesloWriteApi = async (");
  const createEnd = source.indexOf("  const runConversationFromVesloWriteApi = async (", createStart);
  assert.ok(createStart >= 0 && createEnd > createStart, "createConversationFromVesloWriteApi source should be present");
  const createSource = source.slice(createStart, createEnd);

  assert.match(
    createSource,
    /const activeWorkspaceRuntimeBaseUrl =\s*workspaceId === workspaceStore\.activeWorkspaceId\(\)\.trim\(\)[\s\S]*\? baseUrl\(\)\.trim\(\)[\s\S]*: "";[\s\S]*const workspaceRuntimeBaseUrl = routeEntry\?\.baseUrl\?\.trim\(\) \|\| activeWorkspaceRuntimeBaseUrl;/s,
    "conversation creation should use the captured route entry or a checked active-workspace fallback only",
  );
  assert.match(
    createSource,
    /await syncConversationWorkspaceRuntimeRoute\(\s*client,\s*serverWorkspaceId,\s*workspaceRoot,\s*workspaceRuntimeBaseUrl,\s*\);/s,
    "the checked runtime url should be the only value passed into server route sync",
  );
});

test("sendPrompt re-asserts the pending workspace and requires its routing entry at the engine gate", () => {
  const sendPromptStart = source.indexOf("  async function sendPrompt(");
  const sendPromptEnd = source.indexOf("  async function abortSession(", sendPromptStart);
  assert.ok(sendPromptStart >= 0 && sendPromptEnd > sendPromptStart, "sendPrompt should exist");
  const sendPromptSource = source.slice(sendPromptStart, sendPromptEnd);

  assert.match(
    sendPromptSource,
    /if \(!\(await ensurePendingDraftWorkspaceActiveForSend\(pendingDraftSendState\)\)\) \{\s*recordSendTrace\("sendPrompt:blocked-pending-workspace-stale"\);\s*stopSendPromptBusy\(\);\s*return false;\s*\}[\s\S]*?const sendRuntimeWorkspaceId = workspaceStore\.activeWorkspaceId\(\)\.trim\(\);\s*if \(!engineReady\(\) \|\| \(sendRuntimeWorkspaceId && !workspaceRouting\.entry\(sendRuntimeWorkspaceId\)\)\) \{/s,
    "first-send must re-assert the pending draft workspace after managed-AI readiness and ensure the engine when the send target has no per-workspace routing entry, otherwise conversation creation has no runtime route to register and the server rejects it with opencode_unconfigured",
  );
});

test("createConversationFromVesloWriteApi refreshes local server auth and retries stale host-token writes", () => {
  const refreshStart = source.indexOf("  const refreshLocalVesloServerAuthForWrite = async () => {");
  const refreshEnd = source.indexOf("  const createConversationFromVesloWriteApi = async (", refreshStart);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, "local server auth refresh helper should be present before conversation creation");
  const refreshSource = source.slice(refreshStart, refreshEnd);

  assert.match(
    refreshSource,
    /const info = await vesloServerInfo\(\);[\s\S]*setVesloServerHostInfo\(info\);[\s\S]*const result = await checkVesloServer\([\s\S]*running\.baseUrl\.trim\(\),[\s\S]*running\.clientToken\?\.trim\(\) \|\| undefined,[\s\S]*running\.hostToken\?\.trim\(\) \|\| undefined,[\s\S]*\);/s,
    "local auth refresh should read the live Tauri server info and validate the matching client/host tokens",
  );

  const createStart = source.indexOf("  const createConversationFromVesloWriteApi = async (");
  const createEnd = source.indexOf("  const runConversationFromVesloWriteApi = async (", createStart);
  assert.ok(createStart >= 0 && createEnd > createStart, "createConversationFromVesloWriteApi source should be present");
  const createSource = source.slice(createStart, createEnd);

  assert.match(
    createSource,
    /try \{\s*return await createConversationWithClient\(serverClient\);[\s\S]*\} catch \(error\) \{[\s\S]*if \(!isLocalVesloServerAuthError\(error\)\) throw error;[\s\S]*const refreshed = await refreshLocalVesloServerAuthForWrite\(\);[\s\S]*if \(!refreshed\) throw error;[\s\S]*const retryClient = vesloServerClient\(\);[\s\S]*if \(!retryClient\) throw error;[\s\S]*return await createConversationWithClient\(retryClient\);[\s\S]*\}/s,
    "stale local host-token writes should refresh local auth and retry the captured conversation create once",
  );
});
