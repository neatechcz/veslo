# Render Hosted Auth Email Testing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the real hosted Render Den service testable for this auth-email branch by updating the deploy workflow and docs to support branch dispatches and auth-email env propagation.

**Architecture:** Use a source-level regression test to pin the required workflow behavior, then patch `.github/workflows/deploy-den.yml` so workflow dispatch uses the selected branch/ref for hosted testing and so Render env sync includes the auth-email configuration. Keep the desktop app behavior unchanged; this is a deploy-path fix, not a product-path change.

**Tech Stack:** GitHub Actions workflow YAML, Python-in-YAML deploy script, Markdown docs, Node test runner (`node --test`), pnpm

---

### Task 1: Add a failing deploy workflow source test

**Files:**
- Create: `scripts/release/deploy-den.test.mjs`
- Test: `scripts/release/deploy-den.test.mjs`

**Step 1: Write the failing test**

Add a `node:test` file that reads:
- `.github/workflows/deploy-den.yml`
- `services/den/README.md`

Assert that the workflow:
- references `RESEND_API_KEY`
- references `AUTH_EMAIL_FROM`
- references `DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED`
- uses dispatch-aware branch resolution for manual deploys

Assert that the README mentions hosted auth-email testing requirements.

**Step 2: Run the test to verify it fails**

Run:

```bash
node --test scripts/release/deploy-den.test.mjs
```

Expected: FAIL because the workflow does not yet contain the missing auth-email env sync or dispatch-aware branch handling.

**Step 3: Commit the failing test**

```bash
git add scripts/release/deploy-den.test.mjs
git commit -m "test: add deploy den auth email workflow guard"
```

### Task 2: Patch the hosted Den deploy workflow

**Files:**
- Modify: `.github/workflows/deploy-den.yml`
- Test: `scripts/release/deploy-den.test.mjs`

**Step 1: Add missing auth-email workflow inputs**

Pass the following through validation and deploy env blocks:
- `DEN_RESEND_API_KEY`
- `DEN_AUTH_EMAIL_FROM`
- `DEN_DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED`

Use secrets for email credentials and a repo var for the boolean toggle.

**Step 2: Make manual branch deploys dispatch-aware**

Adjust branch resolution inside the embedded Python so:
- push-based runs continue to use the configured branch override when desired
- `workflow_dispatch` prefers the selected `github.ref_name`

Keep the existing repo/rootDir override behavior intact.

**Step 3: Sync the auth-email env vars to Render**

Extend `env_vars` so Render receives:
- `RESEND_API_KEY`
- `AUTH_EMAIL_FROM`
- `DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED`

**Step 4: Run the test to verify it passes**

Run:

```bash
node --test scripts/release/deploy-den.test.mjs
```

Expected: PASS.

**Step 5: Commit the workflow change**

```bash
git add .github/workflows/deploy-den.yml scripts/release/deploy-den.test.mjs
git commit -m "fix: support hosted auth email testing in den deploy"
```

### Task 3: Document hosted Render testing requirements

**Files:**
- Modify: `services/den/README.md`
- Test: `scripts/release/deploy-den.test.mjs`

**Step 1: Document the hosted branch-testing path**

Add a short section that explains:
- auto deploys happen on `dev`/`main`
- branch testing uses manual `Deploy Den` workflow dispatch
- the hosted auth-email flow requires GitHub secrets/vars for:
  - `DEN_RESEND_API_KEY`
  - `DEN_AUTH_EMAIL_FROM`
  - `DEN_DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED`

**Step 2: Re-run the source test**

Run:

```bash
node --test scripts/release/deploy-den.test.mjs
```

Expected: PASS.

**Step 3: Commit the docs**

```bash
git add services/den/README.md
git commit -m "docs: describe hosted den auth email testing"
```

### Task 4: Final verification

**Files:**
- Verify: `.github/workflows/deploy-den.yml`
- Verify: `services/den/README.md`
- Verify: `scripts/release/deploy-den.test.mjs`

**Step 1: Run final verification**

Run:

```bash
node --test scripts/release/deploy-den.test.mjs
git diff --stat
git status --short --branch
```

Expected:
- source test PASS
- only the intended workflow/doc/test files changed

**Step 2: Summarize the hosted deploy path**

Report the exact next user action:
- push branch
- run `Deploy Den` with `workflow_dispatch` from this branch
- confirm hosted Render now serves the new onboarding flow

**Step 3: Commit final clean state**

```bash
git add docs/plans/2026-03-28-render-hosted-auth-email-testing-design.md docs/plans/2026-03-28-render-hosted-auth-email-testing-implementation-plan.md
git commit -m "docs: add hosted den auth email rollout plan"
```
