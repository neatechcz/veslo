import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("desktop local Veslo server derives managed AI from the deployment domain", () => {
  const spawnSource = readFileSync(new URL("./src-tauri/src/veslo_server/spawn.rs", import.meta.url), "utf8");

  assert.match(spawnSource, /const DEFAULT_VESLO_DEPLOYMENT_DOMAIN: &str = "veslo\.work";/);
  assert.match(spawnSource, /VESLO_DEPLOYMENT_DOMAIN/);
  assert.match(spawnSource, /deployment_service_url\("ai"/);
});
