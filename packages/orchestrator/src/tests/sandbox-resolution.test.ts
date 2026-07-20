import { describe, expect, test } from "bun:test";

import {
  LEGACY_WINDOWS_WSL_SANDBOX_ENV,
  resolveSandbox,
} from "../sandbox/index.js";

describe("sandbox backend policy", () => {
  test("does not select the retired Windows WSL2 backend by default", () => {
    expect(() => resolveSandbox({ platform: "win32", env: {} })).toThrow(
      new RegExp(LEGACY_WINDOWS_WSL_SANDBOX_ENV),
    );
  });

  test("allows the retired Windows WSL2 backend only for explicit developer diagnostics", () => {
    expect(resolveSandbox({
      platform: "win32",
      env: { [LEGACY_WINDOWS_WSL_SANDBOX_ENV]: "1" },
    }).name).toBe("windows-wsl2");
  });
});
