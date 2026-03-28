# Render Hosted Auth Email Testing Design

Date: 2026-03-28
Branch: `codex/auth-email-verification-reset`

## Problem

The desktop/browser auth email verification work is implemented in this branch, but the real hosted Render Den instance is not serving it yet. The desktop app defaults to `https://den-control-plane-veslo.onrender.com`, so an MSI built from this branch still talks to the hosted backend unless overridden. That hosted backend is still serving the old onboarding page and behavior.

## Constraints

- Real hosted testing must use the existing Render control-plane service.
- The current repo workflow only auto-deploys Den on pushes to `dev` or `main`.
- The current deploy workflow does not sync the auth-email environment required for this feature:
  - `RESEND_API_KEY`
  - `AUTH_EMAIL_FROM`
  - `DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED`
- Manual `workflow_dispatch` must be reliable for branch-based testing and should not silently redeploy a pinned branch via `DEN_RENDER_CONTROL_PLANE_BRANCH`.

## Options

### 1. Manual Render dashboard changes only

Update the hosted service branch and env vars directly in Render.

Pros:
- Fastest one-off unblock

Cons:
- Not reproducible
- Easy to drift from repo state
- Hard to audit later

### 2. Patch the deploy workflow and docs

Update `.github/workflows/deploy-den.yml` so hosted testing is reproducible:
- sync the missing auth-email env vars
- make manual dispatch prefer the selected branch/ref instead of a pinned branch override
- document the required GitHub secrets/vars for hosted auth-email testing

Pros:
- Reproducible
- Matches repo-as-source-of-truth expectations
- Solves the exact hosted-testing gap without adding new infrastructure

Cons:
- Small workflow/doc change required

### 3. Add a separate Render preview service

Create a dedicated per-branch or staging Den service.

Pros:
- Clean separation from the main hosted service

Cons:
- Larger operational scope
- Not needed to validate this branch

## Recommendation

Use option 2.

This keeps the current hosted service, but makes branch testing and auth-email configuration explicit and repeatable from GitHub Actions. It is the smallest change that unblocks testing on the real Render instance without relying on manual dashboard drift.

## Approved Design

1. Add a source-level workflow test that asserts:
   - manual `workflow_dispatch` deploys from the selected ref unless explicitly overridden for push-based automation
   - the deploy workflow syncs `RESEND_API_KEY`, `AUTH_EMAIL_FROM`, and `DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED`
   - Den docs mention the hosted deploy requirements for auth-email testing
2. Update `.github/workflows/deploy-den.yml` to:
   - pass the auth-email secrets/vars into validation and env sync
   - make branch resolution dispatch-aware so manual branch deploys are predictable
3. Update `services/den/README.md` with the hosted-testing requirements and the expectation that auth-email secrets/vars must exist in GitHub Actions/Render deploy inputs.

## Verification

- `node --test scripts/release/deploy-den.test.mjs`
- targeted source inspection of `.github/workflows/deploy-den.yml`
- confirm docs mention the hosted testing path and required envs
