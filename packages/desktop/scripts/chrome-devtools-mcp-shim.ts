#!/usr/bin/env node
import { spawn } from "node:child_process";

const packageSpec =
  process.env.VESLO_CHROME_DEVTOOLS_MCP_SPEC?.trim() ||
  process.env.CHROME_DEVTOOLS_MCP_SPEC?.trim() ||
  "chrome-devtools-mcp@0.17.0";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const forwardedArgs = process.argv.slice(2);

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

const effectiveArgs = shouldInjectIsolated ? [...forwardedArgs, "--isolated"] : forwardedArgs;

const args = ["exec", "--yes", packageSpec, "--", ...effectiveArgs];

const child = spawn(npmCommand, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    npm_config_yes: "true",
  },
});

child.on("error", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ENOENT")) {
    console.error(
      "Control Chrome requires npm (Node.js). Install Node.js or configure mcp.chrome-devtools.command to a local chrome-devtools-mcp binary."
    );
  } else {
    console.error(`Failed to start chrome-devtools-mcp via npm exec: ${message}`);
  }
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
