#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validatePackageFeed } from "../../packages/document-runtime/src/index.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const defaultFeedPath = resolve(repoRoot, "packages/document-runtime/manifests/package-feed.example.json");
const feedPath = process.argv[2] ? resolve(process.argv[2]) : defaultFeedPath;

try {
  const feed = JSON.parse(readFileSync(feedPath, "utf8"));
  validatePackageFeed(feed, { label: feedPath });
  console.log(`Validated document runtime package feed: ${feedPath}`);
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
}
