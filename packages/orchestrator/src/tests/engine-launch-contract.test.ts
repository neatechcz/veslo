import { describe, expect, test } from "bun:test";

import {
  buildEngineConfigEnv,
  buildEngineSkillConflictEnv,
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

  test("blocks ambient global compatibility scans without disabling project Claude skills", () => {
    expect(buildEngineSkillIsolationEnv()).toEqual({
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
    });
  });

  test("publishes the Veslo-owned effective skill view as an explicit engine config merge", () => {
    expect(buildEngineSkillViewEnv(" C:\\veslo\\workspace-config\\skill-staging ")).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: ["C:\\veslo\\workspace-config\\skill-staging"] } }),
    });
    expect(buildEngineSkillViewEnv()).toEqual({});
    expect(buildEngineSkillViewEnv("C:\\stage", JSON.stringify({ mcp: { local: true }, skills: { urls: ["https://example.test"] } }))).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        mcp: { local: true },
        skills: { urls: ["https://example.test"], paths: ["C:\\stage"] },
      }),
    });
  });

  test("isolates project scans only for fail-closed conflicts and keeps explicit config", () => {
    expect(buildEngineSkillConflictEnv({ suppressed: 1, configPath: " C:\\cfg\\opencode.jsonc " })).toEqual({
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_CONFIG: "C:\\cfg\\opencode.jsonc",
    });
    expect(buildEngineSkillConflictEnv({ suppressed: 0, configPath: "C:\\cfg\\opencode.jsonc" })).toEqual({});
  });
});
