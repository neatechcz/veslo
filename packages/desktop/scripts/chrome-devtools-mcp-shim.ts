#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const forwardedArgs = process.argv.slice(2);
const require = createRequire(import.meta.url);
const vendoredPackageDirName = "chrome-devtools-mcp-package";

const hasArg = (name: string) =>
  forwardedArgs.some((value) => value === name || value.startsWith(`${name}=`));

const hasExplicitBrowserProfileConfig =
  hasArg("--isolated") ||
  hasArg("--user-data-dir") ||
  hasArg("--userDataDir") ||
  hasArg("--browser-url") ||
  hasArg("--browserUrl") ||
  hasArg("--ws-endpoint") ||
  hasArg("--wsEndpoint") ||
  hasArg("--auto-connect") ||
  hasArg("--autoConnect");

const shouldInjectIsolated =
  process.env.VESLO_CHROME_DEVTOOLS_MCP_DEFAULT_ISOLATED !== "0" && !hasExplicitBrowserProfileConfig;

if (shouldInjectIsolated) {
  process.argv.push("--isolated");
}

const resolveChromeDevtoolsMcpEntrypoint = () => {
  const sidecarEntrypoint = join(
    dirname(process.execPath),
    vendoredPackageDirName,
    "build",
    "src",
    "index.js",
  );
  if (existsSync(sidecarEntrypoint)) {
    return sidecarEntrypoint;
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

  console.error(`Chrome DevTools MCP runtime package not found at ${sidecarEntrypoint}.`);
  process.exit(1);
};

await import(pathToFileURL(resolveChromeDevtoolsMcpEntrypoint()).href);
