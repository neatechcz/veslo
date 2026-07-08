import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import process from "node:process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const userArgs = process.argv.slice(2);
const strict = userArgs.includes("--strict");
const help = userArgs.includes("--help") || userArgs.includes("-h");
const forwardedArgs = userArgs.filter((arg) => arg !== "--strict");

if (help) {
  console.log(`Usage:
  pnpm audit:unused-exports [--strict] [knip args...]

Examples:
  pnpm audit:unused-exports
  pnpm audit:unused-exports -- --workspace packages/app
  pnpm audit:unused-exports:strict

Default behavior:
  - runs Knip with --exports only
  - limits the printed report with --max-show-issues 80 unless overridden
  - exits 0 unless --strict is used
`);
  process.exit(0);
}

const hasMaxShowIssues = forwardedArgs.some(
  (arg) => arg === "--max-show-issues" || arg.startsWith("--max-show-issues="),
);
const hasNoProgress = forwardedArgs.includes("--no-progress");
const hasExports = forwardedArgs.includes("--exports");
const hasNoExitCode = forwardedArgs.includes("--no-exit-code");

const knipPackageEntry = require.resolve("knip");
const knipCli = resolve(dirname(knipPackageEntry), "..", "bin", "knip.js");

if (!existsSync(knipCli)) {
  console.error("Knip CLI was not found. Run pnpm install first.");
  process.exit(1);
}

const knipArgs = [
  ...(hasNoProgress ? [] : ["--no-progress"]),
  ...(hasExports ? [] : ["--exports"]),
  ...(hasMaxShowIssues ? [] : ["--max-show-issues", "80"]),
  ...(!strict && !hasNoExitCode ? ["--no-exit-code"] : []),
  ...forwardedArgs,
];

const result = spawnSync(process.execPath, [knipCli, ...knipArgs], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(`Failed to run Knip: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
