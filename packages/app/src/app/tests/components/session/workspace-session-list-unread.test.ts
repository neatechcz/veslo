import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../../components/session/workspace-session-list.tsx", import.meta.url), "utf8");

test("workspace session list accepts unread session ids", () => {
  assert.match(source, /unreadSessionIds\?:\s*Record<string,\s*(boolean|true)>/);
  assert.match(source, /const isSessionUnread = \(sessionId: string\) => Boolean\(props\.unreadSessionIds\?\.\[sessionId\]\)/);
});

test("recent and by-project session titles become bold when unread", () => {
  const classMatches = source.match(/class="text-\[12\.5px\] text-gray-12 truncate"\s*classList=\{\{ "font-bold": isUnread\(\) \}\}/g) ?? [];
  assert.ok(classMatches.length >= 2, "both Recent and By Project title spans should use unread bold styling");
});
