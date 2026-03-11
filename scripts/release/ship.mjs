#!/usr/bin/env node
/**
 * release:ship
 *
 * Pushes the current tag + dev branch to origin, then prints the
 * GitHub Actions workflow URL. Optionally tails the workflow run.
 *
 * Flags:
 *   --dry-run   Print what would happen without pushing.
 *   --watch     Tail the GHA workflow run after push.
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PUBLIC_RELEASE_REPO } from "./public-release-assets.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);

const dryRun = args.includes("--dry-run");
const watch = args.includes("--watch");

const log = (msg) => console.log(`  ${msg}`);
const heading = (msg) => console.log(`\n▸ ${msg}`);
const success = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
};

const run = (cmd, opts = {}) => {
  if (dryRun && !opts.readOnly) {
    log(`[dry-run] ${cmd}`);
    return "";
  }
  try {
    return execSync(cmd, {
      cwd: root,
      encoding: "utf8",
      stdio: opts.inherit ? "inherit" : "pipe",
    }).trim();
  } catch (err) {
    if (opts.allowFail) return "";
    fail(`Command failed: ${cmd}\n${err.stderr || err.message}`);
  }
};

const repoFromRemoteUrl = (remoteUrl) => {
  const match = String(remoteUrl || "").trim().match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  return match ? match[1] : "";
};

// ── Step 1: Resolve tag from HEAD ───────────────────────────────────
heading("Resolving tag");

const tag = run("git describe --tags --exact-match HEAD", {
  readOnly: true,
  allowFail: true,
});

if (!tag) {
  fail(
    "HEAD is not tagged. Run 'pnpm release:prepare' first.\n" +
    "  (Expected a CalVer tag like v2026.3.0 on HEAD)"
  );
}

if (!/^v\d{4}\.(?:[1-9]|1[0-2])\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(tag)) {
  fail(`Tag '${tag}' does not look like a CalVer release tag (expected vYYYY.M.P)`);
}

success(`Found tag: ${tag}`);

// ── Step 2: Push tag ────────────────────────────────────────────────
heading("Pushing tag to origin");
run(`git push origin ${tag}`);
success(`Pushed ${tag}`);

// ── Step 3: Push dev ────────────────────────────────────────────────
heading("Pushing dev to origin");
run("git push origin dev");
success("Pushed dev");

// ── Step 4: Print workflow URL ──────────────────────────────────────
heading("GitHub Actions");

const sourceRepo =
  repoFromRemoteUrl(run("git remote get-url origin", { readOnly: true, allowFail: true })) ||
  "neatechcz/veslo";
const publicRepo =
  process.env.RELEASE_UPDATES_REPO || process.env.VESLO_UPDATES_REPO || DEFAULT_PUBLIC_RELEASE_REPO;
const workflowUrl = `https://github.com/${sourceRepo}/actions/workflows/release-macos-aarch64.yml`;
log(`Workflow:       ${workflowUrl}`);
log(`Source release: https://github.com/${sourceRepo}/releases/tag/${tag}`);
log(`Public release: https://github.com/${publicRepo}/releases/tag/${tag}`);

// ── Step 5: Optionally watch ────────────────────────────────────────
if (watch && !dryRun) {
  heading("Watching workflow run");
  log("Waiting for workflow to appear…");

  // Give GitHub a moment to register the run
  execSync("sleep 10", { cwd: root });

  try {
    const runs = run(
      `gh run list --repo ${sourceRepo} --workflow "Release App" --limit 1 --json databaseId,headBranch,event -q ".[0].databaseId"`,
      { readOnly: true }
    );
    if (runs) {
      log(`Run ID: ${runs}`);
      run(`gh run watch ${runs} --repo ${sourceRepo} --exit-status`, { inherit: true });
    } else {
      log("Could not find the workflow run. Check the Actions tab manually.");
    }
  } catch {
    log("Workflow watch exited (check status on GitHub).");
  }
}

// ── Summary ─────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(50));
console.log(`  Shipped: ${tag}`);
if (dryRun) {
  console.log("  Mode:    DRY RUN (nothing was pushed)");
}
console.log("─".repeat(50) + "\n");
