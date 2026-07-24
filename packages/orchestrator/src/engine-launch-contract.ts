/**
 * Environment contract for an OpenCode process owned by Veslo.
 *
 * Config discovery is workspace-scoped. Data/auth discovery is deliberately
 * not changed here; the caller continues to inherit its existing
 * XDG_DATA_HOME/OS data location.
 */
export function buildEngineConfigEnv(configDir?: string): Record<string, string> {
  const normalized = configDir?.trim();
  if (!normalized) return {};
  return {
    OPENCODE_CONFIG_DIR: normalized,
    XDG_CONFIG_HOME: normalized,
  };
}

export type EngineSkillIsolationProfile = "normal" | "hardened";

/**
 * Both profiles disable native project discovery so raw project skills cannot
 * bypass Veslo policy. `normal` pooled engines receive a per-workspace config
 * projection with allowed agents, commands, modes and plugins. `hardened` is
 * only for the experimental shared directory topology and receives no such
 * project runtime projection.
 */
export function buildEngineSkillIsolationEnv(
  configPath: string,
  _profile: EngineSkillIsolationProfile = "normal",
): Record<string, string> {
  const normalizedConfigPath = configPath.trim();
  if (!normalizedConfigPath) {
    throw new Error("Veslo requires a sanitized OpenCode config snapshot for every engine launch");
  }
  return {
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG: normalizedConfigPath,
  };
}

export function buildEngineSkillViewEnv(
  stagingRoot?: string,
  existingConfigContent?: string,
  projectInstructionPath?: string,
): Record<string, string> {
  const normalized = stagingRoot?.trim();
  if (!normalized) return {};
  let base: Record<string, unknown> = {};
  if (existingConfigContent?.trim()) {
    try {
      const parsed = JSON.parse(existingConfigContent);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch {
      // The skill policy must still close even if an inherited optional
      // override is malformed. Preserve none of that override rather than
      // dropping the effective view.
      base = {};
    }
  }
  const { skills: _ignoredSkills, ...configWithoutSkills } = base;
  const normalizedInstructionPath = projectInstructionPath?.trim();
  return {
    // Do not preserve paths or URLs supplied by a parent config. The only
    // skill root is the Veslo-owned effective view. Pooled project
    // instructions are explicitly copied into the config projection.
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...configWithoutSkills,
      ...(normalizedInstructionPath ? { instructions: [normalizedInstructionPath] } : {}),
      skills: { paths: [normalized] },
    }),
  };
}
