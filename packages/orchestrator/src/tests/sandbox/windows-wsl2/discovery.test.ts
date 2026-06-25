import { describe, expect, test } from "bun:test";

import {
  MANAGED_WSL_DISTRO,
  selectWslDistroForRuntime,
  type WslDistro,
} from "../../../sandbox/windows-wsl2/discovery.js";

const distro = (name: string, version = 2, extra: Partial<WslDistro> = {}): WslDistro => ({
  name,
  state: extra.state ?? "Stopped",
  version,
  default: extra.default ?? false,
});

describe("windows-wsl2 distro selection", () => {
  test("uses explicit VESLO_WSL_DISTRO override", () => {
    expect(
      selectWslDistroForRuntime([distro(MANAGED_WSL_DISTRO)], {
        VESLO_WSL_DISTRO: "CustomSandbox",
      }),
    ).toBe("CustomSandbox");
  });

  test("prefers the managed VesloSandbox distro", () => {
    expect(
      selectWslDistroForRuntime([
        distro("Ubuntu", 2, { default: true }),
        distro(MANAGED_WSL_DISTRO),
      ], {}),
    ).toBe(MANAGED_WSL_DISTRO);
  });

  test("does not silently fall back to a personal WSL2 distro", () => {
    expect(() => selectWslDistroForRuntime([distro("Ubuntu", 2, { default: true })], {})).toThrow(
      /Managed WSL distro 'VesloSandbox' is not installed/,
    );
  });

  test("allows personal distro fallback only for diagnostics", () => {
    expect(
      selectWslDistroForRuntime([distro("Ubuntu", 2, { default: true })], {
        VESLO_WSL_ALLOW_PERSONAL_DISTRO_FALLBACK: "1",
      }),
    ).toBe("Ubuntu");
  });
});
