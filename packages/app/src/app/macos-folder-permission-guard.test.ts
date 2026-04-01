import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tauriConfigPath = new URL(
  "../../../desktop/src-tauri/tauri.conf.json",
  import.meta.url,
);

test("macOS bundle declares folder usage descriptions", () => {
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8")) as {
    bundle?: {
      macOS?: {
        infoPlist?: Record<string, unknown>;
      };
    };
  };

  const infoPlist = tauriConfig.bundle?.macOS?.infoPlist;
  assert.ok(infoPlist && typeof infoPlist === "object", "bundle.macOS.infoPlist should be defined");
  const infoPlistRecord = infoPlist as Record<string, unknown>;

  for (const key of [
    "NSDesktopFolderUsageDescription",
    "NSDocumentsFolderUsageDescription",
    "NSDownloadsFolderUsageDescription",
  ]) {
    const value = infoPlistRecord[key];
    assert.equal(typeof value, "string", `${key} should be a string`);
    assert.ok(value.trim().length > 0, `${key} should not be empty`);
  }
});
