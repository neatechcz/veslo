import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(CURRENT_DIR, "../app.tsx"), "utf8");
const decorationsSource = readFileSync(
  resolve(CURRENT_DIR, "../context/session-sidebar-decorations.ts"),
  "utf8",
);

test("subagent role decoration does not create visible helper sessions", () => {
  assert.match(
    source,
    /createSessionSidebarDecorations/,
    "app.tsx should delegate subagent sidebar decorations to the context store",
  );
  assert.doesNotMatch(
    `${source}\n${decorationsSource}`,
    /title:\s*"\[Veslo\] Subagent role classifier"/,
  );
  assert.doesNotMatch(
    decorationsSource,
    /\bsession\.create\b|\bcreateConversation\b/,
    "decoration classification should not materialize helper sessions",
  );
});
