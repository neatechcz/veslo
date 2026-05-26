import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorkspaceInfos,
  persistServerWorkspaceState,
  workspaceIdForPath,
} from "./workspaces.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

function makeConfig(overrides: Partial<ServerConfig>): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "t",
    hostToken: "h",
    approval: { mode: "manual", timeoutMs: 30000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
    debugLogs: {
      enabled: false,
      ingestUrl: null,
      ingestToken: null,
      batchMaxEvents: 200,
      batchMaxBytes: 256 * 1024,
      spoolMaxBytes: 100 * 1024 * 1024,
      flushIntervalMs: 5_000,
    },
    ...overrides,
  };
}

function ws(path: string, name?: string): WorkspaceInfo {
  return {
    id: workspaceIdForPath(path),
    name: name ?? path.split("/").pop()!,
    path,
    workspaceType: "local",
  };
}

describe("workspaceIdForPath", () => {
  test("deterministic for same path", () => {
    const a = workspaceIdForPath("/tmp/foo");
    const b = workspaceIdForPath("/tmp/foo");
    expect(a).toBe(b);
  });

  test("differs for different paths", () => {
    expect(workspaceIdForPath("/tmp/a")).not.toBe(workspaceIdForPath("/tmp/b"));
  });

  test("returns ws- prefixed 15-char id matching orchestrator/Tauri scheme", () => {
    const id = workspaceIdForPath("/tmp/foo");
    expect(id.startsWith("ws-")).toBe(true);
    expect(id.length).toBe(3 + 12);
  });
});

describe("buildWorkspaceInfos", () => {
  test("resolves relative path against cwd", () => {
    const infos = buildWorkspaceInfos([{ path: "relative/sub" }], "/base/cwd");
    expect(infos[0]!.path).toBe("/base/cwd/relative/sub");
  });

  test("derives name from basename if not provided", () => {
    const infos = buildWorkspaceInfos([{ path: "/tmp/foo" }], "/cwd");
    expect(infos[0]!.name).toBe("foo");
  });

  test("respects explicit name", () => {
    const infos = buildWorkspaceInfos([{ path: "/tmp/foo", name: "MyProj" }], "/cwd");
    expect(infos[0]!.name).toBe("MyProj");
  });
});

describe("persistServerWorkspaceState", () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "veslo-workspaces-test-"));
    configPath = join(dir, "server.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns false when configPath is missing", async () => {
    const config = makeConfig({ workspaces: [ws("/tmp/a")] });
    const ok = await persistServerWorkspaceState(config);
    expect(ok).toBe(false);
  });

  test("writes a fresh config file when none exists", async () => {
    const config = makeConfig({
      configPath,
      workspaces: [ws("/tmp/a"), ws("/tmp/b")],
      authorizedRoots: ["/tmp/a", "/tmp/b"],
    });
    const ok = await persistServerWorkspaceState(config);
    expect(ok).toBe(true);

    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.workspaces).toHaveLength(2);
    expect(parsed.workspaces[0].path).toBe("/tmp/a");
    expect(parsed.authorizedRoots).toEqual(["/tmp/a", "/tmp/b"]);
  });

  test("preserves non-workspace fields when merging into existing config", async () => {
    // Seed existing config with arbitrary unrelated fields
    await writeFile(
      configPath,
      JSON.stringify({
        host: "1.2.3.4",
        port: 9999,
        token: "preexisting-token",
        approval: { mode: "auto" },
        opencodeUsername: "ben",
        workspaces: [{ path: "/old/path" }],
      }),
      "utf8",
    );

    const config = makeConfig({
      configPath,
      workspaces: [ws("/tmp/new")],
      authorizedRoots: ["/tmp/new"],
    });
    await persistServerWorkspaceState(config);

    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    expect(parsed.host).toBe("1.2.3.4");
    expect(parsed.port).toBe(9999);
    expect(parsed.token).toBe("preexisting-token");
    expect(parsed.approval).toEqual({ mode: "auto" });
    expect(parsed.opencodeUsername).toBe("ben");
    expect(parsed.workspaces).toEqual([{ path: "/tmp/new", name: "new", workspaceType: "local" }]);
  });

  test("dedupes authorizedRoots and resolves to absolute", async () => {
    const config = makeConfig({
      configPath,
      workspaces: [],
      authorizedRoots: ["/tmp/x", "/tmp/x", "/tmp/y"],
    });
    await persistServerWorkspaceState(config);

    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    expect(parsed.authorizedRoots).toEqual(["/tmp/x", "/tmp/y"]);
  });

  test("roundtrip preserves workspaces through write+read", async () => {
    const original = [
      ws("/tmp/a"),
      { ...ws("/tmp/b"), directory: "/explicit/dir", workspaceType: "remote" as const, baseUrl: "http://upstream" },
    ];
    const config = makeConfig({ configPath, workspaces: original, authorizedRoots: [] });
    await persistServerWorkspaceState(config);

    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    expect(parsed.workspaces).toEqual([
      { path: "/tmp/a", name: "a", workspaceType: "local" },
      {
        path: "/tmp/b",
        name: "b",
        workspaceType: "remote",
        baseUrl: "http://upstream",
        directory: "/explicit/dir",
      },
    ]);
  });

  test("survives corrupt existing JSON by overwriting clean", async () => {
    await writeFile(configPath, "{ this is not json", "utf8");
    const config = makeConfig({ configPath, workspaces: [ws("/tmp/a")], authorizedRoots: [] });
    const ok = await persistServerWorkspaceState(config);
    expect(ok).toBe(true);

    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    expect(parsed.workspaces).toHaveLength(1);
    expect(parsed.workspaces[0].path).toBe("/tmp/a");
  });

  test("does not leave behind .tmp files on success", async () => {
    const config = makeConfig({ configPath, workspaces: [ws("/tmp/a")], authorizedRoots: [] });
    await persistServerWorkspaceState(config);

    // Check that no stray .tmp.<id> files linger
    const entries = await readdir(dir);
    const tmpFiles = entries.filter((entry) => entry.includes(".tmp."));
    expect(tmpFiles).toEqual([]);
  });

  test("creates parent directory if missing", async () => {
    const nestedPath = join(dir, "deep", "nested", "server.json");
    const config = makeConfig({ configPath: nestedPath, workspaces: [ws("/tmp/a")], authorizedRoots: [] });
    const ok = await persistServerWorkspaceState(config);
    expect(ok).toBe(true);
    const info = await stat(nestedPath);
    expect(info.isFile()).toBe(true);
  });
});
