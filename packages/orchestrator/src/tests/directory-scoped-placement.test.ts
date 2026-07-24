import { describe, expect, test } from "bun:test";

import { inspectDirectoryScopedConfigProfile } from "../directory-scoped-placement.js";

describe("directory-scoped shared placement", () => {
  test("accepts only absent, schema-only, or skills-only workspace config", () => {
    expect(inspectDirectoryScopedConfigProfile(undefined)).toEqual({ compatible: true, reason: "no-workspace-config" });
    expect(inspectDirectoryScopedConfigProfile('{ "$schema": "https://opencode.ai/config.json", "skills": { "paths": ["x"] } }'))
      .toEqual({ compatible: true, reason: "skill-only-config" });
  });

  test("keeps process-level launch configuration in the pooled topology", () => {
    expect(inspectDirectoryScopedConfigProfile('{ "mcp": { "browser": { "type": "local" } } }'))
      .toEqual({ compatible: false, reason: "launch-config-present" });
    expect(inspectDirectoryScopedConfigProfile('{ invalid')).toEqual({ compatible: false, reason: "invalid-config" });
  });
});
