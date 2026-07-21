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

/**
 * Keep project `.claude/skills` compatibility while cutting ambient global
 * Claude/Agents skill and prompt discovery from the upstream process.
 */
export function buildEngineSkillIsolationEnv(): Record<string, string> {
  return {
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
  };
}

export function buildEngineSkillViewEnv(stagingRoot?: string, existingConfigContent?: string): Record<string, string> {
  const normalized = stagingRoot?.trim();
  if (!normalized) return {};
  let base: Record<string, unknown> = {};
  if (existingConfigContent?.trim()) {
    try {
      const parsed = JSON.parse(existingConfigContent);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch {
      // Keep an invalid upstream override untouched rather than making launch
      // fail solely because the optional skill overlay was requested.
      return {};
    }
  }
  const skills = base.skills && typeof base.skills === "object" && !Array.isArray(base.skills)
    ? base.skills as Record<string, unknown>
    : {};
  return {
    // OpenCode's skills.paths is additive; this explicit path makes the
    // Veslo-owned effective view visible to the engine without changing cwd.
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...base, skills: { ...skills, paths: [normalized] } }),
  };
}

export function buildEngineSkillConflictEnv(input: {
  suppressed: number;
  configPath?: string;
}): Record<string, string> {
  if (input.suppressed <= 0 || !input.configPath?.trim()) return {};
  return {
    // OpenCode has no skill-only project-scan switch. In a fail-closed
    // conflict, disable the project scope and reload the Veslo-sanitized copy
    // explicitly so MCP/provider/config behavior remains available.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG: input.configPath.trim(),
  };
}
