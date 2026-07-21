import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createConversationSubmitSkillCommandResolver } from "../conversation-submit-skill-command-resolution.js";
import type { WorkspaceInfo } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

const workspace = (root: string): WorkspaceInfo => ({
  id: "ws_1",
  name: "Workspace",
  path: root,
  workspaceType: "local",
  baseUrl: "http://127.0.0.1:9",
});

describe("conversation submit skill command resolution", () => {
  test("matches implicit prompts against workspace skills", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-skill-resolver-"));
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-submit-skill-resolver-data-"));
    tempDirs.push(workspaceRoot, dataDir);
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });
    await mkdir(join(workspaceRoot, ".opencode", "skills", "company-research-czech"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".opencode", "skills", "company-research-czech", "SKILL.md"),
      [
        "---",
        "name: company-research-czech",
        "description: Use when user asks for company search and profile extraction from a website.",
        "trigger: company search",
        "---",
        "",
        "# Company Research Czech",
        "",
      ].join("\n"),
      "utf8",
    );

    const resolver = createConversationSubmitSkillCommandResolver({ dataDir });
    const result = await resolver({
      request: {
        clientMessageId: "msg_1",
        origin: "session:normal",
        draft: {
          mode: "prompt",
          text: "https://example.test use company search skill for this",
          parts: [],
        },
      },
      text: "https://example.test use company search skill for this",
      workspace: workspace(workspaceRoot),
      includeGlobal: false,
    });

    expect(result).toBe("company-research-czech");
  });

  test("never resolves a raw user-global skill even when legacy includeGlobal is true", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-global-workspace-"));
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-submit-global-data-"));
    const homeDir = await mkdtemp(join(tmpdir(), "veslo-submit-global-home-"));
    tempDirs.push(workspaceRoot, dataDir, homeDir);
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });
    await mkdir(join(homeDir, ".config", "opencode", "skills", "raw-global"), { recursive: true });
    await writeFile(
      join(homeDir, ".config", "opencode", "skills", "raw-global", "SKILL.md"),
      "---\nname: raw-global\ndescription: Raw global skill\n---\n",
      "utf8",
    );

    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const resolver = createConversationSubmitSkillCommandResolver({ dataDir });
      const result = await resolver({
        request: {
          clientMessageId: "msg-global-1",
          origin: "session:normal",
          draft: { mode: "prompt", text: "use raw global skill", parts: [] },
        },
        text: "use raw global skill",
        workspace: workspace(workspaceRoot),
        includeGlobal: true,
      });
      expect(result).toBeNull();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
