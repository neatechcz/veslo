import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const candidateManifestPaths = (appPath, targetTriple) => {
  const suffixes = targetTriple ? ["", `-${targetTriple}`] : [""];
  const roots = [
    join(appPath, "Contents", "MacOS"),
    join(appPath, "Contents", "Resources"),
  ];

  return roots.flatMap((root) => suffixes.map((suffix) => join(root, `versions.json${suffix}`)));
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
    const manifestPath = findBundledVersionsManifest(extractRoot, { targetTriple });
    console.log(`Found bundled versions.json at ${manifestPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exit(1);
  }
};

maybeRunCli();
