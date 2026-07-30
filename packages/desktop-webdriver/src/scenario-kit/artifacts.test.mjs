import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeScenarioArtifactValue, scenarioArtifactPath } from "./artifacts.mjs";

test("scenario artifacts are timestamped and stay in ignored local .tmp storage", () => {
  const path = scenarioArtifactPath("Workspace roundtrip!", new Date("2026-07-30T10:11:12.123Z"));
  assert.match(path.replaceAll("\\", "/"), /\.tmp\/webdriver-scenarios\/2026-07-30T10-11-12-123Z-Workspace-roundtrip\.json$/);
});

test("scenario artifacts preserve ordinary console text while redacting secrets", () => {
  assert.deepEqual(
    sanitizeScenarioArtifactValue({ logs: [{ args: ["[veslo] healthy"] }], authorization: "Bearer private-value" }),
    { logs: [{ args: ["[veslo] healthy"] }], authorization: "[redacted]" },
  );
  assert.equal(sanitizeScenarioArtifactValue("token=private-value"), "token=[redacted]");
});
