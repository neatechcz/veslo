import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("managed ai access retry keeps send blocked as loading instead of permanent failure", () => {
  assert.match(
    source,
    /const \[managedAiAccessRetryScheduled, setManagedAiAccessRetryScheduled\] = createSignal\(false\);/,
    "managed ai access refresh should track scheduled retries",
  );
  assert.match(
    source,
    /if \(managedAiAccessBusy\(\) \|\| managedAiAccessRetryScheduled\(\)\) return AI_ACCESS_LOADING_MESSAGE;/,
    "send readiness should treat retryable access refresh errors as loading",
  );
  assert.match(
    source,
    /setManagedAiAccessRetryScheduled\(true\);[\s\S]*retryTimeoutId = window\.setTimeout/,
    "scheduled managed ai access retries should be visible to send readiness",
  );
});
