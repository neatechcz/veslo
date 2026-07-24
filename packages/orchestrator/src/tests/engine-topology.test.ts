import { describe, expect, test } from "bun:test";

import {
  buildSharedOpencodeEngineWarning,
  resolveEngineTopology,
  usesSharedOpenCodeEngine,
} from "../engine-topology.js";

describe("engine topology resolution", () => {
  test("uses per-workspace pooled engines by default", () => {
    expect(resolveEngineTopology({ env: {}, sandboxKind: "none" })).toEqual({
      mode: "pooled-per-workspace",
      reason: "shared engine not requested",
      sharedRequested: false,
    });
  });

  test("allows one shared engine only when sandbox is explicitly disabled", () => {
    const topology = resolveEngineTopology({
      env: {
        VESLO_DISABLE_SANDBOX: "1",
        VESLO_SHARED_OPENCODE_ENGINE: "1",
      },
      sandboxKind: "none",
    });

    expect(topology.mode).toBe("shared-unsandboxed");
    expect(topology.sharedRequested).toBe(true);
    expect(topology.reason).toContain("explicit");
  });

  test("accepts true as the shared engine env value", () => {
    const topology = resolveEngineTopology({
      env: {
        VESLO_DISABLE_SANDBOX: "true",
        VESLO_SHARED_OPENCODE_ENGINE: "true",
      },
      sandboxKind: "none",
    });

    expect(topology.mode).toBe("shared-unsandboxed");
  });

  test("requires an explicit second flag for the experimental directory-scoped shared mode", () => {
    const topology = resolveEngineTopology({
      env: {
        VESLO_DISABLE_SANDBOX: "1",
        VESLO_SHARED_OPENCODE_ENGINE: "1",
        VESLO_SHARED_OPENCODE_DIRECTORY_SCOPED: "1",
      },
      sandboxKind: "none",
    });

    expect(topology.mode).toBe("shared-directory-scoped");
    expect(usesSharedOpenCodeEngine(topology.mode)).toBe(true);
  });

  test("rejects shared engine when sandbox is not explicitly disabled", () => {
    expect(() =>
      resolveEngineTopology({
        env: { VESLO_SHARED_OPENCODE_ENGINE: "1" },
        sandboxKind: "none",
      }),
    ).toThrow(/requires VESLO_DISABLE_SANDBOX=1/i);
  });

  test("rejects shared engine when a WSL sandbox is active", () => {
    expect(() =>
      resolveEngineTopology({
        env: {
          VESLO_DISABLE_SANDBOX: "1",
          VESLO_SHARED_OPENCODE_ENGINE: "1",
        },
        sandboxKind: "windows-wsl2",
      }),
    ).toThrow(/sandbox kind 'windows-wsl2' is active/i);
  });

  test("does not auto-enable shared engine for an unsandboxed fallback", () => {
    const topology = resolveEngineTopology({
      env: {},
      sandboxKind: "none",
      sandboxFallbackReason: "sandbox unavailable",
    });

    expect(topology.mode).toBe("pooled-per-workspace");
    expect(topology.sharedRequested).toBe(false);
  });

  test("builds a visible warning for shared unsandboxed mode", () => {
    const warning = buildSharedOpencodeEngineWarning();

    expect(warning).toContain("\u001b[31;1m");
    expect(warning).toContain("UNSANDBOXED SHARED OPENCODE ENGINE");
    expect(warning).toContain("VESLO_DISABLE_SANDBOX=1");
    expect(warning).toContain("VESLO_SHARED_OPENCODE_ENGINE=1");
    expect(warning).toContain("\u001b[0m");
  });
});
