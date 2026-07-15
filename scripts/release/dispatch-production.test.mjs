import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

import {
  assertWorkflowSupportsProductionDispatch,
  buildTagHeadMismatchMessage,
  buildWorkflowRunArgs,
  DEFAULT_REPO,
  normalizeReleaseTag,
  parseArgs,
  repoFromRemoteUrl,
  selectDispatchedRun,
  tagFromPackageJson,
  WORKFLOW_FILE,
} from "./dispatch-production.mjs";

test("production release dispatch defaults to non-draft production inputs", () => {
  const options = parseArgs(["--tag", "2026.7.9", "--yes"]);
  const args = buildWorkflowRunArgs({
    ...options,
    tag: normalizeReleaseTag(options.tag),
    ref: normalizeReleaseTag(options.tag),
    repo: DEFAULT_REPO,
  });

  assert.deepEqual(args.slice(0, 7), [
    "workflow",
    "run",
    WORKFLOW_FILE,
    "--repo",
    DEFAULT_REPO,
    "--ref",
    "v2026.7.9",
  ]);
  assert.deepEqual(args.filter((arg) => arg.startsWith("draft=")), ["draft=false"]);
  assert.deepEqual(args.filter((arg) => arg.startsWith("prerelease=")), ["prerelease=false"]);
  assert.deepEqual(args.filter((arg) => arg.startsWith("build_tauri=")), ["build_tauri=true"]);
  assert.deepEqual(args.filter((arg) => arg.startsWith("publish_sidecars=")), ["publish_sidecars=true"]);
  assert.deepEqual(args.filter((arg) => arg.startsWith("publish_npm=")), ["publish_npm=true"]);
});

test("production release dispatch supports explicit release knobs", () => {
  const options = parseArgs([
    "--tag=v2026.7.10",
    "--ref",
    "main",
    "--repo",
    "neatechcz/veslo",
    "--release-name",
    "Veslo v2026.7.10",
    "--no-publish-npm",
    "--draft",
    "--watch",
    "--yes",
  ]);
  const args = buildWorkflowRunArgs({ ...options, tag: options.tag, repo: options.repo });

  assert.equal(options.ref, "main");
  assert.equal(options.watch, true);
  assert.deepEqual(args.filter((arg) => arg.startsWith("release_name=")), ["release_name=Veslo v2026.7.10"]);
  assert.deepEqual(args.filter((arg) => arg.startsWith("draft=")), ["draft=true"]);
  assert.deepEqual(args.filter((arg) => arg.startsWith("publish_npm=")), ["publish_npm=false"]);
});

test("repoFromRemoteUrl handles HTTPS and SSH GitHub remotes", () => {
  assert.equal(repoFromRemoteUrl("https://github.com/neatechcz/veslo.git"), "neatechcz/veslo");
  assert.equal(repoFromRemoteUrl("git@github.com:neatechcz/veslo.git"), "neatechcz/veslo");
});

test("tagFromPackageJson derives a release tag from package version", () => {
  assert.equal(tagFromPackageJson(JSON.stringify({ version: "2026.7.9" })), "v2026.7.9");
});

test("release tag guard reports stale tag targets before dispatch", () => {
  assert.equal(
    buildTagHeadMismatchMessage({
      tag: "v2026.7.9",
      tagCommitSha: "349969b718d5879c9e9cb02d6e2d6c8ac82666da",
      headSha: "5a640d2fee0ded85aac69e7c5c373df5580f5498",
    }),
    "Release tag v2026.7.9 points at 349969b718d5, not current HEAD 5a640d2fee0d.",
  );
  assert.equal(
    buildTagHeadMismatchMessage({
      tag: "v2026.7.10",
      tagCommitSha: "5a640d2fee0ded85aac69e7c5c373df5580f5498",
      headSha: "5a640d2fee0ded85aac69e7c5c373df5580f5498",
    }),
    "",
  );
  assert.equal(
    buildTagHeadMismatchMessage({
      tag: "v2026.7.10",
      tagCommitSha: "",
      headSha: "5a640d2fee0ded85aac69e7c5c373df5580f5498",
    }),
    "",
  );
});

test("selectDispatchedRun chooses the matching workflow_dispatch run", () => {
  const selected = selectDispatchedRun(
    [
      {
        databaseId: 1,
        event: "push",
        headSha: "abc",
        createdAt: "2026-07-09T10:00:00Z",
      },
      {
        databaseId: 2,
        event: "workflow_dispatch",
        headSha: "def",
        createdAt: "2026-07-09T10:00:01Z",
      },
      {
        databaseId: 3,
        event: "workflow_dispatch",
        headSha: "abc",
        createdAt: "2026-07-09T10:00:02Z",
      },
    ],
    {
      expectedSha: "abc",
      dispatchedAt: "2026-07-09T10:00:00Z",
    },
  );

  assert.equal(selected?.databaseId, 3);
});

test("release workflow exposes inputs required by production dispatch", () => {
  const workflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/release-macos-aarch64.yml"), "utf8");

  assert.doesNotThrow(() => assertWorkflowSupportsProductionDispatch(workflow));
});

test("release metadata reaches shell through environment variables", () => {
  const workflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/release-macos-aarch64.yml"), "utf8");

  assert.match(workflow, /RELEASE_BODY:\s*\$\{\{ steps\.resolve\.outputs\.release_body \}\}/);
  assert.match(workflow, /RELEASE_NAME:\s*\$\{\{ steps\.resolve\.outputs\.release_name \}\}/);
  assert.match(workflow, /printf '%s\\n' "\$RELEASE_BODY"/);
  assert.match(workflow, /--title "\$RELEASE_NAME"/);
  assert.doesNotMatch(workflow, /printf '%s\\n' "\$\{\{ steps\.resolve\.outputs\.release_body \}\}"/);
  assert.doesNotMatch(workflow, /--title "\$\{\{ steps\.resolve\.outputs\.release_name \}\}"/);
});
