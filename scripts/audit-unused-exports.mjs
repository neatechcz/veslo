import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

const knipBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "knip.CMD" : "knip",
);

if (!existsSync(knipBin)) {
  console.error("Knip binary was not found in node_modules/.bin. Run pnpm install first.");
  process.exit(1);
}

const knipArgs = [
  ...(hasNoProgress ? [] : ["--no-progress"]),
  ...(hasExports ? [] : ["--exports"]),
  ...(hasMaxShowIssues ? [] : ["--max-show-issues", "80"]),
  ...(!strict && !hasNoExitCode ? ["--no-exit-code"] : []),
  ...forwardedArgs,
];

const result = spawnSync(knipBin, knipArgs, {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(`Failed to run Knip: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
