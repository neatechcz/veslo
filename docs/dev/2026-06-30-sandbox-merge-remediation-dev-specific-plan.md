# Sandbox Merge Remediation KISS Causal Implementation Plan

Date: 2026-06-30

done: true
draft_retarget_done: true
scratch_cleanup_done: true
legacy_draft_decision_done: true
admin_contract_done: true
release_gate_done: true
split_hygiene_done: true

Implementation note: this plan was executed as one all-at-once remediation batch
per the current instruction. The slice sections below remain as causal
acceptance history, not as the execution order. Legacy per-workspace draft
adoption was explicitly resolved as "keep ignoring" for this batch, matching the
current docs/tests. Split hygiene means generated graph churn and the dead DEN
`public-admin` shell are removed from the net diff; actual PR splitting was
intentionally not performed in this branch.

This plan is intentionally smaller than the original remediation list. It fixes
causes in dependency order and keeps unrelated product surfaces out of the same
implementation slice.

Only flip a `done: false` line to `done: true` after that slice's acceptance
checks and focused validation have passed. Do not flip the top-level `done`
until all non-deferred slices are implemented or explicitly documented as not
applicable.

## Causal Map

1. Global draft retarget data loss is the first app root cause.
   The app uses one durable `pending-global-unpublished` draft id, but some open
   paths only look for an exact target match. If the global draft exists under a
   different target, the path creates an empty composer and writes it back to the
   same global id. That overwrites valid text/attachments. Fix this before any
   migration or cleanup work.

2. Scratch workspace cleanup depends on successful retarget persistence.
   A private chat target creates a scratch/private workspace. When the same
   global draft is retargeted to a real directory, the old scratch workspace can
   remain registered/on disk. Cleanup must run only after the new target metadata
   and composer body are safely persisted.

3. Legacy per-workspace draft adoption is a product migration decision, not the
   cause of the current retarget data loss.
   Current docs and tests say obsolete per-workspace pending drafts are ignored.
   Do not mix a contract change into the minimal retarget fix unless the product
   decision is to recover those old rows. If adoption is chosen, implement it
   only after the global draft invariant is fixed.

4. DEN admin conflict is caused by real app route ordering, not just the helper
   router.
   The sandbox branch serves `services/den/public-admin/*` from
   `services/den/src/index.ts` before the managed-AI redirect router can enforce
   the canonical AI Gateway admin surface. Tests must cover the mounted app
   behavior or source-route ordering, not only the standalone helper router.

5. GlitchTip release failures are caused by a single hard verifier mode plus
   broad release-review text matching.
   The verifier should be strict only when a release job explicitly requires
   release-owned monitoring. Review checks must be workflow/job-specific so one
   job cannot hide missing wiring in another job.

6. Branch hygiene is last.
   Split only after behavior slices are validated. Do not ship generated graph
   churn or duplicate merge-history artifacts in behavior PRs.

## Slice 1: Preserve The Global Draft Body During Retarget

done: true

Dependency: none. This is the first implementation slice.

Cause:

- Existing valid global drafts can be overwritten with an empty composer when
  opened through another pending target.

Files:

- Modify: `packages/app/src/app/context/pending-session-draft-controller.ts`
- Modify: `packages/app/src/app/tests/context/pending-session-draft-controller.test.ts`
- Modify as needed: `packages/app/src/app/lib/pending-session-drafts.ts`
- Verify existing behavior in:
  - `packages/app/src/app/tests/controllers/pending-draft-startup-controller.test.ts`
  - `packages/app/src/app/tests/lib/pending-session-drafts.test.ts`
  - `packages/app/src/app/tests/pages/session-composer-drafts.test.ts`

Required failing tests before the fix:

- Existing private-chat global draft with text opens as a directory target and
  preserves the same composer body.
- Existing directory global draft with attachments opens as private chat and
  preserves attachment summaries/payloads.
- Existing directory global draft opens as a different directory target and
  preserves text, parts, command, and attachments.
- Same-target reopen keeps the existing body and does not create another scratch
  workspace.
- Missing or invalid loaded global draft still falls back to the existing
  empty-draft path without deleting unrelated legacy rows.

Implementation policy:

- Find `GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID` regardless of its current
  `kind`, `workspaceId`, `directory`, or `privateWorkspaceId`.
- Load that draft before creating a new empty composer.
- If it loads successfully, write the same composer payload back to
  `pending-global-unpublished` with only target metadata and timestamps changed.
- Call `deps.createEmptyComposerDraft()` only when no usable global unpublished
  draft exists.
- Keep real-session composer draft storage unchanged.
- Keep obsolete per-workspace legacy draft behavior unchanged in this slice.

Acceptance:

- No valid global unpublished draft body is overwritten with an empty composer
  during Chat -> directory, directory -> Chat, or directory -> directory
  retargeting.
- Existing first-send snapshot behavior still uses the active target metadata.
- Existing tests that prove real sessions use separate composer storage still
  pass.

Validation:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/context/pending-session-draft-controller.test.ts \
  src/app/tests/controllers/pending-draft-startup-controller.test.ts \
  src/app/tests/lib/pending-session-drafts.test.ts \
  src/app/tests/pages/session-composer-drafts.test.ts

pnpm --filter @neatech/veslo-ui typecheck
git diff --check HEAD
```

## Slice 2: Clean Scratch Workspaces After Successful Retarget

done: true

Dependency: Slice 1 must be done. Cleanup must not run while retarget writes can
still lose the composer body.

Cause:

- Chat targets create scratch/private workspaces.
- Retargeting the global draft to a real directory can leave the old scratch
  workspace visible or persisted locally.

Files:

- Modify: `packages/app/src/app/context/composer-target-controller.ts`
- Modify as needed: `packages/app/src/app/context/pending-session-draft-controller.ts`
- Modify: `packages/app/src/app/tests/context/composer-target-controller.test.ts`
- Modify as needed: `packages/app/src/app/tests/context/pending-session-draft-controller.test.ts`

Required failing tests before the fix:

- Chat target creates a scratch/private workspace for the global draft.
- Switching that same global draft to a directory target calls
  `forgetWorkspace(previousPrivateWorkspaceId, { deleteLocalData: true })`
  only after the new target write succeeds.
- Cleanup is not attempted when the new target write fails.
- Cleanup is not attempted for a real session workspace.
- Cleanup is not attempted when the previous and next target are the same
  private workspace.
- Cleanup failures are reported but do not roll back an already successful
  target switch.

Implementation policy:

- Capture the previous global pending summary before writing the new target.
- After the new global draft target is persisted and UI state is updated, run a
  best-effort cleanup only when:
  - previous summary id is `pending-global-unpublished`,
  - previous summary kind is `new-private`,
  - previous summary has a non-empty `privateWorkspaceId`,
  - next summary is not the same private workspace,
  - Tauri runtime is active.
- Never delete a scratch workspace before retarget persistence succeeds.
- Log/report cleanup failure; do not restore stale target metadata.

Acceptance:

- Chat -> workspace retarget no longer leaves the previous scratch workspace
  registered/on disk.
- Failed retarget never deletes the previous private workspace.
- Existing first-send behavior still clears the active global draft only after
  successful handoff.

Validation:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/context/pending-session-draft-controller.test.ts \
  src/app/tests/context/composer-target-controller.test.ts \
  src/app/tests/pages/session-composer-drafts.test.ts

pnpm --filter @neatech/veslo-ui typecheck
git diff --check HEAD
```

## Slice 3: Decide Legacy Draft Adoption

done: true

Dependency: Slices 1 and 2 must be done if adoption is implemented.

Default KISS decision:

- Do not migrate obsolete per-workspace pending drafts in the same PR as the
  retarget/cleanup fixes.
- Keep the current documented behavior unless the product decision is explicitly
  changed: old per-workspace pending drafts are ignored and not migrated.

Decision paths:

- If the product decision is "keep ignoring legacy drafts":
  - Keep the existing docs/tests that encode this behavior.
  - Mark this slice done with a short note in the implementation summary.
  - Do not add migration logic.
- If the product decision is "adopt one legacy draft":
  - Update docs and tests first to make the contract change explicit.
  - Then implement adoption after the global draft invariant is stable.

Files if adoption is chosen:

- Modify: `packages/app/src/app/context/pending-session-draft-controller.ts`
- Modify: `packages/app/src/app/controllers/pending-draft-startup-controller.ts`
- Modify as needed: `packages/app/src/app/lib/pending-session-drafts.ts`
- Modify: `packages/app/src/app/tests/context/pending-session-draft-controller.test.ts`
- Modify: `packages/app/src/app/tests/controllers/pending-draft-startup-controller.test.ts`
- Modify: `docs/features/session-runtime.md`
- Modify: `docs/dev/state-and-config-reference.md`

Adoption policy if chosen:

- Keep `GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID` as the only active draft id after
  adoption.
- If a stored active pending draft key points to a legacy row, prefer that row.
- Otherwise adopt the newest non-consumed legacy row by `updatedAt`.
- Preserve composer text, parts, command, attachments, and target metadata.
- Write the adopted draft to `pending-global-unpublished`.
- Only after the global write succeeds, mark the adopted legacy id consumed or
  delete it if the persistence API can do so safely.
- Do not silently delete non-adopted legacy rows.
- If adoption fails, leave the legacy row untouched and surface a normal restore
  error.

Acceptance if adoption is chosen:

- Tests clearly distinguish ignored-legacy behavior from adopted-legacy
  behavior.
- Existing global draft behavior still wins when a global draft already exists.
- Non-adopted legacy drafts remain preserved for a later explicit recovery tool.

Validation:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/context/pending-session-draft-controller.test.ts \
  src/app/tests/controllers/pending-draft-startup-controller.test.ts \
  src/app/tests/lib/pending-session-drafts.test.ts

pnpm --filter @neatech/veslo-ui typecheck
git diff --check HEAD
```

## Slice 4: Resolve The DEN Admin Surface

done: true

Dependency: none. This is independent from app draft work.

Default KISS decision:

- Keep the VSLO-201 contract: AI Gateway admin is the managed-AI admin product
  surface. DEN owns auth/org/billing APIs, not a second static admin shell.

Cause:

- `services/den/src/index.ts` currently serves `services/den/public-admin/*`
  from `/admin` before the canonical managed-AI redirect behavior can protect
  the product surface.

Files:

- Modify: `services/den/src/index.ts`
- Modify or add: `services/den/test/admin-managed-ai-ui.test.ts`
- Modify as needed: `services/den/test/admin-contract.test.ts`
- Delete, leave unserved, or move out of this PR:
  - `services/den/public-admin/index.html`
  - `services/den/public-admin/app.js`
  - `services/den/public-admin/app.css`
- Modify docs if they currently instruct future work to build on DEN
  `public-admin`:
  - `docs/plans/2026-06-23-organization-stripe-billing.md`
  - `docs/plans/2026-06-23-organization-stripe-billing-design.md`

Required tests:

- Real mounted DEN app behavior, or a source-route-order guard, proves:
  - `GET /admin` redirects to the configured AI Gateway admin URL.
  - `GET /admin/credentials` redirects to the matching AI Gateway admin path.
  - `GET /admin/app.js` does not serve DEN `public-admin` JavaScript.
  - `/admin/api/*` remains API and does not redirect.
  - `/v1/admin/*` remains API and does not redirect.
- A helper-router-only test is not sufficient by itself.

Implementation policy:

- Remove the DEN static admin shell from the `/admin` product surface.
- Keep DEN admin APIs under `/admin/api` and `/v1/admin` protected by the
  existing admin session requirements.
- If billing UI work is still desired, retarget it to AI Gateway admin or keep
  it on a separate unmerged design branch.

Conditional branch if the product decision changes and DEN shell is kept:

- Update architecture docs in the same PR.
- Gate public-admin browser calls by serialized session capabilities:
  - organization admins must not call `/credentials`, `/sessions`, `/alerts`,
    `/audit`, `/usage`, or `/users/:id/ai-access`;
  - platform admins must still load those managed-AI surfaces;
  - do not globally swallow 403s.
- Fix or remove password-token fallback truncation. Never use
  `set-auth-token.split(".")[0]`.
- Run or document why the integrated Den browser test is unavailable:

```bash
pnpm --filter @neatech/veslo-e2e exec playwright test specs/den-admin-billing-integrated.playwright.spec.ts
```

Acceptance:

- No unauthenticated static DEN admin shell is available from `/admin`.
- DEN admin API paths still work as API paths.
- If a DEN shell is deliberately kept, org-admin sessions do not make
  platform-only managed-AI calls in their happy path.

Validation:

```bash
pnpm --dir services/den exec tsx --test \
  test/admin-contract.test.ts \
  test/admin-managed-ai-ui.test.ts

pnpm --dir services/den exec tsc -p tsconfig.json --noEmit
git diff --check HEAD
```

## Slice 5: Make GlitchTip Strict Only Where Required

done: true

Dependency: none. This is independent from app draft and DEN work.

Cause:

- `scripts/release/verify-glitchtip-release-env.mjs` currently hard-fails when
  DSN/env values are missing.
- `scripts/release/review.mjs` checks broad workflow text, so one job can hide a
  missing GlitchTip block in another job.
- `.github/workflows/prerelease.yml` publishes installable desktop artifacts but
  lacks the same GlitchTip env/verify parity as normal release jobs.

Files:

- Modify: `scripts/release/verify-glitchtip-release-env.mjs`
- Modify: `scripts/release/review.mjs`
- Modify: `scripts/release/review.test.mjs`
- Modify: `.github/workflows/release-macos-aarch64.yml`
- Modify: `.github/workflows/prerelease.yml`
- Modify as needed: `.github/workflows/build-desktop.yml`
- Modify as needed: `.github/workflows/build-windows-msi.yml`
- Modify: `RELEASE.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/dev/veslo-application-logs.md`

Implementation policy:

- Add an explicit strict flag, for example
  `VESLO_REQUIRE_GLITCHTIP_RELEASE_ENV=1`.
- Strict mode:
  - missing DSN/env values fail;
  - malformed DSN fails;
  - frontend/native DSN and environment parity must hold.
- Non-strict mode:
  - missing DSN warns and exits zero;
  - malformed DSN still fails if any DSN is provided.
- Production release jobs must set strict mode.
- Prerelease desktop jobs that publish installable artifacts through
  `release-signing` must use the same DSN/env wiring and verification step as
  normal release jobs.
- Manual validation/build workflows should use warning mode unless they are
  intentionally producing release-owned artifacts.
- Replace broad workflow-text checks with job-specific or workflow-specific
  checks. Removing env wiring from only macOS release, only Windows release, or
  only prerelease must fail review independently.

Acceptance:

- Missing GlitchTip vars cannot unexpectedly break non-release build validation.
- Production release workflows fail closed when monitoring is required.
- Prerelease workflow has the same release-monitoring contract as normal
  desktop release workflows.
- `release:review` cannot false-green because a different job still contains
  the expected GlitchTip text.

Validation:

```powershell
node --test scripts/release/review.test.mjs
node scripts/release/review.mjs --json

$env:VESLO_GLITCHTIP_DSN=$null
$env:VITE_VESLO_GLITCHTIP_DSN=$null
$env:VESLO_GLITCHTIP_ENVIRONMENT=$null
$env:VITE_VESLO_GLITCHTIP_ENVIRONMENT=$null
$env:VESLO_REQUIRE_GLITCHTIP_RELEASE_ENV=$null
node scripts/release/verify-glitchtip-release-env.mjs

$env:VESLO_REQUIRE_GLITCHTIP_RELEASE_ENV='1'
node scripts/release/verify-glitchtip-release-env.mjs

git diff --check HEAD
```

Expected:

- Non-strict run without DSN exits zero with a warning.
- Strict run without DSN exits nonzero.

## Slice 6: Split Before Main

done: true

Dependency: relevant behavior slices must pass their focused validation first.

Cause:

- `local/sandbox-merge` mixes unrelated behavior, docs, release wiring,
  generated graph output, updater work, and merge-history artifacts.

Implementation policy:

- Keep `origin/pr-5` existing-session runtime recovery as a small app-only PR if
  the final diff remains clean.
- Keep global draft retarget and scratch cleanup as one focused app PR.
- Keep legacy draft adoption out of that PR unless Slice 3 explicitly chooses
  adoption.
- Keep DEN admin surface resolution as its own PR.
- Keep GlitchTip release gating as its own PR.
- Keep updater relaunch as its own PR unless it is already independently
  reviewed.
- Do not include `graphify-out/*` in behavior PRs. If graph refresh is needed,
  ship it as a graph-only PR.
- Squash or rewrite duplicate `origin/pr-5` merge-history artifacts before
  opening a main-bound PR.

Acceptance:

- Each PR has a focused diff and a focused validation section.
- `git diff --stat` for each behavior PR is reviewable without generated graph
  output dominating the diff.
- No generated graph churn ships with behavior changes.

Final verification matrix for the split PRs:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/context/send-runtime-readiness.test.ts \
  src/app/tests/context/pending-session-draft-controller.test.ts \
  src/app/tests/context/composer-target-controller.test.ts \
  src/app/tests/controllers/pending-draft-startup-controller.test.ts \
  src/app/tests/context/updater.test.ts \
  src/app/tests/system-state-updater-retry.test.ts \
  src/app/tests/lib/error-monitoring.test.ts

pnpm --filter @neatech/veslo-ui typecheck
pnpm --dir services/den exec tsx --test test/admin-contract.test.ts test/admin-managed-ai-ui.test.ts
pnpm --dir services/den exec tsc -p tsconfig.json --noEmit
node --test scripts/release/review.test.mjs
node scripts/release/review.mjs --json
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml updater::tests --quiet
git diff --check HEAD
```

Manual/desktop checks before shipping affected PRs:

- Verify global unpublished composer text and attachments survive Chat <->
  directory retargeting.
- Verify switching Chat -> workspace does not leave a visible private workspace
  row or stale scratch workspace.
- If legacy adoption is chosen, upgrade from a build containing legacy
  per-workspace pending drafts and verify one unsent draft is adopted.
- Verify existing-session send recovery from `engine_not_running`.
- Verify production and prerelease release job behavior in strict GlitchTip mode.

## Done Criteria

done: true

The plan is complete only when:

- Slice 1 is done and verified.
- Slice 2 is done and verified.
- Slice 3 is either explicitly deferred with current docs/tests intact, or
  implemented and verified after a product decision to adopt legacy drafts.
- DEN admin contract conflict is resolved in code, tests, and docs.
- GlitchTip verification has explicit strict/warning behavior and job-specific
  review coverage.
- Main-bound changes are split into focused PRs without generated graph churn.
- All relevant validation commands pass, or any skipped gate is documented with
  a concrete reason.
