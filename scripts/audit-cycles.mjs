import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const targets = [
  {
    name: "app",
    entry: "packages/app/src/app/app.tsx",
    tsConfig: "packages/app/tsconfig.json",
    extensions: "ts,tsx",
  },
  {
    name: "server",
    entry: "packages/server/src/cli.ts",
    tsConfig: "packages/server/tsconfig.json",
    extensions: "ts",
  },
  {
    name: "orchestrator",
    entry: "packages/orchestrator/src/cli.ts",
    tsConfig: "packages/orchestrator/tsconfig.json",
    extensions: "ts",
  },
  {
    name: "code-router",
    entry: "packages/opencode-router/src/cli.ts",
    tsConfig: "packages/opencode-router/tsconfig.json",
    extensions: "ts",
  },
  {
    name: "den",
    entry: "services/den/src/index.ts",
    tsConfig: "services/den/tsconfig.json",
    extensions: "ts",
  },
  {
    name: "ai-gateway",
    entry: "services/ai-gateway/src/index.ts",
    tsConfig: "services/ai-gateway/tsconfig.json",
    extensions: "ts",
  },
  {
    name: "worker-manager",
    entry: "services/worker-manager/src/index.ts",
    tsConfig: "services/worker-manager/tsconfig.json",
    extensions: "ts",
  },
];

const require = createRequire(import.meta.url);
const madgeCli = require.resolve("madge/bin/cli.js");
let failed = false;

for (const target of targets) {
  console.log(`\n=== ${target.name} ===`);

  const result = spawnSync(
    process.execPath,
    [
      madgeCli,
      "--circular",
      "--warning",
      "--extensions",
      target.extensions,
      "--ts-config",
      target.tsConfig,
      target.entry,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stdout.write(result.stderr);

  if (result.error) {
    console.error(`Madge failed to start for ${target.name}: ${result.error.message}`);
    failed = true;
    continue;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const processedMatch = output.match(/Processed\s+(\d+)\s+files/);
  const processedCount = processedMatch ? Number(processedMatch[1]) : null;

  if (processedCount === null) {
    console.error(`Madge output for ${target.name} did not include a processed file count.`);
    failed = true;
  } else if (processedCount === 0) {
    console.error(`Madge processed 0 files for ${target.name}; check the entrypoint or tsconfig.`);
    failed = true;
  }

  if (result.status !== 0) {
    failed = true;
  }
}

if (failed) {
  console.log("\nCycle audit failed. Resolve the reported cycles or fix targets that processed 0 files.");
  process.exit(1);
}

console.log("\nCycle audit passed.");
