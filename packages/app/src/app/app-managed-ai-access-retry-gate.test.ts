import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const storeSource = readFileSync(
  new URL("./context/managed-ai-access-store.ts", import.meta.url),
  "utf8",
);

test("managed ai access retry keeps send blocked as loading instead of permanent failure", () => {
  assert.match(
    storeSource,
    /const \[managedAiAccessRetryScheduled, setManagedAiAccessRetryScheduled\] = createSignal\(false\);/,
    "managed ai access refresh should track scheduled retries",
  );
  assert.match(
    storeSource,
    /if \(managedAiAccessBusy\(\) \|\| managedAiAccessRetryScheduled\(\)\) \{\s*return options\.translate\(AI_ACCESS_LOADING_MESSAGE_KEY\);/s,
    "send readiness should treat retryable access refresh errors as loading",
  );
  assert.match(
    storeSource,
    /setManagedAiAccessRetryScheduled\(true\);[\s\S]*retryTimeoutId = timers\.setTimeout/,
    "scheduled managed ai access retries should be visible to send readiness",
  );
});
