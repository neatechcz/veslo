# Lettr Auth Email Switch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Den's Resend-based auth email delivery with a Lettr-only integration using Lettr-native environment variables.

**Architecture:** Keep Better Auth wiring unchanged and swap only the auth mailer, environment parsing, and hosted deploy plumbing. Continue using the existing fetch-based mailer so the provider change stays localized to Den and does not add a new runtime dependency.

**Tech Stack:** TypeScript, Node test runner via `tsx --test`, GitHub Actions workflow YAML, Markdown docs

---

### Task 1: Rename Den auth email configuration to Lettr-native env vars

**Files:**
- Modify: `services/den/test/auth-email-source.test.ts`
- Modify: `services/den/src/env.ts`
- Modify: `services/den/.env.example`
- Modify: `services/den/README.md`

**Step 1: Write the failing test**

Update `services/den/test/auth-email-source.test.ts` to assert:
- `LETTR_API_KEY`
- `AUTH_EMAIL_ADDRESS`
- `AUTH_EMAIL_FROM_NAME`
- README describes Lettr instead of Resend

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir services/den exec tsx --test test/auth-email-source.test.ts
```

Expected: FAIL because the code and docs still reference Resend env names.

**Step 3: Write minimal implementation**

Update Den env parsing, sample env file, and README to use the Lettr-native config names and wording.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --dir services/den exec tsx --test test/auth-email-source.test.ts
```

Expected: PASS.

### Task 2: Switch the auth mailer from Resend to Lettr

**Files:**
- Modify: `services/den/test/auth-mailer.test.ts`
- Modify: `services/den/src/email/auth-mailer.ts`

**Step 1: Write the failing test**

Update `services/den/test/auth-mailer.test.ts` to assert:
- the mailer requires `LETTR_API_KEY` and `AUTH_EMAIL_ADDRESS`
- the Lettr request is sent to `https://app.lettr.com/api/emails`
- the request body includes `from`, `from_name`, `to`, `subject`, `html`, and `text`
- background error handling still logs failures

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir services/den exec tsx --test test/auth-mailer.test.ts
```

Expected: FAIL because the mailer still uses Resend env names and endpoint.

**Step 3: Write minimal implementation**

Patch `services/den/src/email/auth-mailer.ts` to send Lettr-compatible requests while preserving the existing fire-and-forget error semantics.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --dir services/den exec tsx --test test/auth-mailer.test.ts
```

Expected: PASS.

### Task 3: Rename hosted deploy workflow inputs and docs for Lettr

**Files:**
- Modify: `scripts/release/deploy-den.test.mjs`
- Modify: `.github/workflows/deploy-den.yml`
- Modify: `services/den/README.md`

**Step 1: Write the failing workflow test**

Update `scripts/release/deploy-den.test.mjs` to assert the workflow and docs reference:
- `DEN_LETTR_API_KEY`
- `DEN_AUTH_EMAIL_ADDRESS`
- `DEN_AUTH_EMAIL_FROM_NAME`
- Render env sync keys:
  - `LETTR_API_KEY`
  - `AUTH_EMAIL_ADDRESS`
  - `AUTH_EMAIL_FROM_NAME`

**Step 2: Run test to verify it fails**

Run:

```bash
node --test scripts/release/deploy-den.test.mjs
```

Expected: FAIL because the workflow still uses Resend naming.

**Step 3: Write minimal implementation**

Patch the hosted deploy workflow and Den README so GitHub Actions and Render use the Lettr-native secret and env naming while preserving the existing "preserve current Render values when blank" behavior.

**Step 4: Run test to verify it passes**

Run:

```bash
node --test scripts/release/deploy-den.test.mjs
```

Expected: PASS.

### Task 4: Final verification

**Files:**
- Verify: `services/den/src/env.ts`
- Verify: `services/den/src/email/auth-mailer.ts`
- Verify: `.github/workflows/deploy-den.yml`
- Verify: `services/den/README.md`

**Step 1: Run targeted regression checks**

Run:

```bash
pnpm --dir services/den exec tsx --test test/auth-email-source.test.ts test/auth-mailer.test.ts
node --test scripts/release/deploy-den.test.mjs
git diff --stat
git status --short --branch
```

Expected:
- targeted tests PASS
- workflow source test PASS
- only the intended Den/workflow/doc/plan files changed

**Step 2: Report follow-up operational work**

Document that the provided Lettr key must be stored as an external secret and that hosted rollout still requires updating GitHub Actions/Render secrets outside git.
