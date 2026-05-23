import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("desktop local Veslo server defaults managed AI to the owned gateway", () => {
  const spawnSource = readFileSync(new URL("./src-tauri/src/veslo_server/spawn.rs", import.meta.url), "utf8");

  assert.match(spawnSource, /const DEFAULT_MANAGED_AI_BASE_URL: &str = "https:\/\/ai\.veslo\.work";/);
});
