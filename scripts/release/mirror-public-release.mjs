#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publicDesktopReleaseAssetName } from "./public-release-assets.mjs";

function parseBool(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseArgs(argv) {
  const options = {
    sourceRepo: process.env.GITHUB_REPOSITORY || "",
    targetRepo:
      process.env.RELEASE_UPDATES_REPO ||
      process.env.VESLO_UPDATES_REPO ||
      process.env.PUBLIC_RELEASE_REPO ||
      "",
    tag: process.env.RELEASE_TAG || "",
    releaseName: process.env.RELEASE_NAME || "",
    releaseBody: process.env.RELEASE_BODY || "",
    draft: parseBool(process.env.RELEASE_DRAFT || "false"),
    prerelease: parseBool(process.env.RELEASE_PRERELEASE || "false"),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1] || "";
    if (arg === "--source-repo") {
      options.sourceRepo = next;
      i += 1;
      continue;
    }
    if (arg === "--target-repo") {
      options.targetRepo = next;
      i += 1;
      continue;
    }
    if (arg === "--tag") {
      options.tag = next;
      i += 1;
      continue;
    }
    if (arg === "--release-name") {
      options.releaseName = next;
      i += 1;
      continue;
    }
    if (arg === "--release-body") {
      options.releaseBody = next;
      i += 1;
      continue;
    }
    if (arg === "--draft") {
      options.draft = parseBool(next);
      i += 1;
      continue;
    }
    if (arg === "--prerelease") {
      options.prerelease = parseBool(next);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.sourceRepo) throw new Error("Missing --source-repo.");
  if (!options.targetRepo) throw new Error("Missing --target-repo.");
  if (!options.tag) throw new Error("Missing --tag.");

  return options;
}

function runGh(args, token) {
  const env = { ...process.env };
  if (token) env.GH_TOKEN = token;
  return execFileSync("gh", args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function releaseExists(repo, tag, token) {
  try {
    runGh(["release", "view", tag, "--repo", repo], token);
    return true;
  } catch {
    return false;
  }
}

function sourceReleaseAssets(repo, tag, token) {
  const raw = runGh(["release", "view", tag, "--repo", repo, "--json", "assets"], token);
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.assets) ? parsed.assets : [];
}

function main() {
  const {
    sourceRepo,
    targetRepo,
    tag,
    releaseName,
    releaseBody,
    draft,
    prerelease,
  } = parseArgs(process.argv);

  const sourceToken = process.env.SOURCE_GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const targetToken =
    process.env.TARGET_GH_TOKEN || process.env.RELEASE_UPDATES_GH_TOKEN || process.env.GH_TOKEN || "";

  if (!targetToken) {
    throw new Error("Missing TARGET_GH_TOKEN or GH_TOKEN for the public release repository.");
  }

  const tempDir = mkdtempSync(join(tmpdir(), "veslo-public-release-"));

  try {
    const publicAssets = sourceReleaseAssets(sourceRepo, tag, sourceToken)
      .map((asset) => ({
        sourceName: asset.name || "",
        publicName: publicDesktopReleaseAssetName(asset),
      }))
      .filter((asset) => asset.sourceName && asset.publicName);

    for (const { sourceName, publicName } of publicAssets) {
      runGh(
        [
          "release",
          "download",
          tag,
          "--repo",
          sourceRepo,
          "--dir",
          tempDir,
          "--pattern",
          sourceName,
          "--clobber",
        ],
        sourceToken,
      );

      if (publicName !== sourceName) {
        renameSync(join(tempDir, sourceName), join(tempDir, publicName));
      }
    }

    const files = publicAssets
      .map(({ publicName }) => join(tempDir, publicName))
      .sort();

    if (!files.length) {
      throw new Error(`No public desktop assets were downloaded from ${sourceRepo}@${tag}.`);
    }

    if (!releaseExists(targetRepo, tag, targetToken)) {
      const createArgs = [
        "release",
        "create",
        tag,
        "--repo",
        targetRepo,
        "--title",
        releaseName || `Veslo ${tag}`,
        "--notes",
        releaseBody || "See the assets to download this version and install.",
      ];
      if (draft) createArgs.push("--draft");
      if (prerelease) createArgs.push("--prerelease");
      else createArgs.push("--latest=false");
      runGh(createArgs, targetToken);
    }

    runGh(["release", "upload", tag, ...files, "--repo", targetRepo, "--clobber"], targetToken);

    console.log(
      `Mirrored ${files.length} public desktop assets from ${sourceRepo}@${tag} to ${targetRepo}@${tag}.`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
