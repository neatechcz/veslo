#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const files = [
  "src/cli.mjs",
  "src/index.mjs",
  "src/manifest.mjs",
  "src/runtime.mjs",
  "src/cli.test.mjs",
  "src/manifest.test.mjs",
  "src/runtime.test.mjs",
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

console.log(`Syntax checked ${files.length} document runtime files.`);
