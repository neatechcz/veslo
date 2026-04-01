import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const tauriConfigPath = new URL(
  "../../../desktop/src-tauri/tauri.conf.json",
  import.meta.url,
);

test("macOS bundle declares folder usage descriptions", () => {
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8")) as {
    bundle?: {
      macOS?: {
        infoPlist?: string | null;
      };
    };
  };

  const infoPlistPath = tauriConfig.bundle?.macOS?.infoPlist;
  assert.equal(typeof infoPlistPath, "string", "bundle.macOS.infoPlist should be a file path string");
  assert.ok(infoPlistPath.trim().length > 0, "bundle.macOS.infoPlist should not be empty");

  const tauriConfigDir = dirname(fileURLToPath(tauriConfigPath));
  const infoPlistRaw = readFileSync(resolve(tauriConfigDir, infoPlistPath), "utf8");

  for (const key of ["NSDesktopFolderUsageDescription", "NSDocumentsFolderUsageDescription", "NSDownloadsFolderUsageDescription"]) {
    assert.match(
      infoPlistRaw,
      new RegExp(`<key>${key}</key>[\\s\\S]*?<string>[^<]+</string>`),
      `${key} should be present with a non-empty string value`,
    );
  }
});
