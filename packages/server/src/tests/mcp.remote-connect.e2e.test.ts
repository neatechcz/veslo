import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      expect(listed.filter((entry) => entry.source === "config.project")).toEqual([]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("lists project disabled sentinels as disabled inherited global MCP entries", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-mcp-disabled-"));
    const homeRoot = await mkdtemp(join(tmpdir(), "veslo-mcp-home-"));
    const configHome = join(homeRoot, ".config");
    const globalConfigDir = join(configHome, "opencode");
    const previousHome = process.env.HOME;
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;

    process.env.HOME = homeRoot;
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await mkdir(globalConfigDir, { recursive: true });
      await writeFile(join(globalConfigDir, "opencode.jsonc"), JSON.stringify({
        mcp: {
          github: { type: "remote", url: "https://global.example/mcp" },
          browser: { type: "local", command: ["node", "browser.js"] },
        },
      }), "utf8");
      await writeFile(join(workspaceRoot, "opencode.jsonc"), JSON.stringify({
        mcp: {
          github: { enabled: false },
        },
      }), "utf8");

      const listed = await listMcp(workspaceRoot);

      expect(listed.map((entry) => `${entry.name}:${entry.source}:${entry.config.enabled}`)).toEqual([
        "browser:config.global:undefined",
        "github:config.project:false",
      ]);
      expect(listed.find((entry) => entry.name === "github")?.config).toEqual({
        type: "remote",
        url: "https://global.example/mcp",
        enabled: false,
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(homeRoot, { recursive: true, force: true });
    }
  });
});
