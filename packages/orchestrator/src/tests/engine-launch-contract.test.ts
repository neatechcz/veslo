import { describe, expect, test } from "bun:test";

import {
  buildEngineConfigEnv,
  buildEngineSkillBindingResponseHeaders,
  buildEngineSkillIsolationEnv,
  buildEngineSkillViewEnv,
} from "../engine-launch-contract.js";

describe("engine launch config contract", () => {
  test("confirms the selected engine Skills binding without requiring a run owner", () => {
    expect(buildEngineSkillBindingResponseHeaders({
      skillViewRevision: "view-1",
      authorizationRevision: "authorization-1",
      openCodeConfigDigest: "config-1",
    })).toEqual({
      "x-veslo-engine-skill-view-revision": "view-1",
      "x-veslo-engine-authorization-revision": "authorization-1",
      "x-veslo-engine-config-digest": "config-1",
    });
    expect(buildEngineSkillBindingResponseHeaders({})).toEqual({});
  });

  test("isolates config discovery while leaving data/auth inheritance to the caller", () => {
    expect(buildEngineConfigEnv("  C:\\veslo\\workspace-config  ")).toEqual({
      OPENCODE_CONFIG_DIR: "C:\\veslo\\workspace-config",
      XDG_CONFIG_HOME: "C:\\veslo\\workspace-config",
    });
  });

  test("does not inject config overrides when a workspace has no config directory", () => {
    expect(buildEngineConfigEnv()).toEqual({});
    expect(buildEngineConfigEnv("   ")).toEqual({});
  });

  test("closes native project discovery for every engine profile", () => {
    expect(buildEngineSkillIsolationEnv(" C:\\cfg\\opencode.jsonc ")).toEqual({
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_CONFIG: "C:\\cfg\\opencode.jsonc",
    });
    expect(buildEngineSkillIsolationEnv(" C:\\cfg\\opencode.jsonc ", "hardened")).toEqual({
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_CONFIG: "C:\\cfg\\opencode.jsonc",
    });
    expect(() => buildEngineSkillIsolationEnv(" ")).toThrow("sanitized OpenCode config snapshot");
  });

  test("publishes the Veslo-owned effective skill view as an explicit engine config merge", () => {
    expect(buildEngineSkillViewEnv([" C:\\veslo\\workspace-config\\skill-a ", "C:\\veslo\\workspace-config\\skill-b"])).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: ["C:\\veslo\\workspace-config\\skill-a", "C:\\veslo\\workspace-config\\skill-b"] } }),
    });
    expect(buildEngineSkillViewEnv()).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: [] } }),
    });
    expect(buildEngineSkillViewEnv(["C:\\skill-a"], JSON.stringify({ mcp: { local: true }, skills: { urls: ["https://example.test"] } }))).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        mcp: { local: true },
        skills: { paths: ["C:\\skill-a"] },
      }),
    });
    expect(buildEngineSkillViewEnv([".opencode/skills/selected"])).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        skills: { paths: [".opencode/skills/selected"] },
      }),
    });
    expect(buildEngineSkillViewEnv([], undefined, "C:\\config\\AGENTS.md")).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        instructions: ["C:\\config\\AGENTS.md"],
        skills: { paths: [] },
      }),
    });
  });
});
