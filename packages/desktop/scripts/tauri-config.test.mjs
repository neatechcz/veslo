import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const tauriConfigPath = resolve(__dirname, "../src-tauri/tauri.conf.json");

test("desktop window keeps Tauri native drag-drop disabled for HTML5 file drop", () => {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const windows = Array.isArray(config?.app?.windows) ? config.app.windows : [];
  assert.ok(windows.length > 0, "Expected at least one desktop window config");

  for (const windowConfig of windows) {
    assert.equal(
      windowConfig?.dragDropEnabled,
      false,
      "Window must set dragDropEnabled=false so Finder file drops reach frontend onDrop handlers",
    );
  }
});
