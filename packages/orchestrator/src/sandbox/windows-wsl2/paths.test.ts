import { describe, expect, test } from "bun:test";

import {
  isWslMappableWindowsPath,
  normalizeWindowsPathForWsl,
  windowsPathToWslPath,
} from "./paths.js";

describe("windowsPathToWslPath", () => {
  test("maps drive-letter paths to WSL mount paths", () => {
    expect(windowsPathToWslPath("C:\\Users\\alice\\project")).toBe("/mnt/c/Users/alice/project");
  });

  test("maps extended-length drive-letter paths to WSL mount paths", () => {
    expect(windowsPathToWslPath("\\\\?\\C:\\Users\\alice\\project")).toBe("/mnt/c/Users/alice/project");
  });

  test("keeps extended-length UNC paths unmappable", () => {
    expect(normalizeWindowsPathForWsl("\\\\?\\UNC\\server\\share\\project")).toBe("\\\\server\\share\\project");
    expect(isWslMappableWindowsPath("\\\\?\\UNC\\server\\share\\project")).toBe(false);
  });
});
