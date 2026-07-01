import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import {
  buildOpencodeAuthHeader,
  buildOpencodeReloadUrl,
  createWorkspaceConfigOwner,
  normalizeConversationReadDirectoryRequest,
  readVesloConfig,
  resolveConversationReadDirectory,
  writeVesloConfig,
} from "../workspace-config-owner.js";
import { ApiError } from "../errors.js";
import type { WorkspaceInfo } from "../types.js";
import { vesloConfigPath } from "../workspace-files.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempWorkspace(): Promise<WorkspaceInfo> {
  const path = await mkdtemp(join(tmpdir(), "veslo-workspace-config-"));
  tempDirs.push(path);
  return {
    id: "workspace-1",
    name: "Workspace 1",
    path,
    workspaceType: "local",
    directory: path,
  };
}

function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T;
  }
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    output[key] = key.toLowerCase().includes("token") ? "[REDACTED]" : redactSecrets(raw);
  }
  return output as T;
}

describe("workspace-config-owner", () => {
  test("writes veslo.json with explicit replace and merge semantics", async () => {
    const workspace = await tempWorkspace();

    await writeVesloConfig(workspace.path, { a: 1, nested: { old: true } }, false);
    expect(await readVesloConfig(workspace.path)).toEqual({ a: 1, nested: { old: true } });

    await writeVesloConfig(workspace.path, { b: 2 }, true);
    expect(await readVesloConfig(workspace.path)).toEqual({ a: 1, nested: { old: true }, b: 2 });

    await writeVesloConfig(workspace.path, { c: 3 }, false);
    expect(await readVesloConfig(workspace.path)).toEqual({ c: 3 });
    expect((await readFile(vesloConfigPath(workspace.path), "utf8")).endsWith("\n")).toBe(true);
  });

  test("normalizes workspace-relative and WSL conversation directories before authorization", async () => {
    const workspace = await tempWorkspace();
    const nested = join(workspace.path, "nested", "conversations");

    expect(normalizeConversationReadDirectoryRequest(workspace, "/workspace/nested/conversations", workspace.path))
      .toBe(nested);
    expect(await resolveConversationReadDirectory(workspace, "/workspace/nested/conversations"))
      .toBe(resolve(nested));

    try {
      await resolveConversationReadDirectory(workspace, resolve(tmpdir()));
      throw new Error("Expected resolveConversationReadDirectory to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("directory_unauthorized");
    }

    if (process.platform === "win32") {
      expect(normalizeConversationReadDirectoryRequest(workspace, "/mnt/c/Users/demo/project", workspace.path))
        .toBe("C:/Users/demo/project");
    }
  });

  test("builds reload URL and auth header without leaking credentials into URL", () => {
    expect(buildOpencodeReloadUrl("http://127.0.0.1:4096/root", "C:/repo"))
      .toBe("http://127.0.0.1:4096/instance/dispose?directory=C%3A%2Frepo");
    expect(() => buildOpencodeReloadUrl("not a url")).toThrow(ApiError);

    expect(buildOpencodeAuthHeader({
      id: "workspace-1",
      name: "Workspace 1",
      path: "C:/repo",
      workspaceType: "local",
      opencodeUsername: "user",
      opencodePassword: "pass",
    })).toBe("Basic dXNlcjpwYXNz");
  });

  test("exports redacted workspace config through the owner dependency boundary", async () => {
    const workspace = await tempWorkspace();
    const owner = createWorkspaceConfigOwner({
      readOpencodeConfig: async () => ({
        provider: { apiToken: "opencode-secret" },
      }),
      redactSensitiveConfig: redactSecrets,
    });
    await writeVesloConfig(workspace.path, {
      publicValue: "visible",
      nested: { accessToken: "veslo-secret" },
    }, false);

    const payload = await owner.exportWorkspace(workspace);

    expect(payload.workspaceId).toBe("workspace-1");
    expect(payload.opencode).toEqual({ provider: { apiToken: "[REDACTED]" } });
    expect(payload.veslo).toEqual({
      publicValue: "visible",
      nested: { accessToken: "[REDACTED]" },
    });
    expect(Array.isArray(payload.skills)).toBe(true);
    expect(payload.commands).toEqual([]);
  });
});
