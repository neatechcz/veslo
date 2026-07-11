import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveChromeDevtoolsMcpShimInvocation } from "./chrome-devtools-mcp-shim-invocation.mjs";

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
  assert.match(source, /process\.versions\.bun/);
  assert.match(source, /VESLO_CHROME_DEVTOOLS_MCP_NODE_PATH/);
  assert.match(source, /veslo-node\.exe/);
  assert.match(source, /stdio:\s*"inherit"/);
});

test("Chrome DevTools MCP shim honors a forwarded vendored watchdog entrypoint", () => {
  const execPath = "C:\\repo\\packages\\desktop\\src-tauri\\target\\debug\\chrome-devtools-mcp.exe";
  const watchdogPath = "C:\\repo\\packages\\desktop\\src-tauri\\target\\debug\\chrome-devtools-mcp-package\\build\\src\\telemetry\\watchdog\\main.js";
  const defaultEntrypoint = "C:\\repo\\packages\\desktop\\src-tauri\\target\\debug\\chrome-devtools-mcp-package\\build\\src\\index.js";
  const seenPaths = new Set([watchdogPath.toLowerCase(), defaultEntrypoint.toLowerCase()]);

  const invocation = resolveChromeDevtoolsMcpShimInvocation({
    argv: [execPath, watchdogPath, "--parent-pid=123", "--app-version=0.17.0"],
    execPath,
    env: {},
    existsSync: (value) => seenPaths.has(String(value).toLowerCase()),
  });

  assert.equal(invocation.entrypoint, watchdogPath);
  assert.equal(invocation.entrypointArgIndex, 1);
  assert.deepEqual(invocation.argvForImportedEntrypoint, [
    execPath,
    watchdogPath,
    "--parent-pid=123",
    "--app-version=0.17.0",
  ]);
  assert.equal(invocation.shouldInjectIsolated, false);
});

test("Chrome DevTools MCP shim defaults to the vendored MCP entrypoint and injects isolated mode", () => {
  const execPath = "C:\\repo\\packages\\desktop\\src-tauri\\target\\debug\\chrome-devtools-mcp.exe";
  const defaultEntrypoint = "C:\\repo\\packages\\desktop\\src-tauri\\target\\debug\\chrome-devtools-mcp-package\\build\\src\\index.js";

  const invocation = resolveChromeDevtoolsMcpShimInvocation({
    argv: [execPath, "chrome-devtools-mcp"],
    execPath,
    env: {},
    existsSync: (value) => String(value).toLowerCase() === defaultEntrypoint.toLowerCase(),
  });

  assert.equal(invocation.entrypoint, defaultEntrypoint);
  assert.equal(invocation.entrypointArgIndex, null);
  assert.deepEqual(invocation.argvForImportedEntrypoint, [
    execPath,
    defaultEntrypoint,
    "--isolated",
  ]);
  assert.equal(invocation.shouldInjectIsolated, true);
});

test("Chrome DevTools MCP shim skips its script path when run through node", () => {
  const execPath = "C:\\Program Files\\nodejs\\node.exe";
  const shimPath = "C:\\repo\\packages\\desktop\\scripts\\chrome-devtools-mcp-shim.ts";
  const defaultEntrypoint = "C:\\Program Files\\nodejs\\chrome-devtools-mcp-package\\build\\src\\index.js";

  const invocation = resolveChromeDevtoolsMcpShimInvocation({
    argv: [execPath, shimPath, "--browser-url=http://127.0.0.1:9222"],
    execPath,
    env: {},
    existsSync: (value) => String(value).toLowerCase() === defaultEntrypoint.toLowerCase(),
  });

  assert.deepEqual(invocation.argvForImportedEntrypoint, [
    execPath,
    defaultEntrypoint,
    "--browser-url=http://127.0.0.1:9222",
  ]);
  assert.equal(invocation.shouldInjectIsolated, false);
});

test("prepare-sidecar vendors the Chrome DevTools MCP package with the sidecar", () => {
  assert.match(prepareSidecarSource, /chrome-devtools-mcp-package/);
  assert.match(prepareSidecarSource, /require\.resolve\(["']chrome-devtools-mcp\/package\.json["']\)/);
  assert.match(prepareSidecarSource, /copyChromeDevtoolsMcpPackage/);
  assert.match(prepareSidecarSource, /bundledNodeVersion/);
  assert.match(prepareSidecarSource, /node-v\$\{bundledNodeVersion\}-win-x64\.zip/);
  assert.match(prepareSidecarSource, /ensureBundledNodeRuntime/);
});
