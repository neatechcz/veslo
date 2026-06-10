import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("app shell keeps a focus-aware unread session map", () => {
  assert.match(source, /const \[appFocused,\s*setAppFocused\] = createSignal\(true\)/);
  assert.match(source, /window\.addEventListener\("focus",\s*updateAppFocused\)/);
  assert.match(source, /window\.addEventListener\("blur",\s*updateAppFocused\)/);
  assert.match(source, /const \[unreadSessionIds,\s*setUnreadSessionIds\] = createSignal<UnreadSessionMap>\(\{\}\)/);
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
  const matches = source.match(/unreadSessionIds:\s*unreadSessionIds\(\)/g) ?? [];
  assert.ok(matches.length >= 2, "session and dashboard sidebar props should both receive unreadSessionIds");
});
