import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./message-list.tsx", import.meta.url), "utf8");

test("message list integrates the hybrid timeline model and collapse state helpers", () => {
  assert.match(source, /buildTimelineDetailModel/);
  assert.match(source, /reconcileTimelineOpenSectionIds/);
  assert.match(source, /createTimelineSectionStateId/);
  assert.match(source, /toggleTimelineSection/);
});

test("collapsed timeline header uses the human summary from the derived model", () => {
  assert.match(source, /localizedTimelineSummary\(timelineSections\(\)\)/);
  assert.match(source, /latestLabel: latestStepLabel\(\)/);
});

test("expanded timeline renders nested section toggles and technical detail disclosure", () => {
  assert.match(source, /For each=\{timelineSections\(\)\}/);
  assert.match(source, /toggleTimelineSection\(current, section\.id\)/);
  assert.match(source, /row\.technicalDetail/);
  assert.match(source, /<details/);
});

test("expanded timeline does not create an inner scroll container", () => {
  assert.doesNotMatch(source, /max-h-\[480px\] overflow-y-auto/);
});

test("single-section timelines do not require a second collapse interaction", () => {
  assert.match(source, /const singleSectionMode = \(\) => timelineSections\(\)\.length === 1;/);
  assert.match(source, /<Show when=\{singleSectionMode\(\) \|\| sectionExpanded\(section\.id\)\}>/);
});

test("section toggle handlers isolate their click events", () => {
  assert.match(
    source,
    /onClick=\{\(event\) => \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*setTimelineDetailState\(\(current\) => toggleTimelineSection\(current, section\.id\)\);/s,
  );
});

test("timeline section state is parent-owned and keyed independently of section indexes", () => {
  assert.match(source, /reconcileTimelineOpenSectionIds/);
  assert.match(source, /createTimelineSectionStateId/);
  assert.match(source, /expandedTimelineSectionIds: Set<string>/);
  assert.match(source, /setExpandedTimelineSectionIds: \(updater: \(current: Set<string>\) => Set<string>\) => void;/);
  assert.doesNotMatch(source, /createSignal<TimelineDetailState>/);
});

test("adjacent step-only assistant messages merge into a single timeline block", () => {
  assert.match(
    source,
    /const previousBlock = blocks\[blocks\.length - 1\];[\s\S]*previousBlock\?\.kind === "steps-cluster"[\s\S]*previousBlock\.isUser === isUser[\s\S]*previousBlock\.stepGroups\.push\(/s,
  );
});

test("mixed message blocks render a single inline timeline for all step groups", () => {
  assert.match(source, /const inlineStepGroups = \(\) =>\s*block\.groups[\s\S]*group\.kind === "steps"/);
  assert.match(source, /stepGroups=\{inlineStepGroups\(\)\}/);
});

test("action summaries distinguish thinking-only rows from real actions", () => {
  assert.match(source, /countSectionRows\(section\.rows, \["note"\]\)/);
  assert.match(source, /session\.timeline_section_thinking/);
});

test("action headings split thinking rows and subagent rows into separate timeline sections", () => {
  assert.match(source, /splitActionSectionRows/);
  assert.match(source, /labelKind: "thinking"/);
  assert.match(source, /labelKind: "subagents"/);
  assert.match(source, /session\.timeline_section_subagents/);
});

test("collapsed timeline meta is not the generic execution label", () => {
  assert.doesNotMatch(source, /const collapsedMeta = \(\) => \(expanded\(\) \? tr\("session\.timeline_hide"\) : tr\("session\.timeline_execution"\)\)/);
  assert.match(source, /formatTimelineDuration/);
});

test("message grouping respects thinking visibility for timeline steps", () => {
  assert.match(source, /if \(part\.type === "reasoning"\) \{\s*return props\.showThinking;\s*\}/s);
  assert.match(source, /groupMessageParts\(renderableParts, groupId, \{ showThinking: props\.showThinking \}\)/);
});

test("timeline technical detail disclosure is controlled by the same toggle", () => {
  assert.match(source, /<Show when=\{props\.showThinking && row\.technicalDetail\}>/);
  assert.doesNotMatch(source, /props\.developerMode && entry\.part/);
});
