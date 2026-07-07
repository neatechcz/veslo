import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./chrome-devtools-mcp-shim.ts", import.meta.url)), "utf8");
const prepareSidecarSource = readFileSync(fileURLToPath(new URL("./prepare-sidecar.mjs", import.meta.url)), "utf8");
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

test("desktop package pins the Chrome DevTools MCP runtime", () => {
  assert.equal(packageJson.dependencies?.["chrome-devtools-mcp"], "0.17.0");
});

test("Chrome DevTools MCP shim uses the vendored package instead of npm exec", () => {
  assert.doesNotMatch(source, /\bnpm(?:\.cmd)?\b/);
  assert.doesNotMatch(source, /\bnpm_config_/);
  assert.doesNotMatch(source, /"exec"/);
  assert.doesNotMatch(source, /import\(["']chrome-devtools-mcp\/build\/src\/index\.js["']\)/);
  assert.match(source, /pathToFileURL/);
  assert.match(source, /process\.execPath/);
  assert.match(source, /chrome-devtools-mcp-package/);
});

test("prepare-sidecar vendors the Chrome DevTools MCP package with the sidecar", () => {
  assert.match(prepareSidecarSource, /chrome-devtools-mcp-package/);
  assert.match(prepareSidecarSource, /require\.resolve\(["']chrome-devtools-mcp\/package\.json["']\)/);
  assert.match(prepareSidecarSource, /copyChromeDevtoolsMcpPackage/);
});
