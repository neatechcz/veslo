import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
const scriptSource = readFileSync(new URL("../../../../scripts/session-switch.mjs", import.meta.url), "utf8");

test("session switch instrumentation distinguishes warm hits from cold misses", () => {
  assert.match(
    appSource,
    /recordPerfLog\(developerMode\(\),\s*"session\.switch",\s*"transcript-first-paint",/,
    "app should record transcript-first-paint switch metrics",
  );
  assert.match(
    appSource,
    /source:\s*.*"warm-hit".*"cold-miss"/s,
    "app metrics should label warm-hit versus cold-miss switches",
  );
  assert.match(
    scriptSource,
    /step\("warm transcript first paint"/,
    "session switch harness should report a warm transcript timing step",
  );
  assert.match(
    scriptSource,
    /step\("cold transcript first paint"/,
    "session switch harness should report a cold transcript timing step",
  );
});
