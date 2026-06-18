import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveDefaultVesloDataDir,
  resolveLegacyVesloDataDir,
  resolveVesloDataDir,
  resolveVesloDataDirWithLegacyMigration,
} from "../audit.js";

describe("resolveDefaultVesloDataDir", () => {
  test("keeps VESLO_DATA_DIR as the explicit storage override", () => {
    const previous = process.env.VESLO_DATA_DIR;
    process.env.VESLO_DATA_DIR = "~/custom-veslo-data";
    try {
      expect(resolveVesloDataDir().replace(/\\/g, "/")).toMatch(/\/custom-veslo-data$/);
    } finally {
      if (previous === undefined) {
        delete process.env.VESLO_DATA_DIR;
      } else {
        process.env.VESLO_DATA_DIR = previous;
      }
    }
  });

  test("uses LocalAppData for the Windows server data default", () => {
    expect(resolveDefaultVesloDataDir({
      platform: "win32",
      home: "C:\\Users\\alice",
      env: {
        LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
        APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
      },
    })).toBe("C:\\Users\\alice\\AppData\\Local\\com.neatech.veslo\\veslo-server");
  });

  test("falls back to AppData on Windows when LocalAppData is unavailable", () => {
    expect(resolveDefaultVesloDataDir({
      platform: "win32",
      home: "C:\\Users\\alice",
      env: {
        APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
      },
    })).toBe("C:\\Users\\alice\\AppData\\Roaming\\com.neatech.veslo\\veslo-server");
  });

  test("resolves the historical Windows home dot-dir separately from the AppData default", () => {
    expect(resolveLegacyVesloDataDir({
      platform: "win32",
      home: "C:\\Users\\alice",
    })).toBe("C:\\Users\\alice\\.veslo\\veslo-server");
  });

  test("copies existing legacy Windows server data into the AppData default", async () => {
    const root = await mkdtemp(join(tmpdir(), "veslo-server-data-migration-"));
    const legacy = join(root, "legacy", ".veslo", "veslo-server");
    const current = join(root, "LocalAppData", "com.neatech.veslo", "veslo-server");
    const relativeRecord = join("conversations", "bindings.sqlite");
    const legacyRecord = join(legacy, relativeRecord);
    try {
      await mkdir(dirname(legacyRecord), { recursive: true });
      await writeFile(legacyRecord, "legacy bindings", "utf8");

      const resolved = resolveVesloDataDirWithLegacyMigration(current, legacy);

      expect(resolved).toBe(current);
      expect(await readFile(join(current, relativeRecord), "utf8")).toBe("legacy bindings");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the historical home dot-dir default outside Windows", () => {
    expect(resolveDefaultVesloDataDir({
      platform: "linux",
      home: "/home/alice",
      env: {},
    })).toBe("/home/alice/.veslo/veslo-server");
  });
});
