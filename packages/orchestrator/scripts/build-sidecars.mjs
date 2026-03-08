import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(root, "..", "..");
const outdir = resolve(root, "dist", "sidecars");

const orchestratorPkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const orchestratorVersion = String(orchestratorPkg.version ?? "").trim();
if (!orchestratorVersion) {
  throw new Error("veslo-orchestrator version missing in packages/orchestrator/package.json");
}

const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH
  ? Number(process.env.SOURCE_DATE_EPOCH)
  : null;
const generatedAt = Number.isFinite(sourceDateEpoch)
  ? new Date(sourceDateEpoch * 1000).toISOString()
  : new Date().toISOString();

const serverPkg = JSON.parse(readFileSync(resolve(repoRoot, "packages", "server", "package.json"), "utf8"));
const serverVersion = String(serverPkg.version ?? "").trim();
if (!serverVersion) {
  throw new Error("veslo-server version missing in packages/server/package.json");
}

const routerPkg = JSON.parse(
  readFileSync(resolve(repoRoot, "packages", "opencode-router", "package.json"), "utf8"),
);
const routerVersion = String(routerPkg.version ?? "").trim();
if (!routerVersion) {
  throw new Error("veslo-code-router version missing in packages/opencode-router/package.json");
}

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

run("pnpm", ["--filter", "veslo-server", "build:bin:all"], repoRoot);
run("pnpm", ["--filter", "veslo-code-router", "build:bin:all"], repoRoot);

const targets = [
  { id: "darwin-arm64", bun: "bun-darwin-arm64" },
  { id: "darwin-x64", bun: "bun-darwin-x64" },
  { id: "linux-x64", bun: "bun-linux-x64" },
  { id: "linux-arm64", bun: "bun-linux-arm64" },
  { id: "windows-x64", bun: "bun-windows-x64" },
];

const sha256File = (path) => {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
};

const serverDir = resolve(repoRoot, "packages", "server", "dist", "bin");
const routerDir = resolve(repoRoot, "packages", "opencode-router", "dist", "bin");

mkdirSync(outdir, { recursive: true });

const entries = {
  "veslo-server": { version: serverVersion, targets: {} },
  "veslo-code-router": { version: routerVersion, targets: {} },
};

for (const target of targets) {
  const ext = target.id.startsWith("windows") ? ".exe" : "";
  const serverSrc = join(serverDir, `veslo-server-${target.bun}${ext}`);
  if (!existsSync(serverSrc)) {
    throw new Error(`Missing veslo-server binary at ${serverSrc}`);
  }
  const serverDest = join(outdir, `veslo-server-${target.id}${ext}`);
  copyFileSync(serverSrc, serverDest);

  const routerSrc = join(routerDir, `veslo-code-router-${target.bun}${ext}`);
  if (!existsSync(routerSrc)) {
    throw new Error(`Missing veslo-code-router binary at ${routerSrc}`);
  }
  const routerDest = join(outdir, `veslo-code-router-${target.id}${ext}`);
  copyFileSync(routerSrc, routerDest);

  entries["veslo-server"].targets[target.id] = {
    asset: basename(serverDest),
    sha256: sha256File(serverDest),
    size: statSync(serverDest).size,
  };
  entries["veslo-code-router"].targets[target.id] = {
    asset: basename(routerDest),
    sha256: sha256File(routerDest),
    size: statSync(routerDest).size,
  };
}

const manifest = {
  version: orchestratorVersion,
  generatedAt,
  entries,
};

writeFileSync(
  join(outdir, "veslo-orchestrator-sidecars.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
