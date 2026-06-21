import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REQUIRED_EXECUTABLE_SIDECARS = [
  "veslo-code",
  "opencode",
  "veslo-server",
  "veslo-code-router",
  "veslo-orchestrator",
  "chrome-devtools-mcp",
];

const REQUIRED_DATA_SIDECARS = ["opencode-managed-deps.json"];

const REQUIRED_MANIFEST_ENTRIES = [
  "veslo-code",
  "veslo-server",
  "veslo-code-router",
  "veslo-orchestrator",
  "chrome-devtools-mcp",
  "opencode-managed-deps",
];

const candidateManifestPaths = (appPath, targetTriple) => {
  const suffixes = targetTriple ? ["", `-${targetTriple}`] : [""];
  const roots = [
    join(appPath, "Contents", "MacOS"),
    join(appPath, "Contents", "Resources"),
  ];

  return roots.flatMap((root) => suffixes.map((suffix) => join(root, `versions.json${suffix}`)));
};

const candidateSidecarPaths = (appPath, targetTriple, name) => {
  const suffixes = targetTriple ? [`-${targetTriple}`, ""] : [""];
  const roots = [
    join(appPath, "Contents", "MacOS"),
    join(appPath, "Contents", "Resources"),
  ];

  return roots.flatMap((root) => suffixes.map((suffix) => join(root, `${name}${suffix}`)));
};

const findAppBundle = (extractRoot) => {
  const entries = readdirSync(extractRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => join(extractRoot, entry.name));

  if (entries.length === 0) {
    throw new Error(`No macOS app bundle found in ${extractRoot}`);
  }

  if (entries.length > 1) {
    throw new Error(`Multiple macOS app bundles found in ${extractRoot}: ${entries.join(", ")}`);
  }

  return entries[0];
};

export const findBundledVersionsManifest = (extractRoot, { targetTriple } = {}) => {
  const root = resolve(extractRoot);
  const appPath = findAppBundle(root);

  for (const candidate of candidateManifestPaths(appPath, targetTriple)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  throw new Error(
    `versions.json missing from app bundle ${appPath}. Checked: ${candidateManifestPaths(appPath, targetTriple).join(", ")}`,
  );
};

const findRequiredSidecar = (appPath, targetTriple, name) => {
  for (const candidate of candidateSidecarPaths(appPath, targetTriple, name)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  throw new Error(
    `${name} missing from app bundle ${appPath}. Checked: ${candidateSidecarPaths(appPath, targetTriple, name).join(", ")}`,
  );
};

const assertExecutableSidecar = (sidecarPath) => {
  const stat = statSync(sidecarPath);
  if (stat.size <= 0) {
    throw new Error(`Bundled sidecar is empty: ${sidecarPath}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o111) === 0) {
    throw new Error(`Bundled sidecar is not executable: ${sidecarPath}`);
  }
};

const assertDataSidecar = (sidecarPath) => {
  const stat = statSync(sidecarPath);
  if (stat.size <= 0) {
    throw new Error(`Bundled sidecar data file is empty: ${sidecarPath}`);
  }
};

const readVersionsManifest = (manifestPath) => {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to parse bundled versions manifest ${manifestPath}: ${message}`);
  }
};

const assertVersionsManifestEntries = (manifestPath) => {
  const manifest = readVersionsManifest(manifestPath);
  for (const key of REQUIRED_MANIFEST_ENTRIES) {
    const entry = manifest?.[key];
    const sha256 = typeof entry?.sha256 === "string" ? entry.sha256.trim() : "";
    if (!/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new Error(`Bundled versions manifest ${manifestPath} is missing a sha256 for ${key}`);
    }
  }
};

export const verifyBundledSidecars = (extractRoot, { targetTriple } = {}) => {
  const root = resolve(extractRoot);
  const appPath = findAppBundle(root);
  const manifestPath = findBundledVersionsManifest(root, { targetTriple });
  assertVersionsManifestEntries(manifestPath);

  const executables = REQUIRED_EXECUTABLE_SIDECARS.map((name) => {
    const path = findRequiredSidecar(appPath, targetTriple, name);
    assertExecutableSidecar(path);
    return { name, path };
  });
  const dataFiles = REQUIRED_DATA_SIDECARS.map((name) => {
    const path = findRequiredSidecar(appPath, targetTriple, name);
    assertDataSidecar(path);
    return { name, path };
  });

  return {
    appPath,
    manifestPath,
    sidecars: [...executables, ...dataFiles],
  };
};

const maybeRunCli = () => {
  if (process.argv[1] !== new URL(import.meta.url).pathname) {
    return;
  }

  const extractRoot = process.argv[2];
  const targetTriple = process.argv[3];

  if (!extractRoot) {
    console.error("Usage: node scripts/release/verify-bundled-versions.mjs <extract-root> [target-triple]");
    process.exit(1);
  }

  try {
    const result = verifyBundledSidecars(extractRoot, { targetTriple });
    console.log(`Found bundled versions.json at ${result.manifestPath}`);
    for (const sidecar of result.sidecars) {
      console.log(`Found bundled ${sidecar.name} at ${sidecar.path}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exit(1);
  }
};

maybeRunCli();
