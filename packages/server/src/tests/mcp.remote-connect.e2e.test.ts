import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { addMcp, listMcp, removeMcp } from "../mcp.js";

describe("mcp remote connect flow", () => {
  test("adds, lists, and removes a remote MCP without OAuth", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-mcp-remote-e2e-"));

    try {
      const added = await addMcp(workspaceRoot, "simple-remote", {
        type: "remote",
        url: "https://example.com/mcp",
        enabled: true,
      });
      expect(added.action).toBe("added");

      const listedAfterAdd = await listMcp(workspaceRoot);
      const item = listedAfterAdd.find((entry) => entry.name === "simple-remote");
      expect(item).toBeDefined();
      expect(item?.config).toEqual({
        type: "remote",
        url: "https://example.com/mcp",
        enabled: true,
      });
      expect(item?.source).toBe("config.project");

      const configText = await readFile(join(workspaceRoot, "opencode.jsonc"), "utf8");
      expect(configText).toContain("\"simple-remote\"");
      expect(configText).toContain("\"https://example.com/mcp\"");

      const removed = await removeMcp(workspaceRoot, "simple-remote");
      expect(removed).toBe(true);

      const listedAfterRemove = await listMcp(workspaceRoot);
      expect(listedAfterRemove.some((entry) => entry.name === "simple-remote")).toBe(false);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects malformed custom MCP configs before writing opencode config", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-mcp-validation-"));

    try {
      await expect(addMcp(workspaceRoot, "bad-url", {
        type: "remote",
        url: "file:///tmp/mcp.sock",
        enabled: true,
      })).rejects.toMatchObject({
        status: 400,
        code: "invalid_mcp_config",
      });

      await expect(addMcp(workspaceRoot, "bad-command", {
        type: "local",
        command: ["node", ""],
        enabled: true,
      })).rejects.toMatchObject({
        status: 400,
        code: "invalid_mcp_config",
      });

      await expect(addMcp(workspaceRoot, "bad-header", {
        type: "remote",
        url: "https://example.com/mcp",
        enabled: true,
        headers: {
          "X-Veslo-Connector-Token": "runtime-token",
        },
      })).rejects.toMatchObject({
        status: 400,
        code: "invalid_mcp_config",
      });

      const listed = await listMcp(workspaceRoot);
      expect(listed).toEqual([]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
