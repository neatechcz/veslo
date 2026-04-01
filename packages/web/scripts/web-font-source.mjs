import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const layoutPath = resolve(here, "../app/layout.tsx");
const layoutSource = readFileSync(layoutPath, "utf8");

assert.equal(
  layoutSource.includes('from "next/font/google"'),
  false,
  "packages/web/app/layout.tsx must not import next/font/google because the build must work without network access",
);

console.log("web-font-source: no next/font/google import found");
