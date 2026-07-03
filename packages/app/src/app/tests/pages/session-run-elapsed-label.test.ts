import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { formatRunElapsedDuration } from "../../pages/session-run-elapsed-label.js";

const sessionSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");

test("formatRunElapsedDuration never exposes milliseconds", () => {
  assert.equal(formatRunElapsedDuration(0), "<1 s");
  assert.equal(formatRunElapsedDuration(499), "<1 s");
  assert.equal(formatRunElapsedDuration(999), "<1 s");
  assert.equal(formatRunElapsedDuration(1000), "1 s");
  assert.equal(formatRunElapsedDuration(59_400), "59 s");
  assert.equal(formatRunElapsedDuration(60_000), "1 min");
  assert.equal(formatRunElapsedDuration(68_000), "1 min 8 s");
  assert.equal(formatRunElapsedDuration(3_600_000), "1 h");
  assert.equal(formatRunElapsedDuration(3_900_000), "1 h 5 min");
});

test("session run indicator shows elapsed time to all users", () => {
  assert.match(
    sessionSource,
    /import \{ formatRunElapsedDuration \} from "\.\/session-run-elapsed-label";/,
    "session should use the shared human elapsed formatter",
  );
  assert.match(
    sessionSource,
    /const runElapsedLabel = createMemo\(\(\) => formatRunElapsedDuration\(runElapsedMs\(\)\)\);/,
    "active run elapsed label should use human seconds/minutes/hours formatting",
  );
  assert.match(
    sessionSource,
    /<span class="text-\[10px\] text-gray-8 ml-auto shrink-0">\{runElapsedLabel\(\)\}<\/span>/,
    "elapsed time should be rendered directly in the run indicator instead of being gated by developer mode",
  );
  assert.doesNotMatch(
    sessionSource,
    /toLocaleString\(\)\}ms|runElapsedLabel\(\)\}ms|<Show when=\{props\.developerMode\}>\s*<span class="text-\[10px\] text-gray-8 ml-auto shrink-0">\{runElapsedLabel\(\)\}<\/span>\s*<\/Show>/s,
    "the public run timer must not use milliseconds or a developer-mode-only wrapper",
  );
});
