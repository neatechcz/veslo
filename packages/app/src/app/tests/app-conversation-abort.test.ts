import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("conversation runs remember the submitted run id for scoped abort", () => {
  const runStart = source.indexOf("  const runConversationFromVesloWriteApi = async (");
  const abortStart = source.indexOf("  const abortConversationFromVesloWriteApi = async (", runStart);
  assert.notEqual(runStart, -1, "runConversationFromVesloWriteApi should exist");
  assert.notEqual(abortStart, -1, "abortConversationFromVesloWriteApi should follow runConversationFromVesloWriteApi");

  const runSource = source.slice(runStart, abortStart);
  assert.match(
    runSource,
    /rememberLatestConversationRunId\(\{[\s\S]*workspaceId,[\s\S]*conversationId: result\.conversationId,[\s\S]*opencodeSessionId: result\.opencodeSessionId,[\s\S]*uiSessionId: normalizedSessionId,[\s\S]*runId: result\.runId,[\s\S]*\}\);/,
    "successful conversation runs should remember their submitted run id under Veslo and UI identities",
  );
});

test("abortSession routes scoped conversations through Veslo abort and scoped legacy fallback", () => {
  const abortWrapperStart = source.indexOf("  const abortConversationFromVesloWriteApi = async (");
  const sessionStoreStart = source.indexOf("  const sessionStore = createSessionStore(", abortWrapperStart);
  assert.notEqual(abortWrapperStart, -1, "abortConversationFromVesloWriteApi should exist");
  assert.notEqual(sessionStoreStart, -1, "abortConversationFromVesloWriteApi should end before session store setup");
  const abortWrapperSource = source.slice(abortWrapperStart, sessionStoreStart);
  assert.match(
    abortWrapperSource,
    /const runId = resolveLatestConversationRunId\(\{[\s\S]*conversationId,[\s\S]*opencodeSessionId: scope\?\.opencodeSessionId,[\s\S]*uiSessionId: normalizedSessionId,[\s\S]*\}\);[\s\S]*if \(!runId\) \{[\s\S]*throw new Error\("Conversation run id is not available for abort\."\);[\s\S]*\}/,
    "conversation abort should require an explicit run id from the scoped run map",
  );
  assert.match(
    abortWrapperSource,
    /serverClient\.abortConversation\(serverWorkspaceId, conversationId, \{[\s\S]*directory,[\s\S]*runId,[\s\S]*\}\)/,
    "conversation abort should call the local Veslo abort endpoint",
  );

  const abortSessionStart = source.indexOf("  async function abortSession(");
  const retryStart = source.indexOf("  function retryLastPrompt()", abortSessionStart);
  assert.notEqual(abortSessionStart, -1, "abortSession should exist");
  assert.notEqual(retryStart, -1, "abortSession should end before retryLastPrompt");
  const abortSessionSource = source.slice(abortSessionStart, retryStart);
  const serviceCall = abortSessionSource.indexOf("abortConversationFromVesloWriteApi(id)");
  const scopedFallbackHelper = abortSessionSource.indexOf("const abortSessionViaScopedLegacy = async");
  const scopedFallbackCall = abortSessionSource.indexOf("if (await abortSessionViaScopedLegacy())");
  const fallbackWarn = abortSessionSource.indexOf('console.warn("[conversation-abort] falling back to OpenCode SDK", error);');
  const legacyAbort = abortSessionSource.indexOf("await abortSessionTyped(c, id);");
  const finalThrow = abortSessionSource.indexOf("throw error;", scopedFallbackCall);
  assert.ok(serviceCall >= 0, "abortSession should attempt Veslo abort first");
  assert.ok(scopedFallbackHelper >= 0 && scopedFallbackHelper < serviceCall, "abortSession should define a scoped legacy fallback before service errors");
  assert.ok(scopedFallbackCall > serviceCall, "known scoped conversations should try scoped legacy abort before throwing service errors");
  assert.ok(finalThrow > scopedFallbackCall, "scoped abort should throw only after scoped legacy fallback is unavailable");
  assert.ok(fallbackWarn > finalThrow, "active legacy fallback should only be reachable for unscoped migration cases");
  assert.ok(legacyAbort > fallbackWarn, "active OpenCode abort should remain only as an unscoped migration fallback");
  assert.match(
    abortSessionSource,
    /const scopedEntry = workspaceRouting\.entry\(scope\.workspaceId\);[\s\S]*scopedEntry\?\.client[\s\S]*await abortSessionTyped\(scopedClient, opencodeSessionId, \{[\s\S]*directory: scope\.directory\?\.trim\(\) \|\| undefined,[\s\S]*\}\);/,
    "scoped fallback should use the exact workspace entry client and directory, not the active workspace client",
  );
});
