#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PUBLIC_RELEASE_REPO,
} from "./public-release-assets.mjs";
import {
  DOCUMENT_RUNTIME_PACKAGE_ID,
  documentRuntimePackageAssetName,
  documentRuntimePackageSignatureName,
  validateDocumentRuntimeManifest,
  validatePackageFeed,
} from "../../packages/document-runtime/src/index.mjs";

const DEFAULT_PLATFORMS = ["windows-native-x64", "macos-arm64", "macos-x64"];

const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));

const sha256File = (filePath) => {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
};

const releaseAssetUrl = (repo, tag, assetName) => {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${assetName}`;
};

const collectFiles = (root) => {
  if (!existsSync(root)) return new Map();
  const found = new Map();
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        found.set(entry.name, path);
      }
    }
  };
  visit(root);
  return found;
};

const parseArgs = (argv) => {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const options = {
    repoRoot,
    tag: process.env.RELEASE_TAG || "",
    repo: process.env.PUBLIC_RELEASE_REPO || process.env.RELEASE_UPDATES_REPO || DEFAULT_PUBLIC_RELEASE_REPO,
    channel: process.env.VESLO_DOCUMENT_RUNTIME_CHANNEL || "stable",
    packageRoot:
      process.env.VESLO_DOCUMENT_RUNTIME_PACKAGE_ROOT ||
      resolve(repoRoot, "packages/document-runtime/packages"),
    manifestRoot: resolve(repoRoot, "packages/document-runtime/manifests/targets"),
    output: "document-runtime-packages.json",
    generatedAt: process.env.SOURCE_DATE_EPOCH
      ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
      : new Date().toISOString(),
    platforms: [...DEFAULT_PLATFORMS],
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      options.tag = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      options.repo = argv[index + 1] || options.repo;
      index += 1;
      continue;
    }
    if (arg === "--channel") {
      options.channel = argv[index + 1] || options.channel;
      index += 1;
      continue;
    }
    if (arg === "--package-root") {
      options.packageRoot = resolve(argv[index + 1] || options.packageRoot);
      index += 1;
      continue;
    }
    if (arg === "--manifest-root") {
      options.manifestRoot = resolve(argv[index + 1] || options.manifestRoot);
      index += 1;
      continue;
    }
    if (arg === "--output") {
      options.output = resolve(argv[index + 1] || options.output);
      index += 1;
      continue;
    }
    if (arg === "--generated-at") {
      options.generatedAt = argv[index + 1] || options.generatedAt;
      index += 1;
      continue;
    }
    if (arg === "--platform") {
      options.platforms.push(argv[index + 1] || "");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.tag) {
    throw new Error("Missing --tag vYYYY.M.P or RELEASE_TAG.");
  }
  if (!options.tag.startsWith("v")) {
    throw new Error("Release tag must start with v, for example v2026.7.0.");
  }

  return options;
};

export function generateDocumentRuntimePackageFeed(options) {
  const packageFiles = collectFiles(options.packageRoot);
  const packages = [];

  for (const platform of options.platforms) {
    if (!platform) continue;
    const manifestPath = resolve(options.manifestRoot, `${platform}.json`);
    const manifest = validateDocumentRuntimeManifest(readJson(manifestPath), { label: manifestPath });
    const artifactName = documentRuntimePackageAssetName({
      platform,
      packageVersion: manifest.packageVersion,
    });
    const signatureName = documentRuntimePackageSignatureName({
      platform,
      packageVersion: manifest.packageVersion,
    });
    const artifactPath = packageFiles.get(artifactName);
    const signaturePath = packageFiles.get(signatureName);

    if (!artifactPath) {
      throw new Error(`Missing document runtime package artifact ${artifactName} under ${options.packageRoot}`);
    }
    if (!signaturePath) {
      throw new Error(`Missing document runtime package signature ${signatureName} under ${options.packageRoot}`);
    }

    const stat = statSync(artifactPath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error(`Document runtime package artifact is empty: ${artifactPath}`);
    }

    const signature = readFileSync(signaturePath, "utf8").trim();
    if (!signature) {
      throw new Error(`Document runtime package signature is empty: ${signaturePath}`);
    }

    packages.push({
      packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
      packageVersion: manifest.packageVersion,
      platform,
      channel: options.channel,
      minimumAppVersion: manifest.minimumAppVersion,
      artifactName: basename(artifactPath),
      url: releaseAssetUrl(options.repo, options.tag, basename(artifactPath)),
      signature,
      contentSha256: sha256File(artifactPath),
      manifestSha256: manifest.manifestSha256,
      sizeBytes: stat.size,
    });
  }

  const feed = {
    schemaVersion: 1,
    packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
    releaseTag: options.tag,
    channel: options.channel,
    generatedAt: options.generatedAt,
    packages,
  };
  validatePackageFeed(feed);
  return feed;
}

const maybeRunCli = () => {
  if (resolve(process.argv[1] || "") !== fileURLToPath(import.meta.url)) return;

  try {
    const options = parseArgs(process.argv);
    const feed = generateDocumentRuntimePackageFeed(options);
    writeFileSync(options.output, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
    console.log(`Wrote ${options.output} with ${feed.packages.length} document runtime packages.`);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
};

maybeRunCli();
