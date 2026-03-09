# Desktop Den Auth Handoff Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route first-run desktop onboarding through the existing Den web sign-in and organization flow, then return to desktop with a secure one-time handoff so local folder and local worker onboarding can continue.

**Architecture:** Keep Den as the identity and org authority, keep `packages/web` as the browser auth UI, and add a new one-time `auth-complete` deep-link exchange for desktop. Do not change desktop runtime mode to `cloud_only`, do not reuse remote worker connect tokens for identity, and do not mix desktop auth state into `veslo.server.*`.

**Tech Stack:** Express + Better Auth + Drizzle/MySQL in `services/den`, Next.js in `packages/web`, SolidJS + Tauri plugins in `packages/app`.

---

### Task 1: Add Den desktop handoff data model

**Files:**
- Modify: `services/den/src/db/schema.ts`
- Create: `services/den/drizzle/0002_desktop_auth_handoff.sql`
- Test: `services/den/test/desktop-auth-handoff.test.ts`

**Step 1: Write the failing test**

Create `services/den/test/desktop-auth-handoff.test.ts` with focused tests for:
- creating a handoff row with `code`, `userId`, `orgId`, `expiresAt`, `consumedAt`
- rejecting expired handoffs
- rejecting already-consumed handoffs

Use the existing `node:test` + `assert` style already used in `services/den/test/multi-tenant-rules.test.ts`.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/den test -- --test-name-pattern="desktop auth handoff"
```

Expected: FAIL because the handoff table and helpers do not exist yet.

**Step 3: Write minimal implementation**

Add a `desktop_auth_handoff` table to `services/den/src/db/schema.ts` with fields:
- `id`
- `code`
- `user_id`
- `org_id`
- `expires_at`
- `consumed_at`
- `created_at`

Add the matching SQL migration in `services/den/drizzle/0002_desktop_auth_handoff.sql`.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/den test -- --test-name-pattern="desktop auth handoff"
```

Expected: PASS for the new persistence helpers.

**Step 5: Commit**

```bash
git add services/den/src/db/schema.ts services/den/drizzle/0002_desktop_auth_handoff.sql services/den/test/desktop-auth-handoff.test.ts
git commit -m "feat(den): add desktop auth handoff storage"
```

### Task 2: Add Den handoff and exchange endpoints

**Files:**
- Create: `services/den/src/http/desktop-auth.ts`
- Modify: `services/den/src/index.ts`
- Modify: `services/den/src/http/session.ts`
- Modify: `services/den/src/http/org-auth.ts`
- Test: `services/den/test/desktop-auth-handoff.test.ts`

**Step 1: Write the failing test**

Extend `services/den/test/desktop-auth-handoff.test.ts` to cover:
- `POST /v1/desktop-auth/handoff` requires an authenticated browser session
- `POST /v1/desktop-auth/handoff` binds the code to the resolved active org
- `POST /v1/desktop-auth/exchange` returns bearer token, user summary, and active org
- `POST /v1/desktop-auth/exchange` is single-use

If full HTTP route tests are too heavy, extract small helper functions in `desktop-auth.ts` and test them directly first.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/den test -- --test-name-pattern="desktop auth"
```

Expected: FAIL because the route module and exchange logic do not exist yet.

**Step 3: Write minimal implementation**

Implement `services/den/src/http/desktop-auth.ts`:
- `POST /v1/desktop-auth/handoff`
- `POST /v1/desktop-auth/exchange`

Rules:
- `handoff` uses the Better Auth session from browser cookies
- `handoff` resolves org using the same org-selection rules as `/v1/orgs`
- `exchange` consumes the code exactly once
- `exchange` returns a bearer token that desktop can use against `/v1/me` and `/v1/orgs`

Wire the router in `services/den/src/index.ts`.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/den test -- --test-name-pattern="desktop auth"
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/http/desktop-auth.ts services/den/src/index.ts services/den/src/http/session.ts services/den/src/http/org-auth.ts services/den/test/desktop-auth-handoff.test.ts
git commit -m "feat(den): add desktop auth code exchange"
```

### Task 3: Add web desktop-onboarding handoff mode

**Files:**
- Modify: `packages/web/components/cloud-control.tsx`
- Modify: `packages/web/package.json`
- Create: `packages/web/scripts/desktop-auth-mode.mjs`
- Test: `packages/web/scripts/desktop-auth-mode.mjs`

**Step 1: Write the failing test**

Create `packages/web/scripts/desktop-auth-mode.mjs` in the same static-assertion style used by `packages/app/scripts/*.mjs`.

Assert that:
- a desktop onboarding mode is recognized
- the sign-in flow requests `/v1/desktop-auth/handoff`
- this mode builds `veslo://auth-complete?code=...`
- this mode does not call worker token generation helpers

Add a package script:

```json
"test:desktop-auth-mode": "node scripts/desktop-auth-mode.mjs"
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-web test:desktop-auth-mode
```

Expected: FAIL because no desktop auth mode exists yet.

**Step 3: Write minimal implementation**

In `packages/web/components/cloud-control.tsx`:
- detect desktop onboarding mode from query string or route flag
- after auth + org resolution, call `/v1/desktop-auth/handoff`
- deep-link to `veslo://auth-complete?code=...`
- bypass worker launch and worker token fetch in this mode

Keep the existing cloud worker flow unchanged outside this mode.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-web test:desktop-auth-mode
pnpm --filter @neatech/veslo-web build
```

Expected: static assertion PASS, then web build PASS.

**Step 5: Commit**

```bash
git add packages/web/components/cloud-control.tsx packages/web/package.json packages/web/scripts/desktop-auth-mode.mjs
git commit -m "feat(web): add desktop auth handoff mode"
```

### Task 4: Add desktop cloud auth state and `auth-complete` deep link

**Files:**
- Create: `packages/app/src/app/lib/den-auth.ts`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/types.ts`
- Modify: `packages/app/package.json`
- Create: `packages/app/scripts/desktop-auth-onboarding.mjs`
- Test: `packages/app/scripts/desktop-auth-onboarding.mjs`

**Step 1: Write the failing test**

Create `packages/app/scripts/desktop-auth-onboarding.mjs` and add:

```json
"test:desktop-auth-onboarding": "node scripts/desktop-auth-onboarding.mjs"
```

Assert that:
- desktop recognizes `veslo://auth-complete?code=...`
- desktop keeps `connect-remote` handling intact
- desktop auth state is stored separately from `veslo.server.*`
- desktop boot references the new auth state before local worker onboarding

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:desktop-auth-onboarding
```

Expected: FAIL because the new auth state and deep-link path do not exist yet.

**Step 3: Write minimal implementation**

Create `packages/app/src/app/lib/den-auth.ts` with:
- auth state read/write/clear helpers
- code exchange request helper
- `/v1/me` and `/v1/orgs` validation helper

Extend `packages/app/src/app/app.tsx` to:
- parse `auth-complete`
- redeem the code
- persist desktop auth state
- preserve existing `connect-remote` and shared bundle behavior

Add a distinct onboarding step such as `"auth"` in `packages/app/src/app/types.ts`.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:desktop-auth-onboarding
pnpm --filter @neatech/veslo-ui test:runtime-policy
pnpm --filter @neatech/veslo-ui test:local-workspace-mode
```

Expected: PASS, and runtime remains `local_sync`.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/den-auth.ts packages/app/src/app/app.tsx packages/app/src/app/types.ts packages/app/package.json packages/app/scripts/desktop-auth-onboarding.mjs
git commit -m "feat(app): add desktop auth-complete handoff"
```

### Task 5: Gate onboarding on identity before local worker setup

**Files:**
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/pages/onboarding.tsx`
- Modify: `packages/app/src/app/entry.tsx`
- Test: `packages/app/scripts/desktop-auth-onboarding.mjs`

**Step 1: Write the failing test**

Extend `packages/app/scripts/desktop-auth-onboarding.mjs` to assert:
- fresh boot without desktop auth lands on `Sign in to Veslo`
- valid stored desktop auth proceeds to local folder/local worker onboarding
- invalid stored auth is cleared and falls back to sign-in

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:desktop-auth-onboarding
```

Expected: FAIL because boot still resolves directly into current onboarding/session flow.

**Step 3: Write minimal implementation**

In `packages/app/src/app/context/workspace.ts`:
- validate stored desktop auth early in bootstrap
- if no valid auth, set onboarding to the new auth step
- if auth is valid, continue to local onboarding rather than remote connect

In `packages/app/src/app/pages/onboarding.tsx`:
- add the `Sign in to Veslo` view
- open the existing web sign-in flow using the existing external URL opener
- add retry UI for `I already signed in`

Do not merge desktop auth into `veslo.server.*`.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:desktop-auth-onboarding
pnpm --filter @neatech/veslo-ui test:browser-entry
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/workspace.ts packages/app/src/app/pages/onboarding.tsx packages/app/src/app/entry.tsx packages/app/scripts/desktop-auth-onboarding.mjs
git commit -m "feat(app): require Den sign-in before local onboarding"
```

### Task 6: Update docs and deployment wiring for the dev rollout

**Files:**
- Modify: `PRODUCT.md`
- Modify: `VISION.md`
- Modify: `services/den/README.md`
- Modify: `packages/web/README.md`
- Modify: `.github/workflows/deploy-den.yml` only if new env vars are required
- Test: manual deployment checklist in PR notes

**Step 1: Write the failing test**

Write down the missing rollout checks in the PR description or a temporary checklist:
- Den handoff endpoints reachable on Render dev
- web desktop-onboarding mode points to the same Den dev deployment
- desktop uses the intended web auth URL in dev

This task is documentation and rollout, so the “failing test” is a missing checklist until it is written.

**Step 2: Run verification to show the gap**

Run:

```bash
rg -n "desktop auth|auth-complete|Sign in to Veslo" PRODUCT.md VISION.md services/den/README.md packages/web/README.md .github/workflows/deploy-den.yml
```

Expected: incomplete or missing rollout references before docs are updated.

**Step 3: Write minimal implementation**

Update docs to describe:
- browser-based sign-in for desktop onboarding
- Render dev deployment requirement for Den
- web deployment target required for end-to-end QA

Only modify `.github/workflows/deploy-den.yml` if the new handoff feature requires explicit new env vars.

**Step 4: Run verification**

Run:

```bash
pnpm --filter @neatech/den test
pnpm --filter @neatech/veslo-web build
pnpm --filter @neatech/veslo-ui typecheck
```

If environment allows, also run the Den development deployment path by pushing to `dev` or dispatching the workflow, then verify the live service:

```bash
gh run list --repo neatech/veslo --workflow "Deploy Den" --limit 5
curl -I https://api.veslo.neatech.com/health
```

Expected: local verification passes, and the Render dev service responds after deploy.

**Step 5: Commit**

```bash
git add PRODUCT.md VISION.md services/den/README.md packages/web/README.md .github/workflows/deploy-den.yml
git commit -m "docs: document desktop Den auth handoff rollout"
```

### Task 7: End-to-end validation before merge

**Files:**
- No required code changes
- Evidence: screenshots or video under repo-owned evidence path if captured

**Step 1: Prepare the manual flow**

Use a fresh desktop state and the existing onboarding reset skill so the auth-first flow is exercised from clean state.

**Step 2: Run the end-to-end checks**

Required commands:

```bash
pnpm --filter @neatech/den test
pnpm --filter @neatech/veslo-web test:desktop-auth-mode
pnpm --filter @neatech/veslo-web build
pnpm --filter @neatech/veslo-ui test:desktop-auth-onboarding
pnpm --filter @neatech/veslo-ui test:runtime-policy
pnpm --filter @neatech/veslo-ui test:local-workspace-mode
pnpm --filter @neatech/veslo-ui typecheck
```

Then run the desktop app and verify:

1. fresh app shows `Sign in to Veslo`
2. browser auth completes
3. `auth-complete` deep link returns to desktop
4. desktop continues to local folder selection
5. local worker/session setup succeeds
6. app restart keeps the signed-in state

If available, capture screenshots or a short video and store them in the repo for PR evidence.

**Step 3: Commit evidence or notes**

```bash
git add <evidence-paths-if-any>
git commit -m "test: capture desktop Den auth handoff evidence"
```

