import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const globalSyncSource = readFileSync(
  new URL("../context/global-sync.tsx", import.meta.url),
  "utf8",
);
const serverSource = readFileSync(new URL("../context/server.tsx", import.meta.url), "utf8");
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
    "engineReady must start false — connectToServer/onEngineStable flips it true after a successful connect",
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
    serverSource,
    /export function isWorkspaceOpencodeProxyUrl\(url: string\)/,
    "workspace-scoped OpenCode proxy URLs must be recognized separately from global /opencode proxies",
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
