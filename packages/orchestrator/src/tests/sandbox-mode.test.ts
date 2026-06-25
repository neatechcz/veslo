import { describe, expect, test } from "bun:test";

import {
  buildUnsandboxedSandboxWarning,
  resolveEngineSandbox,
} from "../sandbox-mode.js";
import type { WorkerSandbox } from "../sandbox/types.js";

const fakeSandbox: WorkerSandbox = {
  name: "windows-wsl2",
  isAvailable: () => true,
  buildLaunch: async () => {
    throw new Error("not used");
  },
};

describe("sandbox mode resolution", () => {
  test("VESLO_DISABLE_SANDBOX disables sandbox before the WSL backend is resolved", () => {
    let resolverCalled = false;
    const warningMessages: string[] = [];
    const loggerWarnings: Array<{ message: string; attrs: unknown }> = [];

    const sandbox = resolveEngineSandbox({
      env: { VESLO_DISABLE_SANDBOX: "1" },
      workspace: "C:\\Work\\project",
      sandbox: fakeSandbox,
      resolveSandbox: () => {
        resolverCalled = true;
        return fakeSandbox;
      },
      writeWarning: (message) => warningMessages.push(message),
      logger: {
        warn: (message, attrs) => loggerWarnings.push({ message, attrs }),
      },
    });

    expect(sandbox).toBeNull();
    expect(resolverCalled).toBe(false);
    expect(warningMessages).toHaveLength(1);
    expect(warningMessages[0]).toContain("\u001b[31");
    expect(warningMessages[0]).toContain("UNSANDBOXED OPENCODE ENGINE");
    expect(warningMessages[0]).toContain("VESLO_DISABLE_SANDBOX=1");
    expect(warningMessages[0]).toContain("C:\\Work\\project");
    expect(loggerWarnings[0]?.message).toContain("engine spawn unsandboxed");
    expect(loggerWarnings[0]?.attrs).toEqual({
      workspace: "C:\\Work\\project",
      reason: "VESLO_DISABLE_SANDBOX=1",
    });
  });

  test("sandbox resolver failures also emit the visible unsandboxed warning", () => {
    const warningMessages: string[] = [];
    const loggerWarnings: Array<{ message: string; attrs: unknown }> = [];

    const sandbox = resolveEngineSandbox({
      env: {},
      workspace: "/Users/demo/project",
      resolveSandbox: () => {
        throw new Error("No sandbox backend for platform=linux");
      },
      writeWarning: (message) => warningMessages.push(message),
      logger: {
        warn: (message, attrs) => loggerWarnings.push({ message, attrs }),
      },
    });

    expect(sandbox).toBeNull();
    expect(warningMessages).toHaveLength(1);
    expect(warningMessages[0]).toContain("UNSANDBOXED OPENCODE ENGINE");
    expect(warningMessages[0]).toContain("sandbox unavailable");
    expect(warningMessages[0]).toContain("No sandbox backend for platform=linux");
    expect(loggerWarnings[0]?.message).toContain("sandbox unavailable");
    expect(loggerWarnings[0]?.attrs).toEqual({
      workspace: "/Users/demo/project",
      reason: "sandbox unavailable",
      error: "No sandbox backend for platform=linux",
    });
  });

  test("unsandboxed warning is a large red terminal banner", () => {
    const warning = buildUnsandboxedSandboxWarning({
      workspace: "/repo/app",
      reason: "VESLO_DISABLE_SANDBOX=1",
    });

    expect(warning).toContain("\u001b[31;1m");
    expect(warning).toContain("############################################################");
    expect(warning).toContain("UNSANDBOXED OPENCODE ENGINE");
    expect(warning).toContain("/repo/app");
    expect(warning).toContain("\u001b[0m");
  });
});
