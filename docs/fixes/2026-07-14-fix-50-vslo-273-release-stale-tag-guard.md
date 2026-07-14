# Fix 50: VSLO-273 Release Stale-Tag Guard

Date: 2026-07-14

## Scope

Records the VSLO-273 follow-up work in `veslo-main` after auditing the
original `v2026.7.9` showstopper report against current `origin/main`.

The original VSLO-273 findings covered session runtime reconciliation, E2E
macOS app-data seeding, macOS release sidecar configuration, and annotated tag
handling in the release workflow. Current `main` already contains the code
direction for those original defects. This checkpoint records the remaining
release-safety fix: preventing a production dispatch from silently reusing the
stale `v2026.7.9` tag that still points at the old release commit.

## Problem

The current code on `main` is ahead of the `v2026.7.9` release tag:

- current `HEAD`: `5a640d2fee0ded85aac69e7c5c373df5580f5498`;
- `v2026.7.9^{commit}`: `349969b718d5879c9e9cb02d6e2d6c8ac82666da`.

That means a rerun of `v2026.7.9` would execute the old release commit, not the
fixed code on `main`. The existing dispatch script had an exact-HEAD-tag guard,
but its failure mode did not make the peeled tag commit visible enough for this
specific stale-tag hazard.

There was also a Windows-only test hygiene issue in the bundled Node runtime
test: it asserted POSIX executable bits even though Windows filesystems may not
preserve that mode bit.

## Fix

- `scripts/release/dispatch-production.mjs` now computes both `HEAD` and
  `${tag}^{commit}` before dispatch.
- The dispatch script fails closed when the release tag points at a different
  commit than `HEAD`, unless `--allow-non-head-tag` is passed explicitly.
- The production release summary now prints both short SHAs:
  `head` and `tag commit`.
- If `--allow-non-head-tag` is used, the script still prints a warning that the
  workflow will run the tag commit.
- `packages/desktop/scripts/bundled-node-runtime.test.mjs` still verifies that
  bundled Node copies are regular files and not symlinks, but only asserts
  POSIX executable bits on non-Windows hosts.
- `scripts/release/dispatch-production.test.mjs` covers the stale-tag message
  and the no-op cases.

## KISS Boundary

- No release workflow behavior was changed.
- No release was dispatched and no tag was moved.
- No attempt was made to rerun `v2026.7.9`; the correct release path is a new
  tag from current `main`.
- No E2E helper or `services/ai-gateway` worktree changes are part of this
  checkpoint.
- No rollback to legacy app-side transcript ingest was made.

## Verification

Run on 2026-07-14:

```powershell
node --test packages/desktop/scripts/bundled-node-runtime.test.mjs
# 6 passed, 0 failed

node --test scripts/release/dispatch-production.test.mjs scripts/release/release-platforms.test.mjs packages/desktop/scripts/tauri-config.test.mjs scripts/release/verify-bundled-versions.test.mjs
# 34 passed, 0 failed

node scripts/release/dispatch-production.mjs --tag v2026.7.9 --dry-run --yes
# expected exit 1:
# Release tag v2026.7.9 points at 349969b718d5, not current HEAD 5a640d2fee0d.

node scripts/release/dispatch-production.mjs --tag v2026.7.9 --dry-run --yes --allow-non-head-tag --allow-dirty --skip-review
# exit 0; dry-run prints head/tag commit and warns that dispatch would run the tag commit

node scripts/release/dispatch-production.mjs --dry-run --yes --allow-dirty --skip-review
# expected exit 1; default package-derived v2026.7.9 is stale against HEAD

git diff --check -- packages/desktop/scripts/bundled-node-runtime.test.mjs scripts/release/dispatch-production.mjs scripts/release/dispatch-production.test.mjs
# exit 0
```

## Status

The stale-tag guard and Windows test hygiene fix are implemented and covered by
focused automated tests.

VSLO-273 is not release-closed by this checkpoint. The current worktree is
dirty with unrelated `services/ai-gateway` and docs changes, and
`release:prepare` would stage broadly. The remaining release step is to run the
normal release preparation from a clean, committed state and create a fresh tag
from current `main` instead of rerunning `v2026.7.9`.
