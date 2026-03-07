#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const REPO_ROOT = path.resolve(ROOT, "../..");
const args = process.argv.slice(2);

const usage = () => {
  console.log(`Usage:
  node scripts/bump-version.mjs calver
  node scripts/bump-version.mjs --set YYYY.M.P
  node scripts/bump-version.mjs --date YYYY-MM calver
  node scripts/bump-version.mjs --dry-run [calver|--set YYYY.M.P]`);
};

const isDryRun = args.includes("--dry-run");
// pnpm forwards args to scripts with an explicit "--" separator; strip it so
// "pnpm bump:set -- 2026.3.0" works as expected.
let dateOverride = null;
const filtered = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--dry-run" || arg === "--") continue;
  if (arg === "--date") {
    const value = args[index + 1];
    if (!value) {
      console.error("--date requires a value like 2026-03");
      process.exit(1);
    }
    dateOverride = value;
    index += 1;
    continue;
  }
  filtered.push(arg);
}

if (!filtered.length) {
  usage();
  process.exit(1);
}

let mode = filtered[0];
let explicit = null;

if (mode === "--set") {
  explicit = filtered[1] ?? null;
  if (!explicit) {
    console.error("--set requires a version like 2026.3.0");
    process.exit(1);
  }
}

const calverPattern = /^\d{4}\.(?:[1-9]|1[0-2])\.\d+$/;
const calverInputPattern = /^(\d{4})-(0?[1-9]|1[0-2])$/;
const calverModes = new Set(["calver", "patch", "minor", "major"]);

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const resolveCalverDate = () => {
  if (!dateOverride) {
    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  }

  const match = dateOverride.match(calverInputPattern);
  if (!match) {
    throw new Error(`Invalid --date value: ${dateOverride}. Expected YYYY-MM.`);
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
  };
};

const bumpCalver = (value) => {
  const { year, month } = resolveCalverDate();

  if (calverPattern.test(value)) {
    const [currentYear, currentMonth, currentPatch] = value.split(".").map(Number);
    if (currentYear === year && currentMonth === month) {
      return `${year}.${month}.${currentPatch + 1}`;
    }
  }

  return `${year}.${month}.0`;
};

const targetVersion = async () => {
  if (explicit) return explicit;
  const pkg = await readJson(path.join(ROOT, "package.json"));
  if (mode !== "calver") {
    console.warn(
      `[bump-version] '${mode}' now aliases to CalVer. Use 'pnpm bump:calver' explicitly.`,
    );
  }
  return bumpCalver(pkg.version);
};

const updatePackageJson = async (nextVersion) => {
  const uiPath = path.join(ROOT, "package.json");
  const tauriPath = path.join(REPO_ROOT, "packages", "desktop", "package.json");
  const orchestratorPath = path.join(REPO_ROOT, "packages", "orchestrator", "package.json");
  const serverPath = path.join(REPO_ROOT, "packages", "server", "package.json");
  const opencodeRouterPath = path.join(REPO_ROOT, "packages", "opencode-router", "package.json");
  const uiData = await readJson(uiPath);
  const tauriData = await readJson(tauriPath);
  const orchestratorData = await readJson(orchestratorPath);
  const serverData = await readJson(serverPath);
  const opencodeRouterData = await readJson(opencodeRouterPath);
  uiData.version = nextVersion;
  tauriData.version = nextVersion;
  // Desktop pins opencodeRouterVersion for sidecar bundling; keep it aligned.
  tauriData.opencodeRouterVersion = nextVersion;
  orchestratorData.version = nextVersion;

  // Ensure veslo-orchestrator uses the same veslo-server/opencode-router versions.
  orchestratorData.dependencies = orchestratorData.dependencies ?? {};
  orchestratorData.dependencies["veslo-server"] = nextVersion;
  orchestratorData.dependencies["opencode-router"] = nextVersion;

  serverData.version = nextVersion;
  opencodeRouterData.version = nextVersion;
  if (!isDryRun) {
    await writeFile(uiPath, JSON.stringify(uiData, null, 2) + "\n");
    await writeFile(tauriPath, JSON.stringify(tauriData, null, 2) + "\n");
    await writeFile(orchestratorPath, JSON.stringify(orchestratorData, null, 2) + "\n");
    await writeFile(serverPath, JSON.stringify(serverData, null, 2) + "\n");
    await writeFile(opencodeRouterPath, JSON.stringify(opencodeRouterData, null, 2) + "\n");
  }
};

const updateCargoToml = async (nextVersion) => {
  const filePath = path.join(REPO_ROOT, "packages", "desktop", "src-tauri", "Cargo.toml");
  const raw = await readFile(filePath, "utf8");
  const updated = raw.replace(/\bversion\s*=\s*"[^"]+"/m, `version = "${nextVersion}"`);
  if (!isDryRun) {
    await writeFile(filePath, updated);
    // Regenerate Cargo.lock so it stays in sync with the version bump.
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("cargo", ["generate-lockfile"], {
        cwd: path.join(REPO_ROOT, "packages", "desktop", "src-tauri"),
        stdio: "ignore",
      });
    } catch {
      // cargo may not be installed (e.g. CI without Rust); skip silently.
    }
  }
};

const updateTauriConfig = async (nextVersion) => {
  const filePath = path.join(REPO_ROOT, "packages", "desktop", "src-tauri", "tauri.conf.json");
  const data = JSON.parse(await readFile(filePath, "utf8"));
  data.version = nextVersion;
  if (!isDryRun) {
    await writeFile(filePath, JSON.stringify(data, null, 2) + "\n");
  }
};

const main = async () => {
  if (explicit && !calverPattern.test(explicit)) {
    throw new Error(`Invalid explicit version: ${explicit}. Expected YYYY.M.P`);
  }
  if (explicit === null && !calverModes.has(mode)) {
    throw new Error(`Unknown mode: ${mode}. Use 'calver' or '--set YYYY.M.P'.`);
  }

  const nextVersion = await targetVersion();
  await updatePackageJson(nextVersion);
  await updateCargoToml(nextVersion);
  await updateTauriConfig(nextVersion);

  console.log(
    JSON.stringify(
      {
        ok: true,
        version: nextVersion,
        dryRun: isDryRun,
        files: [
          "packages/app/package.json",
          "packages/desktop/package.json",
          "packages/orchestrator/package.json",
          "packages/server/package.json",
          "packages/opencode-router/package.json",
          "packages/desktop/src-tauri/Cargo.toml",
          "packages/desktop/src-tauri/tauri.conf.json",
        ],
      },
      null,
      2,
    ),
  );
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});
