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

test("cold Tauri boot does not trust a persisted OpenCode proxy URL for health polling", () => {
  assert.match(
    serverSource,
    /const \[activeHealthTrusted, setActiveHealthTrusted\] = createSignal\(false\);/,
    "persisted server URLs must start untrusted so cold boot cannot poll a stale orchestrator proxy",
  );
  assert.match(
    serverSource,
    /isTauriRuntime\(\) && !trusted && isOpencodeProxyUrl\(url\)/,
    "Tauri must skip OpenCode health probes for untrusted persisted proxy URLs",
  );
  assert.match(
    workspaceServerSyncSource,
    /server\.setActive\(nextUrl, \{ trusted: true \}\);/,
    "WorkspaceServerSync must mark URLs returned by engineInfo as trusted so health checks resume for a real engine",
  );
});
