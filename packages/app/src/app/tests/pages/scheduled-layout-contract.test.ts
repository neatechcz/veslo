import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../pages/scheduled.tsx", import.meta.url), "utf8");

test("scheduled page empty state does not show explore more link", () => {
  assert.equal(source.includes('tr("scheduled.explore_more")'), false);
  assert.equal(source.includes("openSchedulerDocs"), false);
});

test("scheduled automation editor cannot select or preserve a model override", () => {
  assert.doesNotMatch(source, /automationModel|setAutomationModel|scheduled\.model/);
  assert.match(source, /model:\s*null/);
});
