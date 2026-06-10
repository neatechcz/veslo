import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const capabilityPath = new URL(
  "../../../../desktop/src-tauri/capabilities/default.json",
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
  assert.equal(
    capability.permissions?.filter((permission) => permission === "core:window:allow-start-dragging")
      .length,
    1,
    "start dragging permission should appear exactly once",
  );
  assert.equal(
    capability.permissions?.filter((permission) => permission === "core:window:allow-set-title")
      .length,
    1,
    "set title permission should appear exactly once so session can clear native title text",
  );
  assert.equal(
    capability.permissions?.filter((permission) => permission === "core:window:allow-minimize")
      .length,
    1,
    "minimize permission should appear exactly once for Windows app-owned titlebar controls",
  );
  assert.equal(
    capability.permissions?.filter((permission) => permission === "core:window:allow-toggle-maximize")
      .length,
    1,
    "toggle maximize permission should appear exactly once for Windows app-owned titlebar controls",
  );
  assert.equal(
    capability.permissions?.filter((permission) => permission === "core:window:allow-close")
      .length,
    1,
    "close permission should appear exactly once for Windows app-owned titlebar controls",
  );
});
