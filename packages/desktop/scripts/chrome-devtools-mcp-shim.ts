#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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

process.argv.splice(0, process.argv.length, ...invocation.argvForImportedEntrypoint);
await import(pathToFileURL(resolveChromeDevtoolsMcpEntrypoint()).href);
