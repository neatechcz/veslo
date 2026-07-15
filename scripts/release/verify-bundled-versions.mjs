import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256WindowsAuthenticodeFile } from "./windows-authenticode-hash.mjs";

const REQUIRED_EXECUTABLE_SIDECARS = [
  "veslo-code",
  "opencode",
  "veslo-server",
  "veslo-code-router",
  "veslo-orchestrator",
  "chrome-devtools-mcp",
];

const requiredExecutableSidecars = (targetTriple) =>
  targetTriple?.includes("windows") ? [...REQUIRED_EXECUTABLE_SIDECARS, "veslo-node"] : REQUIRED_EXECUTABLE_SIDECARS;

const REQUIRED_DATA_SIDECARS = ["opencode-managed-deps.json"];

const REQUIRED_MANIFEST_ENTRIES = [
  "veslo-code",
  "veslo-server",
  "veslo-code-router",
  "veslo-orchestrator",
  "chrome-devtools-mcp",
  "opencode-managed-deps",
];

const manifestEntrySidecarName = (key) =>
  key === "opencode-managed-deps" ? "opencode-managed-deps.json" : key;

const candidateRoots = (bundlePath) =>
  bundlePath.endsWith(".app")
    ? [join(bundlePath, "Contents", "MacOS"), join(bundlePath, "Contents", "Resources")]
    : [bundlePath];

const candidateManifestPaths = (bundlePath, targetTriple) => {
  const suffixes = targetTriple
    ? ["", `-${targetTriple}`, `-${targetTriple}.exe`, ".exe"]
    : ["", ".exe"];
  const roots = candidateRoots(bundlePath);

  return roots.flatMap((root) => suffixes.map((suffix) => join(root, `versions.json${suffix}`)));
};

const candidateSidecarPaths = (bundlePath, targetTriple, name) => {
  const suffixes = targetTriple ? [`-${targetTriple}.exe`, `-${targetTriple}`, ".exe", ""] : [".exe", ""];
  const roots = candidateRoots(bundlePath);

  return roots.flatMap((root) => suffixes.map((suffix) => join(root, `${name}${suffix}`)));
};

const findBundlePath = (extractRoot) => {
  const entries = readdirSync(extractRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => join(extractRoot, entry.name));

  if (entries.length > 1) {
    throw new Error(`Multiple macOS app bundles found in ${extractRoot}: ${entries.join(", ")}`);
  }

  return entries[0] ?? extractRoot;
};

export const findBundledVersionsManifest = (extractRoot, { targetTriple } = {}) => {
  const root = resolve(extractRoot);
  const bundlePath = findBundlePath(root);

  for (const candidate of candidateManifestPaths(bundlePath, targetTriple)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  throw new Error(
    `versions.json missing from bundle ${bundlePath}. Checked: ${candidateManifestPaths(bundlePath, targetTriple).join(", ")}`,
  );
};

const findRequiredSidecar = (bundlePath, targetTriple, name) => {
  for (const candidate of candidateSidecarPaths(bundlePath, targetTriple, name)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  throw new Error(
    `${name} missing from bundle ${bundlePath}. Checked: ${candidateSidecarPaths(bundlePath, targetTriple, name).join(", ")}`,
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

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sha256ManifestSidecar = (path, targetTriple, key) =>
  targetTriple?.includes("windows") && key !== "opencode-managed-deps"
    ? sha256WindowsAuthenticodeFile(path)
    : sha256File(path);

const assertVersionsManifestEntries = (manifestPath, manifest) => {
  for (const key of REQUIRED_MANIFEST_ENTRIES) {
    const entry = manifest?.[key];
    const sha256 = typeof entry?.sha256 === "string" ? entry.sha256.trim() : "";
    if (!/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new Error(`Bundled versions manifest ${manifestPath} is missing a sha256 for ${key}`);
    }
  }
};

const assertBundledManifestHashes = (
  manifestPath,
  manifest,
  sidecars,
  targetTriple,
) => {
  const sidecarPathsByName = new Map(sidecars.map((sidecar) => [sidecar.name, sidecar.path]));

  for (const key of REQUIRED_MANIFEST_ENTRIES) {
    const sidecarName = manifestEntrySidecarName(key);
    const sidecarPath = sidecarPathsByName.get(sidecarName);
    if (!sidecarPath) {
      throw new Error(`Bundled sidecar for manifest entry ${key} was not found`);
    }

    const expected = manifest[key].sha256.trim().toLowerCase();
    const actual = sha256ManifestSidecar(sidecarPath, targetTriple, key).toLowerCase();
    if (actual !== expected) {
      throw new Error(
        `Bundled versions manifest ${manifestPath} sha256 mismatch for ${key}: ${actual} vs ${expected}`,
      );
    }
  }
};

export const verifyBundledSidecars = (extractRoot, { targetTriple } = {}) => {
  const root = resolve(extractRoot);
  const appPath = findBundlePath(root);
  const manifestPath = findBundledVersionsManifest(root, { targetTriple });
  const manifest = readVersionsManifest(manifestPath);
  assertVersionsManifestEntries(manifestPath, manifest);

  const executables = requiredExecutableSidecars(targetTriple).map((name) => {
    const path = findRequiredSidecar(appPath, targetTriple, name);
    assertExecutableSidecar(path);
    return { name, path };
  });
  const dataFiles = REQUIRED_DATA_SIDECARS.map((name) => {
    const path = findRequiredSidecar(appPath, targetTriple, name);
    assertDataSidecar(path);
    return { name, path };
  });

  const sidecars = [...executables, ...dataFiles];
  assertBundledManifestHashes(manifestPath, manifest, sidecars, targetTriple);

  return {
    appPath,
    manifestPath,
    sidecars,
  };
};

const maybeRunCli = () => {
  if (
    !process.argv[1] ||
    resolve(process.argv[1]) !== fileURLToPath(import.meta.url)
  ) {
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
