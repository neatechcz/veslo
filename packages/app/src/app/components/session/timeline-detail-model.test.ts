import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCollapsedSummary,
  buildTimelineDetailModel,
  type TimelineSectionKind,
} from "./timeline-detail-model.js";

const exploreModel = buildTimelineDetailModel({
  parts: [
    {
      type: "tool",
      tool: "read",
      state: { input: { filePath: "packages/app/src/app/components/session/message-list.tsx" } },
    },
    {
      type: "tool",
      tool: "grep",
      state: { input: { pattern: "timeline" } },
    },
    {
      type: "tool",
      tool: "list",
      state: { input: { path: "packages/app/src/app/components/session" } },
    },
    {
      type: "tool",
      tool: "bash",
      state: { input: { command: "pnpm typecheck" }, status: "completed" },
    },
  ],
} as any);

test("buildTimelineDetailModel derives explore and action sections", () => {
  const kinds = exploreModel.sections.map((section) => section.kind);

  assert.deepEqual(kinds, ["explore", "action"]);
  assert.equal(exploreModel.sections[0]?.rows.length, 3);
  assert.equal(exploreModel.sections[1]?.rows[0]?.primary, "Spustil pnpm typecheck");
});

test("buildTimelineDetailModel keeps plan separate from exploration", () => {
  const model = buildTimelineDetailModel({
    parts: [
      { type: "reasoning", text: "Plan: first inspect the session timeline." },
      {
        type: "tool",
        tool: "read",
        state: { input: { filePath: "packages/app/src/app/components/session/message-list.tsx" } },
      },
      {
        type: "tool",
        tool: "apply_patch",
        state: { input: { path: "packages/app/src/app/components/session/message-list.tsx" }, status: "completed" },
      },
    ],
  } as any);

  assert.deepEqual(model.sections.map((section) => section.kind), ["plan", "explore", "action"]);
});

test("buildTimelineDetailModel routes failures into issues", () => {
  const model = buildTimelineDetailModel({
    parts: [
      {
        type: "tool",
        tool: "bash",
        state: { input: { command: "pnpm test" }, status: "error", error: "Command failed" },
      },
      {
        type: "reasoning",
        text: "session-error: Unauthorized while loading workspace data",
        synthetic: true,
      },
    ],
  } as any);

  assert.equal(model.sections.at(-1)?.kind, "issues");
  assert.ok(model.sections.at(-1)?.rows.some((row) => row.status === "error"));
});

test("buildTimelineDetailModel splits repeated section runs when interrupted", () => {
  const model = buildTimelineDetailModel({
    parts: [
      {
        type: "tool",
        tool: "read",
        state: { input: { filePath: "packages/app/src/app/components/session/message-list.tsx" } },
      },
      {
        type: "tool",
        tool: "bash",
        state: { input: { command: "pnpm typecheck" }, status: "completed" },
      },
      {
        type: "tool",
        tool: "grep",
        state: { input: { pattern: "timeline" } },
      },
    ],
  } as any);

  const exploreCount = model.sections.filter((section) => section.kind === "explore").length;
  assert.equal(exploreCount, 2);
});

test("buildCollapsedSummary prefers human readable summaries", () => {
  const summary = buildCollapsedSummary({
    sections: [
      {
        kind: "explore" as TimelineSectionKind,
        title: "Explore",
        summary: "Prozkoumáno 3 soubory",
        rows: [],
      },
      {
        kind: "action" as TimelineSectionKind,
        title: "Action",
        summary: "2 akce",
        rows: [],
      },
      {
        kind: "verify" as TimelineSectionKind,
        title: "Verify",
        summary: "ověření OK",
        rows: [],
      },
    ],
    latestLabel: "typecheck",
  } as any);

  assert.equal(summary, "Prozkoumáno 3 soubory · 2 akce · ověření OK");
});

test("buildCollapsedSummary includes the latest label when present", () => {
  const summary = buildCollapsedSummary({
    sections: [
      {
        kind: "action" as TimelineSectionKind,
        title: "Action",
        summary: "2 akce",
        rows: [],
      },
    ],
    latestLabel: "typecheck",
  } as any);

  assert.equal(summary, "2 akce · poslední: typecheck");
});

test("buildTimelineDetailModel emits readable row copy for file reads", () => {
  const model = buildTimelineDetailModel({
    parts: [
      {
        type: "tool",
        tool: "read",
        state: {
          input: { filePath: "packages/app/src/app/components/session/message-list.tsx" },
          output: "Success. Updated the following files: M message-list.tsx",
        },
      },
    ],
  } as any);

  const row = model.sections[0]?.rows[0];
  assert.equal(row?.primary, "Načetl message-list.tsx");
  assert.equal(row?.secondary, "řádky 640-1040 · timeline labels a summary");
});
