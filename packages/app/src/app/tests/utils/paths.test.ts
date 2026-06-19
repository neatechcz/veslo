import assert from "node:assert/strict";
import test from "node:test";

import {
  directoryQueryPathModeFromSandbox,
  directoryQueryPathVariants,
  normalizeDirectoryPath,
  normalizeDirectoryQueryPath,
  sessionDirectoryMatchesRoot,
} from "../../utils/index.js";

const WINDOWS_WORKSPACE_PATH = "C:\\Users\\alice\\AppData\\Local\\Veslo\\test-repo\\test-repo2";
const WINDOWS_WORKSPACE_PATH_NORMALIZED = "C:/Users/alice/AppData/Local/Veslo/test-repo/test-repo2";
const WINDOWS_WORKSPACE_PATH_LOWER = "c:/users/alice/appdata/local/veslo/test-repo/test-repo2";

test("normalizeDirectoryQueryPath strips Windows extended-length prefixes", () => {
  assert.equal(
    normalizeDirectoryQueryPath(`\\\\?\\${WINDOWS_WORKSPACE_PATH}`),
    WINDOWS_WORKSPACE_PATH_NORMALIZED,
  );
  assert.equal(
    normalizeDirectoryQueryPath("//?/c:/users/alice/appdata/local/veslo/test-repo/test-repo2"),
    WINDOWS_WORKSPACE_PATH_LOWER,
  );
});

const withWindowsPlatform = async (run: () => void | Promise<void>) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      platform: "Win32",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  });
  try {
    await run();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "navigator", previous);
    } else {
      delete (globalThis as { navigator?: Navigator }).navigator;
    }
  }
};

test("normalizeDirectoryPath canonicalizes WSL mount paths on Windows", async () => {
  await withWindowsPlatform(() => {
    assert.equal(
      normalizeDirectoryPath("/mnt/c/Users/alice/AppData/Local/Veslo/test-repo/test-repo2"),
      WINDOWS_WORKSPACE_PATH_LOWER,
    );
  });
});

test("sessionDirectoryMatchesRoot treats WSL mount and workspace aliases as the active Windows root", async () => {
  await withWindowsPlatform(() => {
    assert.equal(
      sessionDirectoryMatchesRoot("/mnt/c/Users/alice/AppData/Local/Veslo/test-repo/test-repo2", WINDOWS_WORKSPACE_PATH),
      true,
    );
    assert.equal(sessionDirectoryMatchesRoot("/workspace", WINDOWS_WORKSPACE_PATH), true);
    assert.equal(sessionDirectoryMatchesRoot("/workspace/src", WINDOWS_WORKSPACE_PATH), false);
    assert.equal(sessionDirectoryMatchesRoot("/mnt/d/Users/alice/AppData/Local/Veslo/test-repo/test-repo2", WINDOWS_WORKSPACE_PATH), false);
  });
});

test("directoryQueryPathVariants includes WSL and sandbox aliases for Windows engine lookups", async () => {
  await withWindowsPlatform(() => {
    assert.deepEqual(
      directoryQueryPathVariants(WINDOWS_WORKSPACE_PATH),
      [
        WINDOWS_WORKSPACE_PATH_NORMALIZED,
        "/mnt/c/Users/alice/AppData/Local/Veslo/test-repo/test-repo2",
        "/workspace",
      ],
    );
    assert.deepEqual(
      directoryQueryPathVariants("/mnt/c/Users/alice/AppData/Local/Veslo/test-repo/test-repo2"),
      [
        "/mnt/c/Users/alice/AppData/Local/Veslo/test-repo/test-repo2",
        WINDOWS_WORKSPACE_PATH_NORMALIZED,
        "/workspace",
      ],
    );
  });
});

test("directoryQueryPathVariants prefers sandbox aliases when the WSL sandbox is active", async () => {
  await withWindowsPlatform(() => {
    assert.deepEqual(
      directoryQueryPathVariants(WINDOWS_WORKSPACE_PATH, { mode: "sandbox" }),
      [
        "/workspace",
        "/mnt/c/Users/alice/AppData/Local/Veslo/test-repo/test-repo2",
        WINDOWS_WORKSPACE_PATH_NORMALIZED,
      ],
    );
    assert.deepEqual(
      directoryQueryPathVariants("/mnt/c/Users/alice/AppData/Local/Veslo/test-repo/test-repo2", { mode: "sandbox" }),
      [
        "/workspace",
        "/mnt/c/Users/alice/AppData/Local/Veslo/test-repo/test-repo2",
        WINDOWS_WORKSPACE_PATH_NORMALIZED,
      ],
    );
  });
});

test("directoryQueryPathVariants prefers host paths when sandbox is disabled", async () => {
  await withWindowsPlatform(() => {
    assert.deepEqual(
      directoryQueryPathVariants(WINDOWS_WORKSPACE_PATH, { mode: "non-sandbox" }),
      [
        WINDOWS_WORKSPACE_PATH_NORMALIZED,
        "/mnt/c/Users/alice/AppData/Local/Veslo/test-repo/test-repo2",
        "/workspace",
      ],
    );
    assert.deepEqual(
      directoryQueryPathVariants("/mnt/c/Users/alice/AppData/Local/Veslo/test-repo/test-repo2", { mode: "non-sandbox" }),
      [
        WINDOWS_WORKSPACE_PATH_NORMALIZED,
        "/mnt/c/Users/alice/AppData/Local/Veslo/test-repo/test-repo2",
        "/workspace",
      ],
    );
  });
});

test("directoryQueryPathModeFromSandbox resolves WSL sandbox capability to path mode", () => {
  assert.equal(
    directoryQueryPathModeFromSandbox({ enabled: true, backend: "windows-wsl2" }),
    "sandbox",
  );
  assert.equal(
    directoryQueryPathModeFromSandbox({ enabled: false, backend: "none" }),
    "non-sandbox",
  );
  assert.equal(
    directoryQueryPathModeFromSandbox({ enabled: true, backend: "mac-sandbox-exec" }),
    "auto",
  );
});
