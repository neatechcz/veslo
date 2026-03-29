import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./message-list.tsx", import.meta.url), "utf8");

test("message list integrates the hybrid timeline model and collapse state helpers", () => {
  assert.match(source, /buildTimelineDetailModel/);
  assert.match(source, /createTimelineDetailState/);
  assert.match(source, /toggleTimelineSection/);
});

test("collapsed timeline header uses the human summary from the derived model", () => {
  assert.match(source, /timelineModel\(\)\.summary/);
  assert.match(source, /latestLabel: latestStepLabel\(\)/);
});

test("expanded timeline renders nested section toggles and technical detail disclosure", () => {
  assert.match(source, /For each=\{timelineSections\(\)\}/);
  assert.match(source, /toggleTimelineSection\(current, section\.id\)/);
  assert.match(source, /row\.technicalDetail/);
  assert.match(source, /<details/);
});
