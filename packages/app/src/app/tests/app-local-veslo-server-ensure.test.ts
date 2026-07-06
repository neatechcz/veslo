import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const connectionSource = readFileSync(
  new URL("../context/veslo-server-connection.ts", import.meta.url),
  "utf8",
);

test("local Veslo server ensure is not gated by an existing OpenCode client", () => {
  const effectStart = connectionSource.indexOf('let lastLocalVesloEnsureKey = "";');
  assert.notStrictEqual(effectStart, -1, "local Veslo server ensure effect is missing");

  const ensureCall = "void ensureLocalVesloServerRunning()";
  const ensureIdx = connectionSource.indexOf(ensureCall, effectStart);
  assert.notStrictEqual(ensureIdx, -1, "local Veslo server ensure call is missing");

  const effectGuards = connectionSource.slice(effectStart, ensureIdx);
  assert.doesNotMatch(
    effectGuards,
    /if\s*\(\s*!deps\.routedClient\?\.\(\)\s*\)\s*return/,
    "local Veslo server startup must not depend on an OpenCode client that may require the server first",
  );
});

test("local Veslo server ensure only deduplicates after a successful ensure", () => {
  const effectStart = connectionSource.indexOf('let lastLocalVesloEnsureKey = "";');
  assert.notStrictEqual(effectStart, -1, "local Veslo server ensure effect is missing");

  const ensureCall = "void ensureLocalVesloServerRunning()";
  const ensureIdx = connectionSource.indexOf(ensureCall, effectStart);
  assert.notStrictEqual(ensureIdx, -1, "local Veslo server ensure call is missing");

  const effectEnd = connectionSource.indexOf("return {", ensureIdx);
  assert.notStrictEqual(effectEnd, -1, "local Veslo server ensure effect end marker is missing");
  const effectSource = connectionSource.slice(effectStart, effectEnd);

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
  const effectStart = connectionSource.indexOf('let lastLocalVesloEnsureKey = "";');
  assert.notStrictEqual(effectStart, -1, "local Veslo server ensure effect is missing");

  const ensureCall = "void ensureLocalVesloServerRunning()";
  const ensureIdx = connectionSource.indexOf(ensureCall, effectStart);
  assert.notStrictEqual(ensureIdx, -1, "local Veslo server ensure call is missing");

  const effectEnd = connectionSource.indexOf("return {", ensureIdx);
  assert.notStrictEqual(effectEnd, -1, "local Veslo server ensure effect end marker is missing");
  const effectSource = connectionSource.slice(effectStart, effectEnd);

  assert.match(
    effectSource,
    /if \(!deps\.workspace\?\.workspacesHydrated\(\)\) return;/,
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

  const wrapperEndOffset = source.slice(wrapperStart).search(/\r?\n  const \{\r?\n    activePendingDraftKey,/);
  assert.notStrictEqual(wrapperEndOffset, -1, "app-shell new Chat handler end marker is missing");
  const wrapperEnd = wrapperStart + wrapperEndOffset;
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
  const effectStart = connectionSource.indexOf("void ensureLocalVesloServerRunning()");
  assert.notStrictEqual(effectStart, -1, "local Veslo server ensure effect is missing");

  const implementationStart = connectionSource.indexOf("const ensureLocalVesloServerRunning = async");
  assert.notStrictEqual(implementationStart, -1, "local Veslo server ensure implementation is missing");

  assert.ok(
    effectStart > implementationStart,
    "local Veslo server ensure effect must not call the initial no-op implementation",
  );
});

test("workspace materialization can request server-only local Veslo startup", () => {
  assert.match(
    source,
    /ensureLocalVesloServerRunning:\s*\(options\) => ensureLocalVesloServerRunning\(\{\s*ignoreStartupPreference: true,\s*requireRuntimeChainReady: options\?\.requireRuntimeChainReady,\s*\}\)/s,
    "workspace store wiring must forward requireRuntimeChainReady so pre-runtime materialization can ensure only the server process",
  );
});

test("local Veslo workspace readiness uses the stable local workspace id", () => {
  const resolutionEffectStart = source.indexOf("const active = workspaceStore.activeWorkspaceDisplay();");
  assert.notStrictEqual(resolutionEffectStart, -1, "Veslo workspace resolution effect is missing");

  const localBranchStart = source.indexOf('if (active.workspaceType === "local") {', resolutionEffectStart);
  assert.notStrictEqual(localBranchStart, -1, "local Veslo workspace resolution branch is missing");

  const localBranchEnd = source.indexOf("return;", localBranchStart);
  assert.notStrictEqual(localBranchEnd, -1, "local Veslo workspace resolution branch end marker is missing");
  const localBranch = source.slice(localBranchStart, localBranchEnd);

  assert.match(
    localBranch,
    /setVesloServerWorkspaceId\(active\.vesloWorkspaceId\?\.trim\(\) \|\| null\);/,
    "local workspace readiness should use only the server-owned id",
  );
  assert.doesNotMatch(
    localBranch,
    /active\.id|workspaceStore\.activeWorkspaceId|listWorkspaces|entry\.path|entry\.directory|entry\.opencode\?\.directory/,
    "local workspace readiness should not publish app ids or perform a server path scan during startup",
  );
});
