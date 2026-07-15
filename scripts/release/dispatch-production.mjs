#!/usr/bin/env node
/**
 * Dispatch the production GitHub Actions release workflow.
 *
 * This intentionally uses workflow_dispatch instead of relying on a tag push,
 * because the Release App workflow treats tag-push releases as drafts. The
 * production path must explicitly send draft=false and prerelease=false.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WORKFLOW_FILE = "release-macos-aarch64.yml";
export const WORKFLOW_NAME = "Release App";
export const DEFAULT_REPO = "neatechcz/veslo";
export const RELEASE_TAG_PATTERN = /^v\d{4}\.(?:0?[1-9]|1[0-2])\.\d+(?:[.-][0-9A-Za-z.-]+)?$/;

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const usage = `Usage:
  node scripts/release/dispatch-production.mjs --yes --push-tag --watch
  node scripts/release/dispatch-production.mjs --tag vYYYY.M.P --yes [--watch]

Options:
  --tag <tag>              Release tag. Defaults to the exact tag on HEAD.
                           If HEAD is untagged, falls back to packages/app version for diagnostics.
  --ref <ref>              Workflow ref to dispatch. Defaults to the release tag.
  --repo <owner/name>      GitHub repository. Defaults to origin or ${DEFAULT_REPO}.
  --release-name <name>    Optional release title.
  --release-body <text>    Optional release notes body.
  --release-body-file <p>  Read release notes body from a file.
  --no-build-tauri         Dispatch without desktop artifact builds.
  --no-publish-sidecars    Dispatch without sidecar asset publishing.
  --no-publish-npm         Dispatch without npm publishing.
  --draft                  Create/update the source GitHub release as draft.
  --prerelease             Mark the source GitHub release as prerelease.
  --push-tag               Push the local release tag before dispatching.
  --skip-review            Do not run scripts/release/review.mjs --strict locally.
  --allow-dirty            Allow dispatch from a dirty working tree.
  --allow-non-head-tag     Allow dispatch when the tag is not the exact HEAD tag.
  --watch                  Watch the dispatched run with gh run watch --exit-status.
  --dry-run                Print commands without mutating GitHub.
  --yes                    Required for a real production dispatch.
`;

const fail = (message) => {
  throw new Error(message);
};

export function normalizeReleaseTag(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.startsWith("v") ? raw : `v${raw}`;
}

export function validateReleaseTag(tag) {
  if (!RELEASE_TAG_PATTERN.test(tag)) {
    fail(`Invalid release tag '${tag}'. Expected CalVer tag vYYYY.M.P.`);
  }
  return tag;
}

export function tagFromPackageJson(packageJsonText) {
  const data = JSON.parse(packageJsonText);
  return normalizeReleaseTag(data?.version ?? "");
}

export function shortSha(value) {
  return String(value ?? "").trim().slice(0, 12);
}

export function buildTagHeadMismatchMessage(input) {
  const tag = String(input?.tag ?? "").trim();
  const tagCommitSha = String(input?.tagCommitSha ?? "").trim();
  const headSha = String(input?.headSha ?? "").trim();
  if (!tag || !tagCommitSha || !headSha || tagCommitSha === headSha) return "";
  return `Release tag ${tag} points at ${shortSha(tagCommitSha)}, not current HEAD ${shortSha(headSha)}.`;
}

export function repoFromRemoteUrl(remoteUrl) {
  const value = String(remoteUrl ?? "").trim();
  const match = value.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  return match ? match[1] : "";
}

const nextArg = (argv, index, name) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
};

export function parseArgs(argv) {
  const options = {
    tag: "",
    ref: "",
    repo: "",
    releaseName: "",
    releaseBody: "",
    releaseBodyFile: "",
    buildTauri: true,
    publishSidecars: true,
    publishNpm: true,
    draft: false,
    prerelease: false,
    pushTag: false,
    review: true,
    allowDirty: false,
    allowNonHeadTag: false,
    watch: false,
    dryRun: false,
    yes: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const readValue = () => inlineValue ?? nextArg(argv, index++, name);

    switch (name) {
      case "--tag":
        options.tag = readValue();
        break;
      case "--ref":
        options.ref = readValue();
        break;
      case "--repo":
        options.repo = readValue();
        break;
      case "--release-name":
        options.releaseName = readValue();
        break;
      case "--release-body":
        options.releaseBody = readValue();
        break;
      case "--release-body-file":
        options.releaseBodyFile = readValue();
        break;
      case "--no-build-tauri":
        options.buildTauri = false;
        break;
      case "--no-publish-sidecars":
        options.publishSidecars = false;
        break;
      case "--no-publish-npm":
        options.publishNpm = false;
        break;
      case "--draft":
        options.draft = true;
        break;
      case "--prerelease":
        options.prerelease = true;
        break;
      case "--push-tag":
        options.pushTag = true;
        break;
      case "--skip-review":
        options.review = false;
        break;
      case "--allow-dirty":
        options.allowDirty = true;
        break;
      case "--allow-non-head-tag":
        options.allowNonHeadTag = true;
        break;
      case "--watch":
        options.watch = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export function buildWorkflowRunArgs(input) {
  const fields = [
    ["tag", input.tag],
    ["draft", String(input.draft)],
    ["prerelease", String(input.prerelease)],
    ["build_tauri", String(input.buildTauri)],
    ["publish_sidecars", String(input.publishSidecars)],
    ["publish_npm", String(input.publishNpm)],
  ];
  if (input.releaseName) fields.push(["release_name", input.releaseName]);
  if (input.releaseBody) fields.push(["release_body", input.releaseBody]);

  return [
    "workflow",
    "run",
    WORKFLOW_FILE,
    "--repo",
    input.repo,
    "--ref",
    input.ref,
    ...fields.flatMap(([key, value]) => ["--raw-field", `${key}=${value}`]),
  ];
}

export function buildRunListArgs(repo) {
  return [
    "run",
    "list",
    "--repo",
    repo,
    "--workflow",
    WORKFLOW_NAME,
    "--limit",
    "20",
    "--json",
    "databaseId,createdAt,event,headBranch,headSha,status,url,displayTitle",
  ];
}

export function selectDispatchedRun(runs, input) {
  const candidates = Array.isArray(runs) ? runs : [];
  const since = input.dispatchedAt ? Date.parse(input.dispatchedAt) - 30_000 : 0;
  return candidates.find((run) => {
    if (run?.event !== "workflow_dispatch") return false;
    if (input.expectedSha && run.headSha && run.headSha !== input.expectedSha) return false;
    if (since && Date.parse(run.createdAt ?? "") < since) return false;
    return true;
  }) ?? null;
}

export function assertWorkflowSupportsProductionDispatch(workflowText) {
  for (const required of [
    "workflow_dispatch:",
    "tag:",
    "draft:",
    "prerelease:",
    "build_tauri:",
    "publish_sidecars:",
    "publish_npm:",
  ]) {
    if (!workflowText.includes(required)) {
      fail(`Release workflow is missing workflow_dispatch input '${required.replace(":", "")}'.`);
    }
  }
}

const commandText = (command, args) => [command, ...args].map((part) => {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(part)) return part;
  return JSON.stringify(part);
}).join(" ");

function runCommand(command, args, options = {}) {
  const { cwd = root, dryRun = false, inherit = false, allowFail = false } = options;
  if (dryRun) {
    console.log(`  [dry-run] ${commandText(command, args)}`);
    return "";
  }
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (result.status !== 0) {
    if (allowFail) return "";
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    fail(`Command failed: ${commandText(command, args)}\n${detail}`);
  }
  return result.stdout?.trim() ?? "";
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitForWorkflowRun(input) {
  const startedAt = Date.now();
  const timeoutMs = 60_000;
  while (Date.now() - startedAt < timeoutMs) {
    const output = runCommand("gh", buildRunListArgs(input.repo), { cwd: root });
    const runs = JSON.parse(output || "[]");
    const run = selectDispatchedRun(runs, input);
    if (run) return run;
    await sleep(5_000);
  }
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  if (!options.dryRun && !options.yes) {
    fail("Refusing to dispatch a production release without --yes. Use --dry-run to preview.");
  }

  const workflowPath = resolve(root, ".github", "workflows", WORKFLOW_FILE);
  assertWorkflowSupportsProductionDispatch(readFileSync(workflowPath, "utf8"));

  const remoteRepo =
    repoFromRemoteUrl(runCommand("git", ["remote", "get-url", "origin"], { cwd: root, allowFail: true })) ||
    DEFAULT_REPO;
  const repo = options.repo || remoteRepo;
  const exactHeadTag = runCommand("git", ["describe", "--tags", "--exact-match", "HEAD"], {
    cwd: root,
    allowFail: true,
  });
  const packageVersionTag = options.tag || exactHeadTag
    ? ""
    : tagFromPackageJson(readFileSync(resolve(root, "packages", "app", "package.json"), "utf8"));
  const tag = validateReleaseTag(normalizeReleaseTag(options.tag || exactHeadTag || packageVersionTag));
  const ref = options.ref || tag;
  const expectedSha = runCommand("git", ["rev-parse", `${tag}^{commit}`], { cwd: root, allowFail: true });
  const headSha = runCommand("git", ["rev-parse", "HEAD"], { cwd: root, allowFail: true });
  const tagHeadMismatch = buildTagHeadMismatchMessage({ tag, tagCommitSha: expectedSha, headSha });

  if (tagHeadMismatch && !options.allowNonHeadTag) {
    fail(`${tagHeadMismatch} Create a fresh release tag on HEAD, or pass --allow-non-head-tag only when dispatching older code intentionally.`);
  }

  if (!options.allowNonHeadTag && exactHeadTag !== tag) {
    const detail = exactHeadTag
      ? `HEAD is tagged as ${exactHeadTag}, not ${tag}.`
      : `HEAD is not tagged as ${tag}. Run 'pnpm release:prepare' first, or create 'git tag ${tag}' after committing the version bump.`;
    fail(`${detail} Use --allow-non-head-tag only when dispatching an existing remote tag intentionally.`);
  }

  if (options.pushTag && !expectedSha && !options.dryRun) {
    fail(`Local tag ${tag} does not exist, so it cannot be pushed.`);
  }

  const dirty = runCommand("git", ["status", "--porcelain"], { cwd: root, allowFail: true });
  if (dirty && !options.allowDirty) {
    fail(`Working tree is dirty. Commit/stash first or pass --allow-dirty.\n${dirty}`);
  }

  if (options.releaseBodyFile) {
    const bodyPath = resolve(root, options.releaseBodyFile);
    if (!existsSync(bodyPath)) fail(`Release body file does not exist: ${options.releaseBodyFile}`);
    options.releaseBody = readFileSync(bodyPath, "utf8");
  }

  console.log(`\nProduction release dispatch`);
  console.log(`  repo: ${repo}`);
  console.log(`  workflow: ${WORKFLOW_FILE}`);
  console.log(`  tag: ${tag}`);
  console.log(`  ref: ${ref}`);
  console.log(`  head: ${shortSha(headSha) || "(unknown)"}`);
  console.log(`  tag commit: ${shortSha(expectedSha) || "(unavailable locally)"}`);
  console.log(`  draft: ${String(options.draft)}`);
  console.log(`  prerelease: ${String(options.prerelease)}`);
  console.log(`  build_tauri: ${String(options.buildTauri)}`);
  console.log(`  publish_sidecars: ${String(options.publishSidecars)}`);
  console.log(`  publish_npm: ${String(options.publishNpm)}`);
  if (tagHeadMismatch) {
    console.log(`  warning: ${tagHeadMismatch} Dispatch will run the tag commit.`);
  }

  runCommand("gh", ["--version"], { cwd: root, dryRun: options.dryRun });
  runCommand("gh", ["auth", "status"], { cwd: root, dryRun: options.dryRun });

  if (options.review) {
    runCommand("node", ["scripts/release/review.mjs", "--strict"], {
      cwd: root,
      dryRun: options.dryRun,
      inherit: true,
    });
  }

  if (options.pushTag) {
    runCommand("git", ["push", "origin", tag], { cwd: root, dryRun: options.dryRun, inherit: true });
  } else {
    const remoteTag = runCommand("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], {
      cwd: root,
      dryRun: options.dryRun,
      allowFail: true,
    });
    if (!remoteTag && !options.dryRun) {
      fail(`Remote tag ${tag} was not found on origin. Push it first or pass --push-tag.`);
    }
  }

  const dispatchInput = {
    ...options,
    tag,
    ref,
    repo,
  };
  const dispatchArgs = buildWorkflowRunArgs(dispatchInput);
  const dispatchedAt = new Date().toISOString();
  runCommand("gh", dispatchArgs, { cwd: root, dryRun: options.dryRun, inherit: true });

  console.log(`\nWorkflow: https://github.com/${repo}/actions/workflows/${WORKFLOW_FILE}`);
  console.log(`Release:  https://github.com/${repo}/releases/tag/${tag}`);

  if (options.watch && !options.dryRun) {
    const run = await waitForWorkflowRun({ repo, expectedSha, dispatchedAt });
    if (!run) {
      console.log("Could not resolve the dispatched workflow run. Check the Actions tab manually.");
      return;
    }
    console.log(`Run:      ${run.url}`);
    runCommand("gh", ["run", "watch", String(run.databaseId), "--repo", repo, "--exit-status"], {
      cwd: root,
      inherit: true,
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
