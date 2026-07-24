import { parse, type ParseError } from "jsonc-parser";

export type DirectoryScopedConfigProfile = {
  compatible: boolean;
  reason: "no-workspace-config" | "skill-only-config" | "launch-config-present" | "invalid-config";
};

/**
 * A shared OpenCode process has one immutable launch config.  The first shard
 * accepts only an absent config or a skills-only config (which Veslo replaces
 * with the effective manifest).  Any provider, MCP, plugin, or other project
 * launch setting remains in a pooled process until profile sharding is
 * implemented deliberately.
 */
export function inspectDirectoryScopedConfigProfile(raw: string | undefined): DirectoryScopedConfigProfile {
  if (!raw?.trim()) return { compatible: true, reason: "no-workspace-config" };
  const errors: ParseError[] = [];
  const value = parse(raw, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !value || typeof value !== "object" || Array.isArray(value)) {
    return { compatible: false, reason: "invalid-config" };
  }
  const keys = Object.keys(value as Record<string, unknown>).filter((key) => key !== "$schema" && key !== "skills");
  return keys.length === 0
    ? { compatible: true, reason: raw.includes("skills") ? "skill-only-config" : "no-workspace-config" }
    : { compatible: false, reason: "launch-config-present" };
}
