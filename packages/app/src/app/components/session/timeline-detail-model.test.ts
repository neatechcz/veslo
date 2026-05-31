import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCollapsedSummary,
  buildTimelineDetailModel,
  type TimelineSectionKind,
} from "./timeline-detail-model.js";
import { setLocale } from "../../../i18n/index.js";

setLocale("cs");

test("buildTimelineDetailModel derives explore and action sections", () => {
  const model = buildTimelineDetailModel({
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

  const kinds = model.sections.map((section) => section.kind);

  assert.deepEqual(kinds, ["explore", "action"]);
  assert.ok(model.sections[0]?.rows.some((row) => row.primary.includes("message-list.tsx")));
  assert.ok(model.sections[1]?.rows.some((row) => row.primary.toLowerCase().includes("typecheck")));
});

test("buildTimelineDetailModel classifies edit write task and skill as action", () => {
  const model = buildTimelineDetailModel({
    parts: [
      {
        type: "tool",
        tool: "edit",
        state: { input: { filePath: "packages/app/src/app/components/session/message-list.tsx" }, status: "completed" },
      },
      {
        type: "tool",
        tool: "write",
        state: { input: { filePath: "packages/app/src/app/components/session/timeline-detail-model.ts" }, status: "completed" },
      },
      {
        type: "tool",
        tool: "task",
        state: { input: { description: "Delegate a review pass" }, status: "completed" },
      },
      {
        type: "tool",
        tool: "skill",
        state: { input: { name: "brainstorming" }, status: "completed" },
      },
    ],
  } as any);

  const kinds = model.sections.map((section) => section.kind);
  assert.ok(kinds.every((kind) => kind === "action"));
  assert.ok(model.sections.some((section) => section.rows.some((row) => row.primary.toLowerCase().includes("message-list.tsx"))));
  assert.ok(model.sections.some((section) => section.rows.some((row) => row.primary.toLowerCase().includes("timeline-detail-model.ts"))));
  assert.ok(model.sections.some((section) => section.rows.some((row) => row.primary.toLowerCase().includes("review pass"))));
  assert.ok(model.sections.some((section) => section.rows.some((row) => row.primary.toLowerCase().includes("brainstorming"))));
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

test("buildTimelineDetailModel does not promote generic reasoning to plan", () => {
  const model = buildTimelineDetailModel({
    parts: [
      { type: "reasoning", text: "First inspect the session timeline and then adjust the UI." },
      {
        type: "tool",
        tool: "read",
        state: { input: { filePath: "packages/app/src/app/components/session/message-list.tsx" } },
      },
    ],
  } as any);

  assert.ok(model.sections.every((section) => section.kind !== "plan"));
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

test("buildTimelineDetailModel routes strong error payloads in title detail and error into issues", () => {
  const model = buildTimelineDetailModel({
    parts: [
      {
        type: "tool",
        tool: "bash",
        state: {
          input: { command: "pnpm test" },
          title: "Unknown tool",
          detail: "tool not found in the current runtime",
          error: "",
        },
      },
    ],
  } as any);

  assert.equal(model.sections.at(-1)?.kind, "issues");
  assert.ok(model.sections.at(-1)?.rows.some((row) => row.status === "error"));
});

test("buildTimelineDetailModel keeps generic error text out of issues without explicit signal", () => {
  const model = buildTimelineDetailModel({
    parts: [
      {
        type: "tool",
        tool: "bash",
        state: {
          input: { command: "pnpm test" },
          detail: "error while streaming output",
        },
      },
      {
        type: "tool",
        tool: "bash",
        state: {
          input: { command: "pnpm lint" },
          detail: "failed to parse diagnostics",
        },
      },
    ],
  } as any);

  assert.ok(model.sections.every((section) => section.kind !== "issues"));
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

test("buildTimelineDetailModel keeps same basenames distinguishable in read details", () => {
  const model = buildTimelineDetailModel({
    parts: [
      {
        type: "tool",
        tool: "read",
        state: { input: { filePath: "packages/app/src/app/components/session/message-list.tsx" } },
      },
      {
        type: "tool",
        tool: "read",
        state: { input: { filePath: "packages/app/src/app/utils/message-list.tsx" } },
      },
    ],
  } as any);

  const rows = model.sections.flatMap((section) => section.rows);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]?.secondary, rows[1]?.secondary);
  assert.match(rows[0]?.secondary ?? "", /message-list\.tsx/i);
  assert.match(rows[1]?.secondary ?? "", /message-list\.tsx/i);
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
  assert.ok(row?.secondary);
  assert.match(row?.secondary ?? "", /message-list\.tsx/i);
});

test("buildTimelineDetailModel uses a thinking fallback instead of a generic note label", () => {
  const model = buildTimelineDetailModel({
    parts: [{ type: "reasoning", text: "" }],
  } as any);

  const row = model.sections[0]?.rows[0];
  assert.equal(row?.rowType, "note");
  assert.equal(row?.primary, "Přemýšlení");
});

test("buildTimelineDetailModel marks stale running reasoning as done after a later response part", () => {
  const model = buildTimelineDetailModel({
    parts: [
      {
        type: "reasoning",
        text: "Analyzing context",
        state: { status: "pending" },
      },
      {
        type: "text",
        text: "Hotovo.",
      },
    ],
  } as any);

  const section = model.sections[0];
  const firstRow = section?.rows[0];
  assert.equal(firstRow?.rowType, "note");
  assert.equal(firstRow?.status, "done");
  assert.equal(section?.status, "done");
});
