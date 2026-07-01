---
title: Giltar PR KISS Follow-Up Implementation Plan
date: 2026-06-30
status: draft
done: false
source_audit: PR #8 and current local follow-up changes after fbd0756b
---

# Giltar PR KISS Follow-Up Implementation Plan

## Goal

Close the three real behavioral gaps found during the deep audit of the newest Giltar-sourced
changes, plus the one merge-hygiene gap that still makes the sandbox branch hard to review,
without turning the fixes into a redesign:

1. Preserve the one global unpublished composer body when switching between chat and directory
   pending targets.
2. Stop organization-admin Den sessions from calling platform-only managed-AI admin endpoints.
3. Make prerelease desktop builds follow the same GlitchTip release-monitoring contract as normal
   desktop releases, and make release review catch workflow-specific regressions.
4. Keep generated `graphify-out/` output out of the product merge unless it is intentionally split
   into a generated-output commit.

The target is a small, sufficient fix set: code, focused tests, and docs/release guards where the
contract is release or product-facing.

## KISS Boundaries

Do:

- Keep the global unpublished draft model. Do not bring back per-workspace unpublished composer
  buckets or target-conflict prompts.
- Gate Den admin data loading from the existing admin session capabilities and allowed pages.
- Hide or clearly disable Den billing actions that do not have real server routes yet.
- Reuse the existing GlitchTip env names and `verify-glitchtip-release-env.mjs` script.
- Treat strict GlitchTip verification as an intentional release-artifact contract, not an
  accidental local failure.
- Add tests that would fail for the exact audited bugs.
- Keep each slice independently reviewable.

Do not:

- Redesign pending-draft persistence.
- Add a second Den admin app, server-side page router, or broad role framework.
- Add a new release-monitoring service or make GlitchTip user-configurable.
- Hide 403s by globally ignoring errors in the admin UI.
- Leave generated `graphify-out/` changes mixed into code, workflow, or UI fixes.
- Mark this plan complete from unit tests alone when an affected path has an e2e/contract surface.

## Current Evidence To Recheck Before Editing

Run this quick audit pass before implementation, because this area has changed quickly:

```bash
git status --short
git diff --stat fbd0756b40f041fe577ba2d7ee57b1d104d78cc3..HEAD -- . ':!graphify-out/**'
git diff --numstat fbd0756b40f041fe577ba2d7ee57b1d104d78cc3..HEAD -- graphify-out
rg -n "GLOBAL_UNPUBLISHED|openNewSessionWithDirectory|openDirectoryPendingDraft|createEmptyComposerDraft" packages/app/src/app/context packages/app/src/app/tests
rg -n "loadAllData|loadUserAiAccess|allowedPages|capabilities|requirePlatformAdminSnapshot" services/den/src/http services/den/public-admin packages/e2e/specs
rg -n "GLITCHTIP|hasGlitchTipReleaseEnv|tauri-action|prerelease" .github/workflows scripts/release docs/dev RELEASE.md
```

Expected baseline before the fix:

- `openNewSessionWithDirectory()` creates an empty composer when the global draft exists for a
  directory target.
- `openDirectoryPendingDraft()` creates an empty composer when the global draft exists for a
  different target.
- `loadAllData()` always calls platform managed-AI endpoints after login, even for organization
  admins.
- `loadUsers()` and user selection always try `/users/:id/ai-access` when editing a user.
- `.github/workflows/prerelease.yml` lacks the GlitchTip env wiring and verify step used by release
  builds.
- `scripts/release/review.mjs` checks whole workflow text for release GlitchTip env instead of the
  concrete build job or prerelease workflow.
- `graphify-out/graph.json` and adjacent generated files dominate the diff if they are still mixed
  into this branch.

If any baseline has already changed, update the affected task below before editing code.

## Task 1: Preserve The Global Unpublished Composer Body

### Files

- Modify: `packages/app/src/app/context/pending-session-draft-controller.ts`
- Modify: `packages/app/src/app/tests/context/pending-session-draft-controller.test.ts`
- Possibly modify: `packages/app/src/app/lib/pending-session-drafts.ts` only if a small helper keeps
  the controller clearer

### Contract

`docs/features/session-runtime.md` says unpublished pending drafts use one app-wide draft body.
Switching between `Chat`, project `+`, and the target picker must keep the current text and
attachments. The active target metadata may change; the composer body must not be reset unless no
global unpublished draft exists.

### Implementation Shape

Add a tiny controller-local helper instead of a new persistence layer:

- List global pending draft summaries with the existing `listGlobalPendingDraftSummaries()`.
- Find the single `GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID` summary, regardless of kind/target.
- Load that draft when present.
- When the requested target differs:
  - write the same `composer` back under `GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID`,
  - update only `kind`, `workspaceId`, `directory`, `privateWorkspaceId`, and timestamps,
  - then open the new pending draft key with the preserved composer.
- When switching from a private-chat draft to a directory target:
  - remember the previous `privateWorkspaceId`,
  - persist and open the directory-target draft first,
  - then best-effort forget the old scratch workspace with `deleteLocalData: true`,
  - never delete the scratch workspace before the preserved composer is safely written.
- When switching from a directory target to private chat:
  - create and activate the new scratch/private workspace,
  - write the preserved composer under the global draft id with `kind: "new-private"`,
  - only fall back to `createEmptyComposerDraft()` if the global draft cannot be loaded.
- Keep the current "reopen if target already matches" behavior.
- Create `deps.createEmptyComposerDraft()` only when there is no usable global unpublished draft.

Do not migrate obsolete per-workspace draft ids. The existing product decision is to ignore them.

### Required Tests

Add focused tests before or with the fix:

- Directory pending draft with text switches to a different directory and preserves text.
- Directory pending draft with an attachment entry switches to private chat and preserves
  attachments.
- Private chat draft with text switches to a directory target and preserves text.
- Private chat draft switching to a directory target cleans up the previous scratch workspace only
  after the preserved draft has been written.
- Scratch cleanup failure is reported but does not reset or delete the preserved composer body.
- Existing same-target reopen still does not create another scratch workspace.
- Invalid or missing loaded global draft still falls back to the existing cleanup/empty-draft path.

The current test named `pending draft controller updates one global draft record for directory
targets` is not sufficient because it only checks ids and target metadata. Extend it or add separate
tests that assert `composer.text` and `composer.attachments`.

### Focused Verification

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/pending-session-draft-controller.test.ts src/app/tests/context/composer-target-controller.test.ts src/app/tests/lib/pending-session-drafts.test.ts src/app/tests/pages/session-composer-drafts.test.ts
```

Acceptance:

- All focused tests pass.
- There is no path in the two open functions where an existing valid global draft is overwritten
  with `createEmptyComposerDraft()`.
- A private scratch workspace is not leaked during private-to-directory switching unless cleanup
  explicitly fails and is reported.

## Task 2: Gate Den Admin Loading By Session Capabilities

### Files

- Modify: `services/den/public-admin/app.js`
- Modify: `packages/e2e/specs/den-admin-billing-integrated.playwright.spec.ts`
- Modify or add: a small Den public-admin source/contract test if one already exists for static UI
  behavior
- Keep server routes unchanged unless the audit reveals an endpoint is meant to become
  organization-admin accessible

### Contract

Organization admins are allowed to use organization, users, and billing pages. They are not platform
managed-AI admins. The browser UI should not call platform-only endpoints as part of a normal
organization-admin login or page switch.

### Implementation Shape

Add small capability/page helpers near the session chrome logic:

```js
function sessionAllowsPage(page) {
  const pages = Array.isArray(state.session?.allowedPages) ? state.session.allowedPages : [];
  return pages.includes(page);
}

function sessionHasCapability(capability) {
  const capabilities = Array.isArray(state.session?.capabilities) ? state.session.capabilities : [];
  return capabilities.includes(capability);
}

function isPlatformAdminSession() {
  return state.session?.platformAdmin === true;
}
```

Use them in a split loader:

- `loadAllData()` should always load only allowed organization/admin basics:
  - `loadUsers()` when `users` is allowed.
  - billing rendering from the session/billing state that is already available.
- Only platform admins should call:
  - `loadCredentials()`
  - `loadSessions()`
  - `loadAlerts()`
  - `loadAudit()`
  - `loadUsage()`
  - `loadUserAiAccess()`
  - `saveUserAiAccess()`
  - AI-access refresh handlers and user-card click AI-access refreshes.
- For org admins, clear platform-only arrays to empty and render stable empty states instead of
  leaving stale platform data from a previous login.
- Keep route normalization: if an org admin lands on `/admin/billing/platform`, show organization
  billing and keep the platform billing toggle disabled.
- Treat billing actions separately from page visibility:
  - if the action has no real server route yet, hide it or render it disabled with explicit
    unavailable copy,
  - do not leave `Update licenses`, `Open Stripe portal`, `Sync Stripe state`, `Stop renewal`,
    `Revoke access now`, or `Download invoices` as enabled no-op controls,
  - platform-only billing controls must remain hidden for organization admins.

Do not globally swallow 403s. A forbidden call from an org-admin happy path should still be treated
as a bug because it means the UI called the wrong endpoint.

### Required Tests

Strengthen the integrated Playwright test or add an equivalent static public-admin test:

- Organization admin sign-in produces no console errors after filtering only known optional 501s.
- Organization admin visiting `/admin/billing/platform` ends on organization-scoped billing.
- Organization admin can open Users without triggering `/users/:id/ai-access`.
- Organization admin billing view has no enabled fake billing action buttons.
- Platform admin still loads credentials, sessions, alerts, audit, usage, and user AI access.
- Platform billing action buttons are either backed by a real route handler or visibly disabled as
  unavailable; they must not be silent no-ops.

If a static unit test is easier than a full browser run for request gating, mock `fetch` and assert
the exact `/admin/api/...` paths after `bootstrapSession()` for:

- org admin: no `/credentials`, `/sessions`, `/alerts`, `/audit`, `/usage`, or `/users/*/ai-access`.
- platform admin: those calls still occur.

### Focused Verification

```bash
pnpm --filter @neatech/den exec tsx --test test/admin-contract.test.ts
pnpm --filter @neatech/den build
```

Run the integrated e2e when a seeded local Den backend is available:

```bash
pnpm --filter @neatech/veslo-e2e exec playwright test specs/den-admin-billing-integrated.playwright.spec.ts
```

Acceptance:

- Org-admin happy path has no 403 console noise.
- Platform-admin managed-AI pages still work.
- Billing UI does not present nonfunctional actions as available production controls.
- No server authorization is weakened to make the UI pass.

## Task 3: Add Prerelease GlitchTip Parity And Job-Specific Release Review

### Files

- Modify: `.github/workflows/prerelease.yml`
- Modify: `scripts/release/review.mjs`
- Modify: `scripts/release/review.test.mjs`
- Possibly modify: `docs/plans/2026-06-28-glitchtip-release-integration.md` or `RELEASE.md` only if
  wording currently implies normal releases but not prereleases

### Contract

GitHub-built macOS and Windows desktop artifacts should embed the public, release-owned GlitchTip DSN
for frontend and native monitoring. That includes prerelease artifacts, because they are installable
desktop release artifacts built by the same release-signing environment.

### Implementation Shape

In `.github/workflows/prerelease.yml`:

- Add the same job-level env used by the normal release jobs:
  - `VESLO_GLITCHTIP_DSN`
  - `VITE_VESLO_GLITCHTIP_DSN`
  - `VESLO_GLITCHTIP_ENVIRONMENT`
  - `VITE_VESLO_GLITCHTIP_ENVIRONMENT`
  - `VESLO_GLITCHTIP_TRACES_SAMPLE_RATE`
  - `VITE_VESLO_GLITCHTIP_TRACES_SAMPLE_RATE`
- Add the existing `Verify GlitchTip release monitoring env` step before any Tauri build/upload
  step in the `publish-tauri` job.
- Keep the same public-variable validation behavior as normal release builds.

In `scripts/release/review.mjs`:

- Replace the broad `hasGlitchTipReleaseEnv(workflowText)` usage with a helper that checks a named
  job block or a specific workflow text section.
- Add a separate check for prerelease desktop builds.
- Keep the manual Windows MSI checks.
- In `.github/workflows/release-macos-aarch64.yml`, validate the normal release jobs separately:
  - `publish-tauri` for macOS,
  - `publish-tauri-windows` for Windows MSI.
- Ensure the Windows release job check can fail independently from the macOS release job check.
- Keep the verifier strict for release/prerelease artifacts. A local
  `verify-glitchtip-release-env.mjs` failure without env values is expected unless the caller
  provides release-signing variables.

In `scripts/release/review.test.mjs`:

- Require labels for macOS release, Windows release, manual Windows MSI, prerelease, and docs.
- Add regression-style source assertions or fixture tests so removing env from only one of these
  fails review:
  - normal macOS `publish-tauri`,
  - normal Windows `publish-tauri-windows`,
  - prerelease matrix `publish-tauri`,
  - manual Windows MSI workflows.

Do not add a second validation script. Reuse `scripts/release/verify-glitchtip-release-env.mjs`.

### Focused Verification

```bash
node --test scripts/release/review.test.mjs
node scripts/release/review.mjs --json
pnpm release:review --strict
```

Acceptance:

- Prerelease workflow has the same GlitchTip env contract as release workflow.
- Release review fails if either normal release job, the prerelease job, or the manual Windows MSI
  workflows lose the env/verify step.
- Strict GlitchTip env verification is documented as release-artifact behavior, not a user-facing
  runtime setting.
- Docs remain consistent with the actual workflows.

## Task 4: Keep Graphify Output Out Of The Product Diff

### Files

- Usually restore: `graphify-out/.graphify_labels.json`
- Usually restore: `graphify-out/GRAPH_REPORT.md`
- Usually restore: `graphify-out/graph.json`
- Usually restore: `graphify-out/manifest.json`

### Contract

`graphify-out/` is generated navigation output. It should not be mixed with product behavior,
release workflow, or Den admin changes. If the graph update is intentionally needed, it must be a
separate generated-output commit with no app/server/workflow changes.

### Implementation Shape

For the KISS follow-up, prefer restoring generated output from the base commit:

```bash
git restore --source=fbd0756b40f041fe577ba2d7ee57b1d104d78cc3 -- graphify-out
```

If that is not the right base for the final branch, use the merge target branch instead. Do not edit
graph JSON by hand.

### Focused Verification

```bash
git diff --stat fbd0756b40f041fe577ba2d7ee57b1d104d78cc3..HEAD -- graphify-out
git diff --check -- graphify-out
```

Acceptance:

- `graphify-out/` no longer dominates the behavior PR diff.
- If graph output remains changed, it is isolated and explicitly described as generated output.

## Task 5: Final Cross-Slice Verification

Run focused checks first, then broader safety checks:

```bash
git diff --stat fbd0756b40f041fe577ba2d7ee57b1d104d78cc3..HEAD -- . ':!graphify-out/**'
git diff --stat fbd0756b40f041fe577ba2d7ee57b1d104d78cc3..HEAD -- graphify-out
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/pending-session-draft-controller.test.ts src/app/tests/context/composer-target-controller.test.ts src/app/tests/lib/pending-session-drafts.test.ts src/app/tests/pages/session-composer-drafts.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/den exec tsx --test test/admin-contract.test.ts
pnpm --filter @neatech/den build
node --test scripts/release/review.test.mjs
node scripts/release/review.mjs --json
git diff --check
```

If the local Den e2e backend is available, also run:

```bash
pnpm --filter @neatech/veslo-e2e exec playwright test specs/den-admin-billing-integrated.playwright.spec.ts
```

Do not mark `done: true` until:

- The new draft tests prove text and attachments survive target switching.
- Private-to-directory switching does not silently leak scratch workspaces.
- The org-admin path avoids platform-only calls instead of ignoring their failures.
- Den billing controls are either real, hidden, or visibly disabled.
- The prerelease workflow and release review checks agree.
- `graphify-out/` is restored or intentionally split from behavior changes.
- The final summary states whether the integrated Den Playwright test was run or why it was not.

## Residual Risks

- Existing stale per-workspace pending draft directories remain intentionally ignored. That is not a
  data migration bug for this plan.
- A real browser e2e is still the best proof for Den org-admin console cleanliness. If it cannot run
  locally, the implementation should include request-path unit coverage and call out the remaining
  manual e2e gap.
- Release review can only validate repository workflow text. It cannot prove the GitHub repository
  variable is configured; the workflow verify step remains the runtime guard.
- If `graphify-out/` is kept changed for a separate generated-output reason, reviewers still need to
  verify that commit independently from the behavioral slices.
