# Owned Server Self-Hosted Runner Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `Deploy Owned Server` succeed by running the deploy job directly on the owned server instead of SSHing from GitHub-hosted runners.

**Architecture:** Install a repository-scoped self-hosted GitHub Actions runner on the owned server and label it `veslo-owned-server`. Update the workflow to run on that label and execute the same Compose deployment commands locally.

**Tech Stack:** GitHub Actions, GitHub self-hosted runner, Docker Compose, Node `node:test` source guard, owned-server packaging.

---

### Task 1: Add Source Guard

**Files:**
- Modify: `services/den/test/owned-server-deploy-workflow.test.ts`

**Steps:**
1. Change the workflow guard to require `runs-on`, `self-hosted`, `linux`, `x64`, and `veslo-owned-server`.
2. Require direct local deploy commands and forbid `ssh -i`.
3. Run the focused test and confirm it fails against the current SSH workflow.

### Task 2: Install Runner

**Files:**
- Server state only: `/home/neatech/actions-runner-veslo`

**Steps:**
1. Create a GitHub runner registration token through the repository API.
2. Download the latest `actions-runner-linux-x64` release on the owned server.
3. Configure the runner for `https://github.com/neatechcz/veslo` with label `veslo-owned-server`.
4. Start it as a user service or persistent background process.
5. Confirm GitHub reports the runner online.

### Task 3: Update Workflow and Docs

**Files:**
- Modify: `.github/workflows/deploy-owned-server.yml`
- Modify: `docs/dev/cloud-deployments.md`
- Modify: `packaging/owned-server/README.md`

**Steps:**
1. Switch the deploy job to the self-hosted runner labels.
2. Remove SSH validation and SSH setup from the active path.
3. Replace the SSH heredoc with direct local checkout, Compose, migration, startup, and health commands.
4. Update docs to describe the self-hosted runner requirement.

### Task 4: Verify and Release

**Files:**
- Commit changed files.

**Steps:**
1. Run the focused workflow guard.
2. Run YAML parse and whitespace checks.
3. Commit and push to `main`.
4. Trigger `Deploy Owned Server`.
5. Poll the workflow and inspect logs if it fails.
