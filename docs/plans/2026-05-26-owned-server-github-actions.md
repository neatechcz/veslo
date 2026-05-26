# Owned Server GitHub Actions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Render production deployment workflows with a manual owned-server GitHub Actions deployment path.

**Architecture:** A single manual GitHub Actions workflow SSHes to `neatech@62.109.146.43`, updates a stable checkout, deploys the `packaging/owned-server` Compose stack, runs migrations, and verifies public/internal health. Render-specific Den and AI Gateway workflows are removed so production Actions no longer target retired infrastructure.

**Tech Stack:** GitHub Actions, OpenSSH, Docker Compose, pnpm service migrations, Veslo owned-server Compose assets.

---

### Task 1: Add Workflow Source Guard

**Files:**
- Create: `services/den/test/owned-server-deploy-workflow.test.ts`

**Step 1: Write the failing test**

Create tests that read `.github/workflows/deploy-owned-server.yml`, assert required SSH/Compose/migration/health strings, and assert `.github/workflows/deploy-den.yml` plus `.github/workflows/deploy-ai-gateway.yml` do not exist.

**Step 2: Run test to verify it fails**

Run: `pnpm --dir services/den exec tsx --test test/owned-server-deploy-workflow.test.ts`

Expected: FAIL because the owned-server workflow does not exist and old Render workflows still exist.

### Task 2: Replace Deployment Workflows

**Files:**
- Create: `.github/workflows/deploy-owned-server.yml`
- Delete: `.github/workflows/deploy-den.yml`
- Delete: `.github/workflows/deploy-ai-gateway.yml`

**Step 1: Implement workflow**

Create a manual workflow that:

- configures SSH from `OWNED_SERVER_SSH_KEY` and `OWNED_SERVER_KNOWN_HOSTS`,
- clones or updates the selected branch in `OWNED_SERVER_APP_DIR`,
- validates `packaging/owned-server/compose.yml`,
- builds `worker-runtime-image`, `worker-manager`, `den`, `ai-gateway`, and `web`,
- starts database and worker manager dependencies,
- runs Den and AI Gateway migrations,
- starts the full stack,
- verifies public and internal health.

**Step 2: Run source guard**

Run: `pnpm --dir services/den exec tsx --test test/owned-server-deploy-workflow.test.ts`

Expected: PASS.

### Task 3: Update Deployment Documentation

**Files:**
- Modify: `docs/dev/cloud-deployments.md`
- Modify: `packaging/owned-server/README.md`

**Step 1: Update docs**

Document `Deploy Owned Server` as the production deployment path, list required GitHub secrets/vars, and mark Render deploy workflows as retired.

**Step 2: Search for stale active Render deploy guidance**

Run: `rg -n "Deploy Den|Deploy AI Gateway|Render control-plane|Render Auto-Deploy|RENDER_API_KEY" docs/dev packaging/owned-server .github/workflows`

Expected: no active guidance saying production deploys use Render.

### Task 4: Final Verification

**Files:**
- Test: `services/den/test/owned-server-deploy-workflow.test.ts`

**Step 1: Run focused tests**

Run: `pnpm --dir services/den exec tsx --test test/owned-server-deploy-workflow.test.ts`

Expected: PASS.

**Step 2: Check workflow YAML and diff**

Run: `git diff --check`

Expected: exit 0.

**Step 3: Commit**

Run:

```bash
git add .github/workflows docs/dev/cloud-deployments.md packaging/owned-server/README.md services/den/test/owned-server-deploy-workflow.test.ts docs/plans/2026-05-26-owned-server-github-actions-design.md docs/plans/2026-05-26-owned-server-github-actions.md
git commit -m "ci: deploy production through owned server"
```
