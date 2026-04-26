# Verify Email Desktop Handoff Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the email verification success page finish the existing desktop browser sign-in handoff through a visible `Return to Veslo` action so the desktop app can complete sign-in without restarting auth.

**Architecture:** Keep the current Den desktop auth flow as the only handoff mechanism. Extend the web verification success page to detect desktop onboarding context, reuse the authenticated browser session plus org context, request a standard `/v1/desktop-auth/handoff` code, and expose the existing `veslo://auth-complete?code=...` deep link.

**Tech Stack:** Next.js app router, React client components, existing web auth shell in `packages/web`, Den desktop-auth HTTP endpoints, TypeScript tests and script assertions.

---

### Task 1: Add a failing verification-page contract test

**Files:**
- Modify: `packages/web/scripts/auth-email-flows.mjs`
- Test: `packages/web/scripts/auth-email-flows.mjs`

**Step 1: Write the failing test**

Add assertions that the verification page source contains:

- desktop onboarding detection
- a handoff request path using `/v1/desktop-auth/handoff`
- a `veslo://auth-complete` CTA path or helper
- a visible `Return to Veslo` action that is more specific than a plain `/` link

**Step 2: Run test to verify it fails**

Run:

```bash
node packages/web/scripts/auth-email-flows.mjs
```

Expected: FAIL because `packages/web/app/verify-email/page.tsx` is currently static and does not contain desktop handoff logic.

**Step 3: Commit**

Do not commit yet. This is a red test checkpoint.

### Task 2: Add a failing page-level verification test for the success CTA

**Files:**
- Create or modify: `packages/web/app/verify-email/page.test.tsx` or the closest existing web page test location if one already exists
- Test: same file

**Step 1: Write the failing test**

Add a test for the verification page behavior:

- with desktop onboarding query context and a successful mocked handoff response, the page renders a `Return to Veslo` CTA targeting a `veslo://auth-complete?code=...` URL
- with an error query param, the page does not request handoff and keeps error messaging

Use the smallest existing web test style already present in the repo for page/component tests.

**Step 2: Run test to verify it fails**

Run the narrowest available web test command for that file. If no dedicated test runner exists for page tests, use the repository’s current smallest equivalent and note it in the implementation.

Expected: FAIL because the page does not currently request or render handoff state.

**Step 3: Commit**

Do not commit yet. This is still red.

### Task 3: Extract or add a small shared desktop-handoff helper for the web flow

**Files:**
- Modify: `packages/web/components/cloud-control.tsx`
- Create or modify: a shared helper under `packages/web/lib/` if needed
- Test: helper test file if a new helper is introduced

**Step 1: Write the failing test**

If extracting logic, add a helper test that covers:

- building the handoff request using auth token plus org id
- converting the successful handoff payload into `veslo://auth-complete?code=...`
- handling invalid payloads as errors

**Step 2: Run test to verify it fails**

Run the helper test only.

Expected: FAIL because the helper does not exist yet.

**Step 3: Write minimal implementation**

Create the smallest shared helper so both `cloud-control.tsx` and `/verify-email` can use the same handoff request/deep-link logic instead of duplicating it.

Keep scope limited to:

- request handoff
- validate returned code
- produce deep-link URL

Do not redesign auth state management.

**Step 4: Run test to verify it passes**

Run the same helper test.

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/web/components/cloud-control.tsx packages/web/lib/<helper>.ts packages/web/lib/<helper>.test.ts
git commit -m "refactor(web): share desktop auth handoff helper"
```

If no helper extraction is needed after inspection, skip the helper file and keep the change inside the existing page components, but preserve the TDD sequence.

### Task 4: Implement verification-page desktop handoff

**Files:**
- Modify: `packages/web/app/verify-email/page.tsx`
- Modify: `packages/web/components/cloud-control.tsx` if shared logic is adopted
- Test: the page test from Task 2
- Test: `packages/web/scripts/auth-email-flows.mjs`

**Step 1: Write minimal implementation**

Implement only what is needed for the approved behavior:

- read desktop onboarding query context on `/verify-email`
- if verification succeeded and desktop onboarding applies, request `/v1/desktop-auth/handoff`
- use the current authenticated browser session and active org context
- render a visible `Return to Veslo` CTA that points to `veslo://auth-complete?code=...`
- keep generic `/` fallback only when desktop onboarding context is absent
- keep the error path non-handoff

Avoid adding auto-open-only behavior as the sole success path. The visible CTA is required.

**Step 2: Run the page test**

Run the narrow page/component test from Task 2.

Expected: PASS.

**Step 3: Run the contract script**

Run:

```bash
node packages/web/scripts/auth-email-flows.mjs
```

Expected: PASS.

**Step 4: Commit**

```bash
git add packages/web/app/verify-email/page.tsx packages/web/components/cloud-control.tsx packages/web/scripts/auth-email-flows.mjs
git commit -m "feat(web): finish desktop auth after email verification"
```

### Task 5: Protect the existing desktop auth contract

**Files:**
- Modify: `packages/app/src/app/lib/den-auth.test.ts` only if helper or parsing behavior changes
- Modify: `packages/e2e/helpers/live-desktop-auth.test.ts` only if the external handoff contract changes
- Test: same files

**Step 1: Write a failing test only if behavior changed**

If implementation introduces any new deep-link parameter handling or browser-side assumptions, add the smallest failing test that captures it.

Examples:

- accepting a handoff completion launched from the verification page
- keeping the same `veslo://auth-complete?code=...` contract without extra required parameters

**Step 2: Run test to verify it fails**

Run only the affected auth helper test.

Expected: FAIL only if a real contract change was introduced.

**Step 3: Write minimal implementation**

Only change desktop auth helper code if the tests prove it is necessary. Prefer not touching `packages/app/src/app/lib/den-auth.ts` if the web-side handoff can stay within the current contract.

**Step 4: Run test to verify it passes**

Run the same focused auth helper test.

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/den-auth.ts packages/app/src/app/lib/den-auth.test.ts packages/e2e/helpers/live-desktop-auth.test.ts
git commit -m "test(auth): protect desktop verification handoff contract"
```

Only make this commit if those files changed.

### Task 6: Update durable docs

**Files:**
- Modify: `docs/features/onboarding-and-auth.md`
- Modify: `packages/web/README.md`

**Step 1: Update docs**

Document that desktop onboarding mode now includes the verification-success path:

- user starts desktop browser auth
- if verification is required, `/verify-email` can complete the existing desktop handoff
- the success path surfaces a `Return to Veslo` action

Keep the wording durable and behavior-focused.

**Step 2: Run any doc-adjacent script if needed**

If a script validates these docs or related auth flow assertions, run it. Otherwise rely on the existing web/auth checks.

**Step 3: Commit**

```bash
git add docs/features/onboarding-and-auth.md packages/web/README.md
git commit -m "docs: describe verification desktop handoff"
```

### Task 7: Focused verification

**Files:**
- No code changes unless verification fails

**Step 1: Run focused web/auth checks**

Run:

```bash
node packages/web/scripts/auth-email-flows.mjs
pnpm --filter @neatech/veslo-ui exec tsx --test packages/app/src/app/lib/den-auth.test.ts
```

Also run the narrowest web page/component test command used in Tasks 2 and 4.

Expected: PASS.

**Step 2: Fix any failures**

If anything fails, fix only the minimum code required and rerun the exact failing command before broadening verification.

**Step 3: Commit**

If verification forced code changes:

```bash
git add <changed files>
git commit -m "fix: address verification handoff regressions"
```

Otherwise skip this commit.

### Task 8: Desktop-runtime verification

**Files:**
- No code changes unless runtime verification exposes issues

**Step 1: Run desktop preflight**

From repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

**Step 2: Run the smallest real runtime verification**

Prefer the smallest already-existing live desktop auth helper/spec that covers browser sign-in handoff. If no automated real runtime spec covers post-verification handoff yet, run the closest live desktop auth helper flow and manually verify:

- sign in via browser
- trigger verification-required state
- complete email verification
- click `Return to Veslo`
- confirm desktop auth completes without restarting sign-in

**Step 3: Record the verification result**

Record the exact command or manual runtime path used and any gap that remains.

**Step 4: Commit**

Only if runtime verification requires a code fix.

### Task 9: Final verification gate

**Files:**
- No code changes unless final checks fail

**Step 1: Run final checks**

Run at minimum:

```bash
node packages/web/scripts/auth-email-flows.mjs
pnpm --filter @neatech/veslo-ui exec tsx --test packages/app/src/app/lib/den-auth.test.ts
```

Include the page/component test command from earlier tasks.

**Step 2: Ensure git state is clean except intended changes**

Run:

```bash
git status --short --branch
```

Expected: only intended files are modified before the final commit, or clean after all commits.

**Step 3: Final commit**

```bash
git add <remaining changed files>
git commit -m "feat(auth): complete desktop sign-in after email verification"
```

Skip if previous commits already captured the final state and the tree is clean.
