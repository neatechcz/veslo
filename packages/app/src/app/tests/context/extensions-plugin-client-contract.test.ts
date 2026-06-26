import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extensionsSource = readFileSync(new URL("../../context/extensions.ts", import.meta.url), "utf8");

test("extensions plugin requests use the plugins domain facade", () => {
  assert.match(extensionsSource, /vesloClient\.plugins\./);
  assert.doesNotMatch(extensionsSource, /vesloClient\.(?:listPlugins|addPlugin|removePlugin)\(/);
});
