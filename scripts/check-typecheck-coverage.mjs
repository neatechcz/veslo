import { exec } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import process from "node:process";

const execAsync = promisify(exec);
const repoRoot = process.cwd();
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function workspaceInventory() {
  const { stdout } = await execAsync(
    `${pnpmCommand} -r --depth -1 list --json`,
    { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  const workspaces = JSON.parse(stdout);
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error("pnpm workspace inventory is empty");
  }
  return workspaces;
}

function scriptRunsBuild(script) {
  return /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build\b|\b(?:vite|next|tsc)\s+build\b/.test(script);
}

async function isNonWritingTypecheck(script, workspacePath) {
  if (scriptRunsBuild(script)) return false;
  if (/--noEmit\b/.test(script)) return true;

  const configMatch = script.match(/(?:^|\s)(?:-p|--project)\s+([^\s]+)/);
  if (!configMatch) return false;

  const configPath = resolve(workspacePath, configMatch[1].replaceAll(/["']/g, ""));
  if (!(await pathExists(configPath))) return false;
  const configContents = await readFile(configPath, "utf8");
  return /["']noEmit["']\s*:\s*true\b/.test(configContents);
}

const failures = [];
let workspaces;
try {
  workspaces = await workspaceInventory();
} catch (error) {
  console.error(`Typecheck coverage guard failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const tsconfigWorkspaces = [];
for (const workspace of workspaces) {
  const manifestPath = resolve(workspace.path, "package.json");
  const tsconfigPath = resolve(workspace.path, "tsconfig.json");
  if (!(await pathExists(tsconfigPath))) continue;

  tsconfigWorkspaces.push(workspace.name);
  const manifest = await readJson(manifestPath);
  const typecheck = manifest.scripts?.typecheck;
  if (typeof typecheck !== "string" || !typecheck.trim()) {
    failures.push(`${workspace.name}: tsconfig.json exists but scripts.typecheck is missing`);
    continue;
  }
  if (!(await isNonWritingTypecheck(typecheck, workspace.path))) {
    failures.push(`${workspace.name}: typecheck must be non-writing and must not run a build`);
  }
}

if (tsconfigWorkspaces.length === 0) {
  failures.push("workspace inventory contains no package with tsconfig.json");
}

const documentRuntime = workspaces.find((workspace) => workspace.name === "veslo-document-runtime");
if (!documentRuntime) {
  failures.push("veslo-document-runtime is missing from the workspace inventory");
} else {
  const manifest = await readJson(resolve(documentRuntime.path, "package.json"));
  if (manifest.scripts?.typecheck !== "node scripts/syntax-check.mjs") {
    failures.push("veslo-document-runtime: typecheck must preserve node scripts/syntax-check.mjs");
  }
}

if (failures.length > 0) {
  console.error("Typecheck coverage guard found violations:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Typecheck coverage guard passed. Verified ${tsconfigWorkspaces.length} workspace tsconfig entries.`);
