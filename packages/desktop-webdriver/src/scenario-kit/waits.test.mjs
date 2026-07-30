import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmImplicitSkillCommand,
  waitForSubmittedRunToSettle,
} from "./waits.mjs";

test("skill creation confirmation is accepted before waiting for the real run", async () => {
  let clicked = false;
  const browser = {
    $: async () => ({
      isDisplayed: async () => !clicked,
      waitForEnabled: async () => undefined,
      click: async () => { clicked = true; },
    }),
    execute: async () => clicked,
    waitUntil: async (predicate) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await predicate()) return;
      }
      throw new Error("condition never became true");
    },
  };

  const confirmed = await confirmImplicitSkillCommand(browser);
  assert.equal(clicked, true);
  assert.equal(confirmed, true);
});

test("optional skill confirmation does not block an already-admitted server-owned submit", async () => {
  const browser = {
    $: async () => ({ isDisplayed: async () => false }),
    waitUntil: async () => { throw new Error("condition never became true"); },
  };

  const confirmed = await confirmImplicitSkillCommand(browser, 10, { required: false });
  assert.equal(confirmed, false);
});

test("submitted-run settle waits for a delayed run indicator before accepting terminal absence", async () => {
  const conditions = [false, true, true];
  const browser = {
    execute: async () => conditions.shift(),
    waitUntil: async (predicate) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (await predicate()) return;
      }
      throw new Error("condition never became true");
    },
  };

  await waitForSubmittedRunToSettle(browser, "workspace", 30_000);
  assert.deepEqual(conditions, []);
});
