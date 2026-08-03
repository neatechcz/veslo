import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const appViewPropsSource = readFileSync(new URL("../app-view-props.ts", import.meta.url), "utf8");
const appShellEnvironmentSource = readFileSync(new URL("../context/app-shell-environment.ts", import.meta.url), "utf8");

test("app shell keeps a focus-aware unread session map", () => {
  assert.match(source, /const appShellEnvironment = createAppShellEnvironment\(\{[\s\S]*isTauriRuntime,[\s\S]*\}\);/);
  assert.match(source, /const appFocused = appShellEnvironment\.appFocused;/);
  assert.match(appShellEnvironmentSource, /const \[appFocused,\s*setAppFocused\] = createSignal\(true\)/);
  assert.match(appShellEnvironmentSource, /win\.addEventListener\("focus",\s*updateAppFocused\)/);
  assert.match(appShellEnvironmentSource, /win\.addEventListener\("blur",\s*updateAppFocused\)/);
  assert.match(source, /const \[unreadSessionIds,\s*setUnreadSessionIds\]\s*=\s*createSignal<UnreadSessionMap>\(\{\}\)/);
});

test("app shell marks unread from assistant responses and clears the selected session", () => {
  assert.match(source, /onAssistantResponseObserved:\s*\(sessionId\) => \{/);
  assert.match(
    source,
    /markUnreadAfterAssistantResponse\([\s\S]*responseSessionId:\s*sessionId[\s\S]*selectedSessionId:\s*selectedSessionId\(\)[\s\S]*appFocused:\s*appFocused\(\)/,
  );
  assert.match(source, /const id = selectedSessionId\(\);[\s\S]*clearUnreadSession\(current,\s*id\)/);
  assert.match(source, /if \(!appFocused\(\)\) return;[\s\S]*const id = selectedSessionId\(\);[\s\S]*clearUnreadSession\(current,\s*id\)/);
});

test("app shell passes unread state to both sidebar surfaces", () => {
  assert.match(
    appViewPropsSource,
    /unreadSessionIds:\s*unreadSessionIds\(\)/,
    "dashboard sidebar props should receive unreadSessionIds",
  );
  assert.match(
    appViewPropsSource,
    /get unreadSessionIds\(\) \{\s*return unreadSessionIds\(\);\s*\}/s,
    "session sidebar props should receive unreadSessionIds through the stable getter object",
  );
});
