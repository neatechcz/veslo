import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
const outputJson = args.includes("--json");
const strict = args.includes("--strict");
const calverPattern = /^\d{4}\.(?:[1-9]|1[0-2])\.\d+$/;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readText = (path) => readFileSync(path, "utf8");

const readCargoVersion = (path) => {
  const content = readText(path);
  const match = content.match(/^version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
};

const appPkg = readJson(resolve(root, "packages", "app", "package.json"));
const desktopPkg = readJson(resolve(root, "packages", "desktop", "package.json"));
const orchestratorPkg = readJson(resolve(root, "packages", "orchestrator", "package.json"));
const serverPkg = readJson(resolve(root, "packages", "server", "package.json"));
const opencodeRouterPkg = readJson(resolve(root, "packages", "opencode-router", "package.json"));
const tauriConfig = readJson(resolve(root, "packages", "desktop", "src-tauri", "tauri.conf.json"));
const cargoVersion = readCargoVersion(resolve(root, "packages", "desktop", "src-tauri", "Cargo.toml"));

const versions = {
  app: appPkg.version ?? null,
  desktop: desktopPkg.version ?? null,
  tauri: tauriConfig.version ?? null,
  cargo: cargoVersion ?? null,
  server: serverPkg.version ?? null,
  orchestrator: orchestratorPkg.version ?? null,
  opencodeRouter: opencodeRouterPkg.version ?? null,
  opencode: {
    desktop: desktopPkg.opencodeVersion ?? null,
    orchestrator: orchestratorPkg.opencodeVersion ?? null,
  },
  opencodeRouterVersionPinned: desktopPkg.opencodeRouterVersion ?? null,
  orchestratorVesloServerRange: orchestratorPkg.dependencies?.["veslo-server"] ?? null,
};

const checks = [];
const warnings = [];
let ok = true;

const addCheck = (label, pass, details) => {
  checks.push({ label, ok: pass, details });
  if (!pass) ok = false;
};

const addWarning = (message) => warnings.push(message);

const versionChecks = [
  ["app", versions.app],
  ["desktop", versions.desktop],
  ["tauri", versions.tauri],
  ["cargo", versions.cargo],
  ["veslo-orchestrator", versions.orchestrator],
  ["veslo-server", versions.server],
  ["veslo-code-router", versions.opencodeRouter],
];
for (const [label, value] of versionChecks) {
  addCheck(
    `${label} uses CalVer (YYYY.M.P)`,
    typeof value === "string" && calverPattern.test(value),
    value ?? "?",
  );
}

addCheck(
  "App/desktop versions match",
  versions.app && versions.desktop && versions.app === versions.desktop,
  `${versions.app ?? "?"} vs ${versions.desktop ?? "?"}`,
);
addCheck(
  "App/veslo-orchestrator versions match",
  versions.app && versions.orchestrator && versions.app === versions.orchestrator,
  `${versions.app ?? "?"} vs ${versions.orchestrator ?? "?"}`,
);
addCheck(
  "App/veslo-server versions match",
  versions.app && versions.server && versions.app === versions.server,
  `${versions.app ?? "?"} vs ${versions.server ?? "?"}`,
);
addCheck(
  "App/veslo-code-router versions match",
  versions.app && versions.opencodeRouter && versions.app === versions.opencodeRouter,
  `${versions.app ?? "?"} vs ${versions.opencodeRouter ?? "?"}`,
);
addCheck(
  "Desktop/Tauri versions match",
  versions.desktop && versions.tauri && versions.desktop === versions.tauri,
  `${versions.desktop ?? "?"} vs ${versions.tauri ?? "?"}`,
);
addCheck(
  "Desktop/Cargo versions match",
  versions.desktop && versions.cargo && versions.desktop === versions.cargo,
  `${versions.desktop ?? "?"} vs ${versions.cargo ?? "?"}`,
);
addCheck(
  "OpenCodeRouter version pinned in desktop",
  versions.opencodeRouter && versions.opencodeRouterVersionPinned && versions.opencodeRouter === versions.opencodeRouterVersionPinned,
  `${versions.opencodeRouterVersionPinned ?? "?"} vs ${versions.opencodeRouter ?? "?"}`,
);
if (versions.opencode.desktop || versions.opencode.orchestrator) {
  addCheck(
    "OpenCode version matches (desktop/orchestrator)",
    versions.opencode.desktop &&
      versions.opencode.orchestrator &&
      versions.opencode.desktop === versions.opencode.orchestrator,
    `${versions.opencode.desktop ?? "?"} vs ${versions.opencode.orchestrator ?? "?"}`,
  );
} else {
  addWarning(
    "OpenCode version is not pinned (packages/desktop + packages/orchestrator). Sidecar bundling will default to the latest OpenCode release at build time.",
  );
}

const vesloServerRange = versions.orchestratorVesloServerRange ?? "";
const vesloServerPinned = calverPattern.test(vesloServerRange);
if (!vesloServerRange) {
  addWarning("veslo-orchestrator is missing a veslo-server dependency.");
} else if (!vesloServerPinned) {
  addWarning(`veslo-orchestrator veslo-server dependency is not pinned (${vesloServerRange}).`);
} else {
  addCheck(
    "Veslo-server dependency matches server version",
    versions.server && vesloServerRange === versions.server,
    `${vesloServerRange} vs ${versions.server ?? "?"}`,
  );
}

const sidecarManifestPath = resolve(
  root,
  "packages",
  "orchestrator",
  "dist",
  "sidecars",
  "veslo-orchestrator-sidecars.json",
);
if (existsSync(sidecarManifestPath)) {
  const manifest = readJson(sidecarManifestPath);
  addCheck(
    "Sidecar manifest version matches veslo-orchestrator",
    versions.orchestrator && manifest.version === versions.orchestrator,
    `${manifest.version ?? "?"} vs ${versions.orchestrator ?? "?"}`,
  );
  const serverEntry = manifest.entries?.["veslo-server"]?.version;
  const routerEntry = manifest.entries?.["veslo-code-router"]?.version;
  if (serverEntry) {
    addCheck(
      "Sidecar manifest veslo-server version matches",
      versions.server && serverEntry === versions.server,
      `${serverEntry ?? "?"} vs ${versions.server ?? "?"}`,
    );
  }
  if (routerEntry) {
    addCheck(
      "Sidecar manifest veslo-code-router version matches",
      versions.opencodeRouter && routerEntry === versions.opencodeRouter,
      `${routerEntry ?? "?"} vs ${versions.opencodeRouter ?? "?"}`,
    );
  }
} else {
  addWarning(
    "Sidecar manifest missing (run pnpm --filter veslo-orchestrator build:sidecars).",
  );
}

if (!process.env.SOURCE_DATE_EPOCH) {
  addWarning("SOURCE_DATE_EPOCH is not set (sidecar manifests will include current time).");
}

const report = { ok, versions, checks, warnings };

if (outputJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("Release review");
  for (const check of checks) {
    const status = check.ok ? "ok" : "fail";
    console.log(`- ${status}: ${check.label} (${check.details})`);
  }
  if (warnings.length) {
    console.log("Warnings:");
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }
}

if (strict && !ok) {
  process.exit(1);
}
