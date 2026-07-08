import assert from "node:assert/strict";
import test from "node:test";

import {
  SHAREPOINT_MCP_ID,
  markSharePointMcpPromptDismissed,
  shouldPromptSharePointMcpInstall,
} from "../../lib/sharepoint-managed-mcp-onboarding";

function storage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  };
}

test("prompts for SharePoint MCP when Den org has the catalog item but workspace is missing it", () => {
  assert.equal(
    shouldPromptSharePointMcpInstall({
      denOrgId: "org_1",
      hubMcpCards: [{ id: SHAREPOINT_MCP_ID, name: "Microsoft SharePoint" }],
      mcpServers: [],
      storage: storage(),
    }),
    true,
  );
});

test("does not prompt once SharePoint MCP is already installed or dismissed for the org", () => {
  assert.equal(
    shouldPromptSharePointMcpInstall({
      denOrgId: "org_1",
      hubMcpCards: [{ id: SHAREPOINT_MCP_ID, name: "Microsoft SharePoint" }],
      mcpServers: [{ name: SHAREPOINT_MCP_ID, config: { type: "remote" } }],
      storage: storage(),
    }),
    false,
  );

  const dismissedStorage = storage();
  markSharePointMcpPromptDismissed(dismissedStorage, "org_1");
  assert.equal(
    shouldPromptSharePointMcpInstall({
      denOrgId: "org_1",
      hubMcpCards: [{ id: SHAREPOINT_MCP_ID, name: "Microsoft SharePoint" }],
      mcpServers: [],
      storage: dismissedStorage,
    }),
    false,
  );
});

test("detects SharePoint MCP only from the runtime key or Veslo connector header", () => {
  assert.equal(
    shouldPromptSharePointMcpInstall({
      denOrgId: "org_1",
      hubMcpCards: [{ id: SHAREPOINT_MCP_ID, name: "Microsoft SharePoint" }],
      mcpServers: [{
        name: "other",
        config: {
          type: "remote",
          headers: { "X-Unrelated": SHAREPOINT_MCP_ID },
        },
      }],
      storage: storage(),
    }),
    true,
  );

  assert.equal(
    shouldPromptSharePointMcpInstall({
      denOrgId: "org_1",
      hubMcpCards: [{ id: SHAREPOINT_MCP_ID, name: "Microsoft SharePoint" }],
      mcpServers: [{
        name: "other",
        config: {
          type: "remote",
          headers: { "X-Veslo-Connector": SHAREPOINT_MCP_ID },
        },
      }],
      storage: storage(),
    }),
    false,
  );
});
