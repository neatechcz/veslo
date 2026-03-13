import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { ReloadTrigger } from "../types.js";
import { createSkillReloadGuard } from "./skill-reload-guard.js";

test("fires fallback after grace period when no hot-reload confirmation arrives", async () => {
  const calls: Array<ReloadTrigger | undefined> = [];
  const guard = createSkillReloadGuard({
    graceMs: 20,
    onFallbackNeeded: (trigger) => calls.push(trigger),
  });

  const trigger: ReloadTrigger = { type: "skill", name: "my-skill", action: "updated" };
  guard.scheduleSkillFallback(trigger);

  await sleep(60);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], trigger);
  assert.equal(guard.hasPending(), false);
});

test("cancels fallback when hot-reload confirmation arrives within grace period", async () => {
  const calls: Array<ReloadTrigger | undefined> = [];
  const guard = createSkillReloadGuard({
    graceMs: 30,
    onFallbackNeeded: (trigger) => calls.push(trigger),
  });

  guard.scheduleSkillFallback({ type: "skill", name: "my-skill", action: "updated" });

  await sleep(10);
  const hadPending = guard.hotReloadApplied();

  await sleep(40);

  assert.equal(hadPending, true);
  assert.equal(calls.length, 0);
  assert.equal(guard.hasPending(), false);
});

test("resets grace timer and keeps only the latest trigger", async () => {
  const calls: Array<ReloadTrigger | undefined> = [];
  const guard = createSkillReloadGuard({
    graceMs: 20,
    onFallbackNeeded: (trigger) => calls.push(trigger),
  });

  guard.scheduleSkillFallback({ type: "skill", name: "old-skill", action: "updated" });
  await sleep(12);
  const latest: ReloadTrigger = { type: "skill", name: "new-skill", action: "updated" };
  guard.scheduleSkillFallback(latest);

  await sleep(45);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], latest);
});

test("dispose cancels pending fallback", async () => {
  const calls: Array<ReloadTrigger | undefined> = [];
  const guard = createSkillReloadGuard({
    graceMs: 20,
    onFallbackNeeded: (trigger) => calls.push(trigger),
  });

  guard.scheduleSkillFallback({ type: "skill", name: "my-skill", action: "updated" });
  guard.dispose();

  await sleep(40);

  assert.equal(calls.length, 0);
  assert.equal(guard.hasPending(), false);
});
