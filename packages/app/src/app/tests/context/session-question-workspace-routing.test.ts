import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("../../context/session.ts", import.meta.url), "utf8");

const sourceBetween = (source: string, startNeedle: string, endNeedle: string) => {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `source should contain ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `source should contain ${endNeedle} after ${startNeedle}`);
  return source.slice(start, end);
};

test("pending questions are refreshed per routed workspace", () => {
  const refreshSource = sourceBetween(
    sessionSource,
    "  async function refreshPendingQuestions() {",
    "  function setMessagesForSession(",
  );

  assert.match(refreshSource, /options\.routing\.forEach\(\(wsId, client\) => \{/);
  assert.match(refreshSource, /workspaceId: wsId/);
  assert.match(refreshSource, /setPendingQuestionsByWs\(nextByWs\)/);
  assert.match(refreshSource, /setStore\("pendingQuestions", activeList\)/);
});

test("pending permission and question modals do not fall back while no real session is selected", () => {
  const permissionSource = sourceBetween(
    sessionSource,
    "  const activePermission = createMemo(() => {",
    "  const activeQuestion = createMemo(() => {",
  );
  const questionSource = sourceBetween(
    sessionSource,
    "  const activeQuestion = createMemo(() => {",
    "  const [questionReplyBusy, setQuestionReplyBusy] = createSignal(false);",
  );

  assert.match(
    permissionSource,
    /const id = options\.selectedSessionId\(\);[\s\S]*if \(id\) \{[\s\S]*if \(scoped\) return scoped;[\s\S]*\} else \{\s*return null;\s*\}/s,
    "permission modal should not surface an unrelated background request while the UI is on a pending/new chat",
  );
  assert.match(
    questionSource,
    /const id = options\.selectedSessionId\(\);[\s\S]*if \(id\) \{[\s\S]*if \(scopedFromAnyWorkspace\) return scopedFromAnyWorkspace;[\s\S]*\} else \{\s*return null;\s*\}/s,
    "question modal should not surface an unrelated background request while the UI is on a pending/new chat",
  );
});

test("question replies route to the workspace that owns the question", () => {
  const respondSource = sourceBetween(
    sessionSource,
    "  async function respondQuestion(",
    "  async function rejectQuestion(",
  );
  const rejectSource = sourceBetween(
    sessionSource,
    "  async function rejectQuestion(",
    "  const setSessions = ",
  );

  for (const block of [respondSource, rejectSource]) {
    assert.match(block, /allPendingQuestions\(\)\.find\(\(q\) => q\.id === requestID\)/);
    assert.match(block, /question\?\.workspaceId[\s\S]*options\.routing\.client\(question\.workspaceId\)/);
    assert.doesNotMatch(
      block,
      /const c = options\.routing\.active\(\);/,
      "question reply/reject must not unconditionally use the active workspace client",
    );
  }
});
