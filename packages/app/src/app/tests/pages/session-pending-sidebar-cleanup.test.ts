import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sendWorkflowSource = readFileSync(new URL("../../pages/session-send-workflow.ts", import.meta.url), "utf8");

test("sendPrompt removes optimistic pending sidebar rows when session creation does not materialize", () => {
  const start = sendWorkflowSource.indexOf("  async function sendPrompt(");
  const end = sendWorkflowSource.indexOf("  async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  const source = sendWorkflowSource.slice(start, end);

  assert.match(source, /let pendingSidebarRowRegistered = false;/);
  assert.match(source, /const cleanupPendingSidebarSession = \(\) => \{[\s\S]*deps\.removeSessionFromWorkspaceSidebar\(pendingSidebarSession\.workspaceId, pendingSidebarSession\.id\);/);
  assert.match(source, /deps\.registerPendingSidebarSession\(pendingSidebarSession\);[\s\S]*pendingSidebarRowRegistered = true;/);
  assert.match(source, /if \(materializedSessionId\) \{[\s\S]*pendingSidebarRowRegistered = false;[\s\S]*\} else \{[\s\S]*cleanupPendingSidebarSession\(\);/);
  assert.match(source, /deps\.recordSendTrace\("sendPrompt:blocked-no-session"[\s\S]*cleanupPendingSidebarSession\(\);[\s\S]*stopSendPromptBusy\(\);/);
});
