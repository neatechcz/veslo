import assert from "node:assert/strict";
import test from "node:test";

import {
  mcpAutoRefreshTargetKey,
  shouldRefreshMcpAutoRefreshTarget,
} from "../../lib/workspace-runtime-schedulers.js";

test("MCP auto refresh target key is stable and scoped to workspace plus project", () => {
  assert.equal(
    mcpAutoRefreshTargetKey({ workspaceId: " ws-1 ", projectDir: " /repo " }),
    mcpAutoRefreshTargetKey({ workspaceId: "ws-1", projectDir: "/repo" }),
  );
  assert.notEqual(
    mcpAutoRefreshTargetKey({ workspaceId: "ws-1", projectDir: "/repo" }),
    mcpAutoRefreshTargetKey({ workspaceId: "ws-2", projectDir: "/repo" }),
  );
  assert.notEqual(
    mcpAutoRefreshTargetKey({ workspaceId: "ws-1", projectDir: "/repo" }),
    mcpAutoRefreshTargetKey({ workspaceId: "ws-1", projectDir: "/repo-two" }),
  );
});

test("MCP auto refresh target TTL suppresses repeated same-target scheduler ticks", () => {
  const targetKey = mcpAutoRefreshTargetKey({ workspaceId: "ws-1", projectDir: "/repo" });

  assert.equal(
    shouldRefreshMcpAutoRefreshTarget({
      targetKey,
      lastTargetKey: "",
      lastRefreshAt: 0,
      now: 1_000,
      ttlMs: 5_000,
    }),
    true,
  );

  assert.equal(
    shouldRefreshMcpAutoRefreshTarget({
      targetKey,
      lastTargetKey: targetKey,
      lastRefreshAt: 1_000,
      now: 2_000,
      ttlMs: 5_000,
    }),
    false,
  );

  assert.equal(
    shouldRefreshMcpAutoRefreshTarget({
      targetKey,
      lastTargetKey: targetKey,
      lastRefreshAt: 1_000,
      now: 6_000,
      ttlMs: 5_000,
    }),
    true,
  );

  assert.equal(
    shouldRefreshMcpAutoRefreshTarget({
      targetKey: mcpAutoRefreshTargetKey({ workspaceId: "ws-1", projectDir: "/repo-two" }),
      lastTargetKey: targetKey,
      lastRefreshAt: 2_000,
      now: 2_100,
      ttlMs: 5_000,
    }),
    true,
  );
});
