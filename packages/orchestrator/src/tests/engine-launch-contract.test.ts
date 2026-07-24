import { describe, expect, test } from "bun:test";

import {
  buildEngineConfigEnv,
  buildEngineSkillIsolationEnv,
  buildEngineSkillViewEnv,
} from "../engine-launch-contract.js";

describe("engine launch config contract", () => {
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
    expect(buildEngineSkillViewEnv(" C:\\veslo\\workspace-config\\skill-staging ")).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: ["C:\\veslo\\workspace-config\\skill-staging"] } }),
    });
    expect(buildEngineSkillViewEnv()).toEqual({});
    expect(buildEngineSkillViewEnv("C:\\stage", JSON.stringify({ mcp: { local: true }, skills: { urls: ["https://example.test"] } }))).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        mcp: { local: true },
        skills: { paths: ["C:\\stage"] },
      }),
    });
    expect(buildEngineSkillViewEnv(".opencode/.veslo/runtime-skills/current")).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        skills: { paths: [".opencode/.veslo/runtime-skills/current"] },
      }),
    });
    expect(buildEngineSkillViewEnv("C:\\stage", undefined, "C:\\config\\AGENTS.md")).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        instructions: ["C:\\config\\AGENTS.md"],
        skills: { paths: ["C:\\stage"] },
      }),
    });
  });
});
