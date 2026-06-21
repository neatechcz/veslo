import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("local Veslo server ensure is not gated by an existing OpenCode client", () => {
  const effectStart = source.indexOf('let lastLocalVesloEnsureKey = "";');
  assert.notStrictEqual(effectStart, -1, "local Veslo server ensure effect is missing");

  const ensureCall = "void ensureLocalVesloServerRunning()";
  const ensureIdx = source.indexOf(ensureCall, effectStart);
  assert.notStrictEqual(ensureIdx, -1, "local Veslo server ensure call is missing");

  const effectGuards = source.slice(effectStart, ensureIdx);
  assert.doesNotMatch(
    effectGuards,
    /if\s*\(\s*!routedClient\(\)\s*\)\s*return/,
    "local Veslo server startup must not depend on an OpenCode client that may require the server first",
  );
});

test("local Veslo server ensure only deduplicates after a successful ensure", () => {
  const effectStart = source.indexOf('let lastLocalVesloEnsureKey = "";');
  assert.notStrictEqual(effectStart, -1, "local Veslo server ensure effect is missing");

  const ensureCall = "void ensureLocalVesloServerRunning()";
  const ensureIdx = source.indexOf(ensureCall, effectStart);
  assert.notStrictEqual(ensureIdx, -1, "local Veslo server ensure call is missing");

  const effectEnd = source.indexOf("const restartLocalServer = async () => {", ensureIdx);
  assert.notStrictEqual(effectEnd, -1, "local Veslo server ensure effect end marker is missing");
  const effectSource = source.slice(effectStart, effectEnd);

  assert.doesNotMatch(
    effectSource.slice(0, ensureIdx - effectStart),
    /lastLocalVesloEnsureKey\s*=\s*nextKey/,
    "transient startup failures must not mark a local server ensure key as handled",
  );
  assert.match(
    effectSource,
    /\.then\(\(ok\) => \{[\s\S]*if \(ok\) \{[\s\S]*lastLocalVesloEnsureKey = scheduledKey;/,
    "local server ensure deduplication should be recorded only after a successful ensure",
  );
});

test("local Veslo server ensure runs as an app service on a clean profile", () => {
  const effectStart = source.indexOf('let lastLocalVesloEnsureKey = "";');
  assert.notStrictEqual(effectStart, -1, "local Veslo server ensure effect is missing");

  const ensureCall = "void ensureLocalVesloServerRunning()";
  const ensureIdx = source.indexOf(ensureCall, effectStart);
  assert.notStrictEqual(ensureIdx, -1, "local Veslo server ensure call is missing");

  const effectEnd = source.indexOf("const restartLocalServer = async () => {", ensureIdx);
  assert.notStrictEqual(effectEnd, -1, "local Veslo server ensure effect end marker is missing");
  const effectSource = source.slice(effectStart, effectEnd);

  assert.match(
    effectSource,
    /if \(!workspaceStore\.workspacesHydrated\(\)\) return;/,
    "clean-profile local server startup should wait for workspace bootstrap hydration",
  );
  assert.match(
    effectSource,
    /const nextKey = activeWorkspaceId \|\| activeWorkspaceRoot[\s\S]*: "app-service";/,
    "clean-profile local server startup should use an app-service key when no workspace exists yet",
  );
  assert.doesNotMatch(
    effectSource,
    /if\s*\(\s*!nextKey\.replace\(/,
    "clean-profile local server startup must not skip an empty workspace key after hydration",
  );
});

test("new Chat opens the pending draft and then ensures the local Veslo server", () => {
  const wrapperStart = source.indexOf("const openNewSessionWithDirectory = async () => {");
  assert.notStrictEqual(wrapperStart, -1, "app-shell new Chat handler is missing");

  const wrapperEnd = source.indexOf("  const {\n    activePendingDraftKey,", wrapperStart);
  assert.notStrictEqual(wrapperEnd, -1, "app-shell new Chat handler end marker is missing");
  const wrapperSource = source.slice(wrapperStart, wrapperEnd);

  assert.match(
    wrapperSource,
    /const opened = await pendingSessionDraftController\.openNewSessionWithDirectory\(\);/,
    "new Chat should first delegate composer opening to the pending draft controller",
  );
  assert.match(
    wrapperSource,
    /if \(opened !== false && isTauriRuntime\(\)\) \{[\s\S]*void ensureLocalVesloServerRunning\(\{ ignoreStartupPreference: true \}\)\.catch/,
    "new Chat should explicitly wake the local Veslo server after the draft opens",
  );
  assert.match(
    wrapperSource,
    /reportError\(error, "veslo-server\.ensure\.new-chat"\);/,
    "new Chat server startup failures should be reported with a specific surface",
  );
  assert.match(wrapperSource, /return opened;/, "new Chat should preserve the controller result");
  assert.doesNotMatch(
    source,
    /openNewSessionWithDirectory:\s*pendingSessionDraftController\.openNewSessionWithDirectory/,
    "Chat props should not bypass the runtime-aware app-shell handler",
  );
});

test("local Veslo server ensure effect is registered after the real implementation is assigned", () => {
  const effectStart = source.indexOf('let lastLocalVesloEnsureKey = "";');
  assert.notStrictEqual(effectStart, -1, "local Veslo server ensure effect is missing");

  const assignmentStart = source.indexOf("ensureLocalVesloServerRunning = async (options) => {");
  assert.notStrictEqual(assignmentStart, -1, "local Veslo server ensure assignment is missing");

  assert.ok(
    effectStart > assignmentStart,
    "local Veslo server ensure effect must not call the initial no-op implementation",
  );
});

test("local Veslo workspace readiness uses the stable local workspace id", () => {
  const resolutionEffectStart = source.indexOf("const vesloUrl = vesloServerUrl().trim();");
  assert.notStrictEqual(resolutionEffectStart, -1, "Veslo workspace resolution effect is missing");

  const localBranchStart = source.indexOf('if (active.workspaceType === "local") {', resolutionEffectStart);
  assert.notStrictEqual(localBranchStart, -1, "local Veslo workspace resolution branch is missing");

  const localBranchEnd = source.indexOf("return;", localBranchStart);
  assert.notStrictEqual(localBranchEnd, -1, "local Veslo workspace resolution branch end marker is missing");
  const localBranch = source.slice(localBranchStart, localBranchEnd);

  assert.match(
    localBranch,
    /setVesloServerWorkspaceId\(active\.id\?\.trim\(\) \|\| workspaceStore\.activeWorkspaceId\(\)\.trim\(\) \|\| null\);/,
    "local workspace readiness should use the shared stable workspace id contract",
  );
  assert.doesNotMatch(
    localBranch,
    /listWorkspaces|entry\.path|entry\.directory|entry\.opencode\?\.directory/,
    "local workspace readiness should not perform a server path scan during startup",
  );
});
