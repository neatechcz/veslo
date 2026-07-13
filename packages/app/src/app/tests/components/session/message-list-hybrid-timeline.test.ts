import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../../components/session/message-list.tsx", import.meta.url), "utf8");

test("message list integrates the hybrid timeline model and collapse state helpers", () => {
  assert.match(source, /buildTimelineDetailModel/);
  assert.match(source, /buildProgressRenderBlocks/);
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
  assert.match(source, /session\.timeline_technical_detail/);
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

test("timeline section reconciliation avoids writing a fresh Set when nothing changed", () => {
  assert.match(source, /function sameStringSet\(left: ReadonlySet<string>, right: ReadonlySet<string>\): boolean/);
  assert.match(
    source,
    /const next = reconcileTimelineOpenSectionIds\(current, \{[\s\S]*return sameStringSet\(current, next\) \? current : next;/s,
    "timeline reconciliation must preserve the existing Set identity when contents are unchanged, otherwise step timelines loop forever",
  );
});

test("turn-scoped assistant activity grouping is delegated to the progress model", () => {
  assert.match(source, /buildProgressRenderBlocks\(\{/);
  assert.doesNotMatch(source, /previousBlock\?\.kind === "steps-cluster"/);
});

test("mixed message blocks render a single inline timeline for all step groups", () => {
  assert.match(source, /const inlineStepGroups = \(\) =>\s*messageBlock\(\)\.groups[\s\S]*group\.kind === "steps"/);
  assert.match(source, /stepGroups=\{inlineStepGroups\(\)\}/);
});

test("turn-scoped progress groups render comments inside the expandable progress block", () => {
  assert.match(source, /block\.kind === "progress-group"/);
  assert.match(source, /ProgressComment/);
  assert.match(source, /ProgressStepGroup/);
  assert.match(source, /data-testid="session-progress-group"/);
  assert.match(source, /data-testid="session-progress-comment"/);
  assert.match(source, /data-testid="session-progress-step-group"/);
  assert.match(source, /isProgressChild=\{true\}/);
  assert.doesNotMatch(source, /<ProgressStepRows/);
});

test("progress group comments render as plain assistant text without a framed card", () => {
  assert.match(source, /data-testid="session-progress-comment"/);
  assert.doesNotMatch(source, /data-testid="session-progress-comment"\s+class="[^"]*(?:rounded|border|bg-gray)/);
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
  assert.match(source, /buildProgressRenderBlocks\(\{[\s\S]*showThinking: props\.showThinking,[\s\S]*\}\)/s);
});

test("outer transcript rows reconcile through stable primitive keys and live block accessors", () => {
  assert.match(source, /progressRenderBlockEntries/);
  assert.match(source, /const messageBlockKeys = createMemo\(\(\) => messageBlockEntries\(\)\.map\(\(entry\) => entry\.key\)\);/);
  assert.match(source, /const messageBlockByKey = createMemo\(\(\) => new Map\(messageBlockEntries\(\)\.map\(\(entry\) => \[entry\.key, entry\.block\]\)\)\);/);
  assert.match(
    source,
    /<For each=\{messageBlockKeys\(\)\}>[\s\S]*renderBlock\(\(\) => messageBlockByKey\(\)\.get\(key\)!\, blockIndex\)/s,
    "both regular-list fallbacks should retain semantic primitive keys while resolving the latest block through an accessor",
  );
  assert.match(
    source,
    /const renderBlock = \(block: Accessor<MessageBlockItem>, blockIndex: Accessor<number>\) =>/,
    "a retained row should receive live block and index accessors instead of one captured view-model object",
  );
});

test("virtual transcript rows reuse the same stable semantic keys", () => {
  assert.match(
    source,
    /getItemKey: \(index\) => \{\s*return messageBlockEntries\(\)\[index\]\?\.key \?\? `unstable:virtual:\$\{index\}`;/s,
    "the virtualizer should use the shared semantic key instead of a growing progress message-id list",
  );
  assert.doesNotMatch(source, /progress-\$\{block\.messageIds\.join\(","\)\}/);
  assert.match(source, /const virtualRowKeys = createMemo\(\(\) => Array\.from\(virtualRowByKey\(\)\.keys\(\)\)\);/);
  assert.match(source, /<For each=\{virtualRowKeys\(\)\}>/);
});

test("timeline technical detail disclosure is controlled by the same toggle", () => {
  assert.match(source, /canShowTimelineTechnicalDetail\(entry\)/);
  assert.doesNotMatch(source, /props\.developerMode && entry\.part/);
});

test("timeline technical detail disclosure uses parent-owned expansion state", () => {
  assert.match(source, /expandedTimelineDetailIds: Set<string>/);
  assert.match(source, /setExpandedTimelineDetailIds: \(updater: \(current: Set<string>\) => Set<string>\) => void;/);
  assert.match(source, /toggleTimelineDetail\(rowDetailId\)/);
  assert.match(source, /aria-expanded=\{timelineDetailExpanded\(rowDetailId\)\}/);
  assert.doesNotMatch(source, /<details class="mt-2">/);
});
