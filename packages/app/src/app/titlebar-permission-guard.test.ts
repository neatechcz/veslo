import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const capabilityPath = new URL(
  "../../../desktop/src-tauri/capabilities/default.json",
  import.meta.url,
);

test("default Tauri capability includes title bar style permission", () => {
  const capability = JSON.parse(readFileSync(capabilityPath, "utf8")) as {
    permissions?: unknown[];
  };

  assert.ok(Array.isArray(capability.permissions), "capability permissions should be an array");
  assert.equal(
    capability.permissions?.filter((permission) => permission === "core:window:allow-set-title-bar-style")
      .length,
    1,
    "title bar style permission should appear exactly once",
  );
});
