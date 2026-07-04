#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateLicenseInventory } from "../../packages/document-runtime/src/index.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const licensePath = resolve(repoRoot, "packages/document-runtime/manifests/license-inventory.json");

try {
  const inventory = JSON.parse(readFileSync(licensePath, "utf8"));
  validateLicenseInventory(inventory, { label: licensePath });
  const reviewCount = inventory.entries.filter((entry) => entry.reviewRequired).length;
  console.log(`Validated ${inventory.entries.length} document runtime license entries (${reviewCount} require legal review).`);
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
}
