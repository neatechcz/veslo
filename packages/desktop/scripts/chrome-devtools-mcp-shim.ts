#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveChromeDevtoolsMcpShimInvocation } from "./chrome-devtools-mcp-shim-invocation.mjs";

const require = createRequire(import.meta.url);
const vendoredPackageDirName = "chrome-devtools-mcp-package";

const invocation = resolveChromeDevtoolsMcpShimInvocation({
  argv: process.argv,
  execPath: process.execPath,
  env: process.env,
  existsSync,
});

const resolveChromeDevtoolsMcpEntrypoint = () => {
  if (existsSync(invocation.entrypoint)) {
    return invocation.entrypoint;
  }

  try {
    const packageJsonPath = require.resolve("chrome-devtools-mcp/package.json");
    const localEntrypoint = join(dirname(packageJsonPath), "build", "src", "index.js");
    if (existsSync(localEntrypoint)) {
      return localEntrypoint;
    }
  } catch {
    // Fall through to the explicit runtime error below.
  }

  const sidecarEntrypoint = join(
    dirname(process.execPath),
    vendoredPackageDirName,
    "build",
    "src",
    "index.js",
  );
  console.error(`Chrome DevTools MCP runtime package not found at ${sidecarEntrypoint}.`);
  process.exit(1);
};

const entrypoint = resolveChromeDevtoolsMcpEntrypoint();
const bundledBunSidecar =
  !!process.versions.bun &&
  ["chrome-devtools-mcp", "chrome-devtools-mcp.exe"].includes(basename(process.execPath).toLowerCase());

if (bundledBunSidecar) {
  const bundledNodeExecutable = join(
    dirname(process.execPath),
    process.platform === "win32" ? "veslo-node.exe" : "veslo-node",
  );
  const nodeExecutable =
    process.env.VESLO_CHROME_DEVTOOLS_MCP_NODE_PATH?.trim() ||
    (existsSync(bundledNodeExecutable) ? bundledNodeExecutable : "node");
  const child = spawn(nodeExecutable, [entrypoint, ...invocation.argvForImportedEntrypoint.slice(2)], {
    stdio: "inherit",
    windowsHide: true,
  });
  const result = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("exit", (code) => resolve({ code }));
  });
  if (result.error) {
    console.error(`Chrome DevTools MCP requires Node.js when launched from the bundled sidecar: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.code ?? 1);
}

process.argv.splice(0, process.argv.length, ...invocation.argvForImportedEntrypoint);
await import(pathToFileURL(entrypoint).href);
