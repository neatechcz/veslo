import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

test("session loading moves from fullscreen app overlay into the center pane", () => {
  assert.ok(
    sessionSource.includes(
      "pendingSessionLoad: { sessionId: string; workspaceId: string; sessionTitle: string; workspaceName: string } | null;",
    ),
    "session view props should receive the pending session load metadata",
  );

  assert.match(
    sessionSource,
    /const showSessionLoadingState = createMemo\(\(\) =>[\s\S]*shouldShowSessionLoadingState\(\{[\s\S]*hasPendingSessionLoad: Boolean\(props\.pendingSessionLoad\),[\s\S]*selectedSessionId: props\.selectedSessionId,[\s\S]*messageCount: props\.messages\.length,[\s\S]*loadingEarlierMessages: props\.loadingEarlierMessages,[\s\S]*\}\)[\s\S]*\);/,
    "session page should derive an inline loading state from pending switch metadata or the active message fetch",
  );

  assert.match(
    sessionSource,
    /<Show when=\{showSessionLoadingState\(\)\}>/,
    "session page should render a dedicated inline loading state in the center pane",
  );

  assert.match(
    appSource,
    /const workspaceSwitchOpen = createMemo\(\(\) => \{[\s\S]*if \(pendingSessionLoad\(\)\) return false;/,
    "workspace switch overlay should stay closed while a sidebar session switch is already rendering inline loading",
  );

  assert.doesNotMatch(
    appSource,
    /<Show when=\{pendingSessionLoad\(\)\}>/,
    "app shell should not render a separate fullscreen session loading overlay anymore",
  );
});
