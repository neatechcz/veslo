import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addMcp, listMcp, refreshMcpRuntimeToken, removeMcp } from "../mcp.js";
import { registerMcpRoutes } from "../routes/mcp.js";
import { matchRoute, type Route } from "../routing.js";

describe("MCP routes", () => {
  test("registers the hub and workspace MCP contract", () => {
    const routes: Route[] = [];
    registerMcpRoutes(routes, {
      fetchOpencodeJson: async () => ({}),
    });

    expect(routes).toHaveLength(7);

    const expectedRoutes = [
      ["GET", "/hub/mcp"],
      ["GET", "/workspace/demo/mcp"],
      ["POST", "/workspace/demo/mcp/hub/google-gmail"],
      ["POST", "/workspace/demo/mcp/google-gmail/runtime-token/refresh"],
      ["POST", "/workspace/demo/mcp"],
      ["DELETE", "/workspace/demo/mcp/google-gmail"],
      ["DELETE", "/workspace/demo/mcp/google-gmail/auth"],
    ] as const;

    for (const [method, path] of expectedRoutes) {
      const route = matchRoute(routes, method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe("client");
    }

    expect(matchRoute(routes, "GET", "/workspace/demo/extensions/mcp")).toBeNull();
  });

  test("listMcp ignores future mcp.servers shape instead of listing a fake servers entry", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-mcp-servers-shape-"));
    try {
      await writeFile(
        join(workspaceRoot, "opencode.jsonc"),
        JSON.stringify({
          mcp: {
            servers: {
              future: {
                type: "remote",
                url: "https://future.example/mcp",
              },
            },
            current: {
              type: "remote",
              url: "https://current.example/mcp",
            },
          },
        }),
      );

      const items = await listMcp(workspaceRoot);
      const projectNames = items.filter((item) => item.source === "config.project").map((item) => item.name);

      expect(projectNames).toContain("current");
      expect(projectNames).not.toContain("servers");
      expect(items.find((item) => item.name === "current")?.config).toEqual({
        type: "remote",
        url: "https://current.example/mcp",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("write paths preserve future mcp.servers while mutating top-level MCP entries", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-mcp-servers-preserve-"));
    const configPath = join(workspaceRoot, "opencode.jsonc");
    const futureServers = {
      future: {
        type: "remote",
        url: "https://future.example/mcp",
      },
    };
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          mcp: {
            servers: futureServers,
            current: {
              type: "remote",
              url: "https://current.example/mcp",
            },
          },
        }),
      );

      await addMcp(workspaceRoot, "added", {
        type: "remote",
        url: "https://added.example/mcp",
      });
      let config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, Record<string, unknown>>;
      expect(config.mcp?.servers).toEqual(futureServers);
      expect(config.mcp?.added).toEqual({
        type: "remote",
        url: "https://added.example/mcp",
      });

      await refreshMcpRuntimeToken(workspaceRoot, "current", "runtime-token");
      config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, Record<string, unknown>>;
      expect(config.mcp?.servers).toEqual(futureServers);
      expect(config.mcp?.current).toEqual({
        type: "remote",
        url: "https://current.example/mcp",
        headers: {
          "X-Veslo-Connector-Token": "runtime-token",
        },
      });

      expect(await removeMcp(workspaceRoot, "added")).toBe(true);
      config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, Record<string, unknown>>;
      expect(config.mcp?.servers).toEqual(futureServers);
      expect(config.mcp?.added).toBeUndefined();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("listMcp honors official tools false globs and legacy tools.deny as disabled markers", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-mcp-tools-disabled-"));
    try {
      await writeFile(
        join(workspaceRoot, "opencode.jsonc"),
        JSON.stringify({
          tools: {
            "github*": false,
            deny: ["mcp.legacy.*"],
          },
          mcp: {
            github: {
              type: "remote",
              url: "https://github.example/mcp",
            },
            legacy: {
              type: "remote",
              url: "https://legacy.example/mcp",
            },
            active: {
              type: "remote",
              url: "https://active.example/mcp",
            },
          },
        }),
      );

      const byName = new Map((await listMcp(workspaceRoot)).map((item) => [item.name, item]));

      expect(byName.get("github")?.disabledByTools).toBe(true);
      expect(byName.get("legacy")?.disabledByTools).toBe(true);
      expect(byName.get("active")?.disabledByTools).toBeUndefined();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
