import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scheduledSource = () => readFileSync(join(__dirname, "scheduled.tsx"), "utf8");

test("ScheduledTasksView keeps server automations on API handlers instead of prompt/session routing", () => {
  const source = scheduledSource();

  assert.match(source, /automations:\s*VesloAutomation\[\]/);
  assert.match(source, /createAutomation:\s*\(/);
  assert.match(source, /runAutomation:\s*\(/);
  assert.match(source, /deleteAutomation:\s*\(/);
  assert.match(source, /legacyScheduledJobs:\s*ScheduledJob\[\]/);
  assert.match(source, /legacyScheduledJobs/);

  const primaryCreate = source.match(/const handleCreateAutomation[\s\S]*?};/);
  assert.ok(primaryCreate);
  assert.match(primaryCreate[0], /props\.createAutomation/);
  assert.doesNotMatch(primaryCreate[0], /props\.setPrompt|props\.createSessionAndOpen/);

  const primaryRun = source.match(/const runAutomationNow[\s\S]*?};/);
  assert.ok(primaryRun);
  assert.match(primaryRun[0], /props\.runAutomation/);
  assert.doesNotMatch(primaryRun[0], /props\.setPrompt|props\.createSessionAndOpen/);
});
