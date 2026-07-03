#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  validateDependencyInventory,
  validateDocumentRuntimeManifest,
} from "../../packages/document-runtime/src/index.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const manifestRoot = join(repoRoot, "packages/document-runtime/manifests");
const targetRoot = join(manifestRoot, "targets");

const readJson = (filePath) => {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read JSON ${filePath}: ${message}`);
  }
};

const validateAll = () => {
  const inventoryPath = join(manifestRoot, "dependency-inventory.json");
  validateDependencyInventory(readJson(inventoryPath), { label: inventoryPath });

  const targetFiles = readdirSync(targetRoot)
    .filter((name) => name.endsWith(".json"))
    .sort();

  if (targetFiles.length === 0) {
    throw new Error(`No target manifests found in ${targetRoot}`);
  }

  for (const file of targetFiles) {
    const filePath = join(targetRoot, file);
    validateDocumentRuntimeManifest(readJson(filePath), { label: filePath });
  }

  return { inventoryPath, targetFiles };
};

try {
  const result = validateAll();
  console.log(`Validated ${result.targetFiles.length} document runtime target manifests.`);
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
}
