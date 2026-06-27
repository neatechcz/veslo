import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runtimePromptsSource = readFileSync(
  new URL("../../context/session-runtime-prompts.ts", import.meta.url),
  "utf8",
);

const sourceBetween = (source: string, startNeedle: string, endNeedle: string) => {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `source should contain ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `source should contain ${endNeedle} after ${startNeedle}`);
  return source.slice(start, end);
};

test("pending questions are refreshed per routed workspace", () => {
  const refreshSource = sourceBetween(
    runtimePromptsSource,
    "  async function refreshPendingQuestions() {",
    "  async function respondPermission(",
  );

  assert.match(refreshSource, /deps\.routing\.forEach\(\(wsId, client\) => \{/);
  assert.match(refreshSource, /workspaceId: wsId/);
  assert.match(refreshSource, /setPendingQuestionsByWs\(nextByWs\)/);
  assert.match(refreshSource, /deps\.setStore\("pendingQuestions", activeList\)/);
});

test("pending permission and question modals do not fall back while no real session is selected", () => {
  const permissionSource = sourceBetween(
    runtimePromptsSource,
    "  const activePermission = () => {",
    "  const activeQuestion = () => {",
  );
  const questionSource = sourceBetween(
    runtimePromptsSource,
    "  const activeQuestion = () => {",
    "  const setPendingPermissions = ",
  );

  assert.match(
    permissionSource,
    /const id = deps\.selectedSessionId\(\);[\s\S]*if \(id\) \{[\s\S]*if \(scoped\) return scoped;[\s\S]*\} else \{\s*return null;\s*\}/s,
    "permission modal should not surface an unrelated background request while the UI is on a pending/new chat",
  );
  assert.match(
    questionSource,
    /const id = deps\.selectedSessionId\(\);[\s\S]*if \(id\) \{[\s\S]*if \(scopedFromAnyWorkspace\) return scopedFromAnyWorkspace;[\s\S]*\} else \{\s*return null;\s*\}/s,
    "question modal should not surface an unrelated background request while the UI is on a pending/new chat",
  );
});

test("question replies route to the workspace that owns the question", () => {
  const respondSource = sourceBetween(
    runtimePromptsSource,
    "  async function respondQuestion(",
    "  async function rejectQuestion(",
  );
  const rejectSource = sourceBetween(
    runtimePromptsSource,
    "  async function rejectQuestion(",
    "  const activePermission = ",
  );

  for (const block of [respondSource, rejectSource]) {
    assert.match(block, /allPendingQuestions\(\)\.find\(\(q\) => q\.id === requestID\)/);
    assert.match(block, /question\?\.workspaceId[\s\S]*deps\.routing\.client\(question\.workspaceId\)/);
    assert.doesNotMatch(
      block,
      /const c = deps\.routing\.active\(\);/,
      "question reply/reject must not unconditionally use the active workspace client",
    );
  }
});
