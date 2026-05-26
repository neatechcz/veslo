# Owned Server Ops Admin Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the Den platform-admin ops workflow onto the owned server so production DB mutations happen through the owned-server Compose stack.

**Architecture:** The manual workflow runs on the `veslo-owned-server` runner, validates the stable checkout and env file, and executes the existing Node grant script inside the `den` service with `docker compose exec`.

**Tech Stack:** GitHub Actions, self-hosted runner, Docker Compose, Node.js, mysql2, node:test source guards.

---

### Task 1: Add the Failing Source Guard

**Files:**
- Create: `services/den/test/owned-server-ops-workflow.test.ts`

**Steps:**
1. Assert `.github/workflows/ops-den-platform-admin.yml` exists.
2. Assert it contains the self-hosted runner labels.
3. Assert it uses `OWNED_SERVER_APP_DIR`, `OWNED_SERVER_ENV_FILE`, `docker compose`, `compose exec -T den`, and `cd /app/services/den`.
4. Assert it does not contain `ubuntu-latest`, `actions/checkout`, `setup-node`, `pnpm install`, or `DEN_DATABASE_URL`.
5. Run the test and verify it fails against the current workflow.

### Task 2: Convert the Workflow

**Files:**
- Modify: `.github/workflows/ops-den-platform-admin.yml`

**Steps:**
1. Change `runs-on` to `[self-hosted, linux, x64, veslo-owned-server]`.
2. Remove checkout, Node setup, pnpm setup, and dependency install steps.
3. Add `OWNED_SERVER_APP_DIR` and `OWNED_SERVER_ENV_FILE` env defaults.
4. Run the existing Node script through `compose exec -T den sh -lc 'cd /app/services/den; node'`.
5. Pass `TARGET_EMAIL` and `APPLY_GRANT` into the container command.

### Task 3: Verify and Ship

**Files:**
- Commit changed files.

**Steps:**
1. Run the focused workflow guard.
2. Run YAML parse and whitespace checks.
3. Commit and push to `main`.
