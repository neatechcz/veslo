import assert from "node:assert/strict";
import test from "node:test";

import { projectSidebarSessionActivity } from "../../context/sidebar-session-activity-projection";
import { scopedSessionStatusKey } from "../../lib/scoped-session-status";

const row = (workspaceId = "ws-a", sessionId = "ses-a") => ({
  rowKey: `${workspaceId}:${sessionId}`,
  workspace: { id: workspaceId },
  session: { id: sessionId, conversationId: `conv-${sessionId}`, opencodeSessionId: `oc-${sessionId}` },
}) as never;

const project = (overrides: Record<string, unknown> = {}) =>
  projectSidebarSessionActivity({
    rows: [row()],
    sessionStatusById: {},
    workspaceBusy: {},
    diagnostics: {},
    tokens: {},
    ...overrides,
  });

test("current terminal lifecycle releases stale running status only for its durable token", () => {
  const key = scopedSessionStatusKey("ws-a", "ses-a");
  const result = project({
    sessionStatusById: { [key]: "running" },
    tokens: { [key]: { kind: "durable", generation: 1, runId: "run-a" } },
    diagnostics: { [key]: { status: "completed", stale: false, runId: "run-a", sessionId: "ses-a", workspaceId: "ws-a", conversationId: "conv-ses-a" } },
  });
  assert.deepEqual(result["ws-a:ses-a"], { active: false, phase: "idle", source: "terminal-lifecycle" });
});

test("old terminal cannot suppress a newer durable run", () => {
  const key = scopedSessionStatusKey("ws-a", "ses-a");
  const result = project({
    sessionStatusById: { [key]: "running" },
    tokens: { [key]: { kind: "durable", generation: 2, runId: "run-b" } },
    diagnostics: { [key]: { status: "completed", stale: false, runId: "run-a", sessionId: "ses-a", workspaceId: "ws-a", conversationId: "conv-ses-a" } },
  });
  assert.deepEqual(result["ws-a:ses-a"], { active: true, phase: "running", source: "session-status" });
});

test("scoped status cannot leak from another workspace", () => {
  const result = project({
    sessionStatusById: { [scopedSessionStatusKey("ws-b", "ses-a")]: "running", "ses-a": "running" },
  });
  assert.deepEqual(result["ws-a:ses-a"], { active: false, phase: "idle", source: null });
});

test("failed current lifecycle is inactive error and stale terminal is ignored", () => {
  const key = scopedSessionStatusKey("ws-a", "ses-a");
  const tokens = { [key]: { kind: "durable" as const, generation: 1, runId: "run-a" } };
  const failed = project({
    tokens,
    diagnostics: { [key]: { status: "failed", stale: false, runId: "run-a", sessionId: "ses-a", workspaceId: "ws-a", conversationId: "conv-ses-a" } },
  });
  assert.deepEqual(failed["ws-a:ses-a"], { active: false, phase: "error", source: "terminal-lifecycle" });
  const stale = project({
    sessionStatusById: { [key]: "running" },
    tokens,
    diagnostics: { [key]: { status: "completed", stale: true, runId: "run-a", sessionId: "ses-a", workspaceId: "ws-a", conversationId: "conv-ses-a" } },
  });
  assert.equal(stale["ws-a:ses-a"]?.active, true);
});
