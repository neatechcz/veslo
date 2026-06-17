import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

test("sendPrompt removes optimistic pending sidebar rows when session creation does not materialize", () => {
  const start = appSource.indexOf("  async function sendPrompt(");
  const end = appSource.indexOf("  async function replaceUserMessage(", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  const source = appSource.slice(start, end);

  assert.match(source, /let pendingSidebarRowRegistered = false;/);
  assert.match(source, /const cleanupPendingSidebarSession = \(\) => \{[\s\S]*removeSessionFromWorkspaceSidebar\(pendingSidebarSession\.workspaceId, pendingSidebarSession\.id\);/);
  assert.match(source, /registerPendingSidebarSession\(pendingSidebarSession\);[\s\S]*pendingSidebarRowRegistered = true;/);
  assert.match(source, /if \(materializedSessionId\) \{[\s\S]*pendingSidebarRowRegistered = false;[\s\S]*\} else \{[\s\S]*cleanupPendingSidebarSession\(\);/);
  assert.match(source, /recordSendTrace\("sendPrompt:blocked-no-session"[\s\S]*cleanupPendingSidebarSession\(\);[\s\S]*stopSendPromptBusy\(\);/);
});
