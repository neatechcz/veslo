import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const globalSyncSource = readFileSync(
  new URL("../context/global-sync.tsx", import.meta.url),
  "utf8",
);
const serverSource = readFileSync(new URL("../context/server.tsx", import.meta.url), "utf8");
const serverUrlSource = readFileSync(new URL("../context/server-url.ts", import.meta.url), "utf8");
const eventStreamSource = readFileSync(new URL("../context/session-event-stream.ts", import.meta.url), "utf8");
const workspaceServerSyncSource = readFileSync(
  new URL("../context/workspace-server-sync.tsx", import.meta.url),
  "utf8",
);

// Send-timeout fix 2026-06-10 — on cold/lazy boot no engine is running yet.
// Every engine-proxy read issued in that window used to trigger a 30-60s
// engine cold spawn inside the orchestrator proxy and made the app feel stuck
// before the first message could even be sent.

test("engineReady boots false so guards block engine API calls until a real connect", () => {
  assert.match(
    appSource,
    /const \[engineReady, setEngineReady\] = createSignal\(false\);/,
    "legacy engineReady must start false so cold boot guards do not probe engine APIs before runtime readiness",
  );
});

test("boot warmup readiness is separate from live transcript read policy", () => {
  assert.match(
    appSource,
    /const liveTranscriptReadPolicy = createLiveTranscriptReadPolicy\(\{[\s\S]*activeWorkspaceId: \(\) => currentWorkspaceStoreRef\(\)\?\.activeWorkspaceId\(\)\.trim\(\) \?\? "",[\s\S]*record: \(event, payload\) =>[\s\S]*recordSendWorkflowTrace\("live-transcript-policy", event, payload,[\s\S]*\}\);/s,
    "live transcript read allowance should be tracked by a dedicated policy owner",
  );
  assert.match(
    appSource,
    /const isLiveTranscriptReadAllowedForWorkspace = liveTranscriptReadPolicy\.isAllowedForWorkspace;/,
    "ordinary history browsing should consult the live transcript policy owner",
  );
  assert.match(
    appSource,
    /emitLiveTranscriptPolicyEvent: \(event\) => liveTranscriptReadPolicy\.emit\(event\),/,
    "send workflow should only emit typed policy events instead of mutating browse policy directly",
  );
  assert.match(
    appSource,
    /return !isLiveTranscriptReadAllowedForWorkspace\(workspaceStore\.activeWorkspaceId\(\)\.trim\(\)\);/,
    "ordinary history browsing should not become live SDK reading merely because the runtime is ready",
  );
  assert.doesNotMatch(
    appSource,
    /shouldBrowseSessionFromDb: \(sessionId\) => \{[\s\S]*return !isWorkspaceRuntimeReady\(workspaceStore\.activeWorkspaceId\(\)\.trim\(\)\);[\s\S]*\},/s,
    "session browse policy must not be derived directly from runtime readiness",
  );
});

test("session SSE does not connect while lazy boot has no ready engine", () => {
  assert.match(
    eventStreamSource,
    /for \(const wsId of entryIds\) \{[\s\S]*if \(!deps\.isWorkspaceRuntimeReady\(wsId\)\) continue;[\s\S]*const c = deps\.routing\.client\(wsId\);/s,
    "workspace SSE streams should only open for routed workspaces whose runtime is ready",
  );
  assert.doesNotMatch(
    eventStreamSource,
    /const fallback = deps\.client\(\)|targets\.push\(\{ wsId: "", client: fallback \}\)|deps\.client\(\)/,
    "session SSE should not open a global active-client fallback stream without a routed workspace id",
  );
  assert.match(
    eventStreamSource,
    /if \(targets\.length === 0\) \{[\s\S]*deps\.setSseConnected\(false\);[\s\S]*return;[\s\S]*\}/s,
    "lazy boot without any ready workspace target should not leave SSE marked connected",
  );
  assert.doesNotMatch(
    eventStreamSource,
    /if \(deps\.engineReady\?\.\(\) === false\) \{[\s\S]*return;[\s\S]*\}[\s\S]*const entryIds = deps\.routing\.entryIds\(\);/s,
    "global engineReady must not block already-ready routed workspaces from opening SSE streams",
  );
});

test("global sync refresh waits for a healthy server before bursting engine-proxy reads", () => {
  assert.match(
    globalSyncSource,
    /createEffect\(\(\) => \{[\s\S]{0,200}globalSDK\.url\(\);[\s\S]{0,800}server\.healthy\(\) === true[\s\S]{0,200}void refresh\(\);[\s\S]{0,100}\}\);/s,
    "the refresh effect must gate on server.healthy() — it also re-fires the burst once the engine becomes reachable",
  );
});

test("server health polling does not probe workspace OpenCode proxy URLs", () => {
  assert.match(
    serverUrlSource,
    /export function isWorkspaceOpencodeProxyUrl\(url: string\)/,
    "workspace-scoped OpenCode proxy URLs must be recognized separately from global /opencode proxies",
  );
  assert.match(
    serverSource,
    /import \{[\s\S]*isWorkspaceOpencodeProxyUrl[\s\S]*\} from "\.\/server-url";/,
    "ServerProvider must use the pure server-url helper instead of duplicating workspace proxy detection in the JSX provider",
  );
  assert.match(
    serverSource,
    /isWorkspaceOpencodeProxyUrl\(url\)/,
    "global health checks must skip workspace OpenCode proxy URLs; submit-time routing starts the right engine",
  );
  assert.match(
    workspaceServerSyncSource,
    /server\.setActive\(nextUrl\);/,
    "WorkspaceServerSync may publish workspace proxy URLs, but ServerProvider must not treat them as global health targets",
  );
});

test("workspace server sync dedupes stable engine_info inputs", () => {
  assert.match(
    workspaceServerSyncSource,
    /let inFlightWorkspaceServerSyncKey = "";/,
    "workspace server sync should track an in-flight key",
  );
  assert.match(
    workspaceServerSyncSource,
    /const syncKey = \[workspaceId, workspacePath, orchestratorPort \?\? ""\]\.join\("::"\);/,
    "workspace server sync should key engine_info calls by workspace id, path, and daemon port",
  );
  assert.match(
    workspaceServerSyncSource,
    /if \(syncKey === inFlightWorkspaceServerSyncKey\) return;/,
    "workspace server sync should not start duplicate engine_info requests for the same key",
  );
  assert.match(
    workspaceServerSyncSource,
    /syncKey === lastResolvedWorkspaceServerSyncKey &&[\s\S]*currentServerUrl === lastResolvedWorkspaceServerSyncUrl/,
    "workspace server sync should skip resolved inputs while the server URL is still current",
  );
});
