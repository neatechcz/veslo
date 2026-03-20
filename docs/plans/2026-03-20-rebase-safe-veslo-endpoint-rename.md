# Rebase-Safe Veslo Endpoint Rename Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove remaining active `openwork` endpoint/server naming from current Veslo surfaces while preserving upstream-rebase compatibility anchors.

**Architecture:** Use a rebase-safe overlay strategy: update active runtime defaults, deployment-facing env/docs, and live Render service naming/URL surface. Keep legacy aliases and migration-only identifiers that intentionally preserve compatibility with historical OpenWork state.

**Tech Stack:** TypeScript (app + den), markdown docs, Render REST API, GitHub Actions deploy workflow.

---

### Task 1: Baseline + scope lock

**Files:**
- Read: `packages/app/src/app/lib/den-auth.ts`
- Read: `services/den/README.md`
- Read: `.github/workflows/deploy-den.yml`

**Step 1: Capture current endpoint references**

Run:
```bash
rg -n "openwork-den-dev-api|den-control-plane-openwork|openwork" packages/app/src/app/lib/den-auth.ts services/den/README.md .github/workflows/deploy-den.yml
```

Expected: identifies current active endpoint and remaining docs references.

**Step 2: Commit scope rule**

Keep unchanged:
- legacy aliases/migration keys (`openwork.*` localStorage/serde aliases)
- upstream compatibility sources used for migration (`openwork-snapshot`, legacy state filenames)

### Task 2: Endpoint + docs/env rename in repo

**Files:**
- Modify: `packages/app/src/app/lib/den-auth.ts`
- Modify: `services/den/.env.example`
- Modify: `services/den/README.md`
- Modify: `packages/docs/quickstart.mdx`
- Modify: `packages/docs/cli.mdx`
- Modify: `packages/docs/introduction.mdx`
- Modify: `packages/docs/development.mdx`
- Modify: `RELEASE.md`
- Modify: `INFRASTRUCTURE.md`

**Step 1: Rename default Den API endpoint to Veslo endpoint**
- Set default base to `https://den-control-plane-veslo.onrender.com`.

**Step 2: Update active docs examples to veslo names**
- Replace `openwork-*` package/CLI/server references with `veslo-*` where those docs describe active Veslo usage.
- Keep historical/audit docs untouched.

**Step 3: Validate grep for active files**

Run:
```bash
rg -n "openwork-den-dev-api|openwork-orchestrator|openwork-server|different-ai/openwork|openwork.software" \
  packages/app/src/app/lib/den-auth.ts services/den/.env.example services/den/README.md \
  packages/docs/quickstart.mdx packages/docs/cli.mdx packages/docs/introduction.mdx packages/docs/development.mdx \
  RELEASE.md INFRASTRUCTURE.md
```

Expected: no hits, or only explicitly retained compatibility text with rationale.

### Task 3: Rename active Render control-plane service (live)

**External systems:**
- Render API (using existing org credentials)

**Step 1: Find current service by known URL/name**
- Query Render services for owner and identify the current Den control-plane service.

**Step 2: Rename service to Veslo form**
- Patch service `name` to Veslo naming (`den-control-plane-veslo`).

**Step 3: Verify live URL and health**
- Confirm resulting URL is Veslo-based and `/health` returns OK.

### Task 4: Verification gate

**Step 1: Run DEN tests**

Run:
```bash
pnpm --dir services/den exec tsx --test test/render-provisioner.test.ts
pnpm --dir services/den test
```

Expected: pass.

**Step 2: Focused grep safety check**

Run:
```bash
rg -n "openwork-den-dev-api|openwork-den|den-control-plane-openwork" packages/app/src services/den packages/docs RELEASE.md INFRASTRUCTURE.md
```

Expected: no active-surface hits.

**Step 3: Git diff review + commit**

Run:
```bash
git status -sb
git diff --stat
```

Expected: only intended files changed.
