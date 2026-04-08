import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

test("session loading moves from fullscreen app overlay into the center pane", () => {
  assert.ok(
    sessionSource.includes("pendingSessionLoad: { sessionTitle: string; workspaceName: string } | null;"),
    "session view props should receive the pending session load metadata",
  );

  assert.match(
    sessionSource,
    /const showSessionLoadingState = createMemo\(\(\) =>[\s\S]*Boolean\(props\.selectedSessionId\)[\s\S]*props\.messages\.length === 0[\s\S]*Boolean\(props\.pendingSessionLoad\) \|\| props\.loadingEarlierMessages[\s\S]*\);/,
    "session page should derive an inline loading state from pending switch metadata or the active message fetch",
  );

  assert.match(
    sessionSource,
    /<Show when=\{showSessionLoadingState\(\)\}>/,
    "session page should render a dedicated inline loading state in the center pane",
  );

  assert.doesNotMatch(
    appSource,
    /open=\{workspaceSwitchOpen\(\) && !pendingSessionLoad\(\)\}/,
    "workspace switch overlay should no longer depend on session loading state",
  );

  assert.doesNotMatch(
    appSource,
    /<Show when=\{pendingSessionLoad\(\)\}>/,
    "app shell should not render a fullscreen session loading overlay anymore",
  );
});
