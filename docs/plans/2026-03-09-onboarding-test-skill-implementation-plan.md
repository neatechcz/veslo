# Onboarding Test Skill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a repository-local skill that resets local Veslo dev state and launches the desktop app once without cloud auto-connect env so onboarding can be tested.

**Architecture:** Keep all behavior outside the product. Put the workflow in a repo-local skill under `.opencode/skills/` and a small shell helper script that clears known state locations and launches `pnpm dev` with `VITE_VESLO_*` variables blanked for that process only.

**Tech Stack:** Markdown skill docs, Bash helper script, existing repo dev commands

---

### Task 1: Add the repo-local skill

**Files:**
- Create: `.opencode/skills/test-onboarding-flow/SKILL.md`

**Step 1: Write the skill frontmatter and trigger description**

Create a new skill with a descriptive trigger for testing Veslo onboarding from this repo.

**Step 2: Document the exact workflow**

Include:
- stop existing dev processes first
- run the helper script
- verify Veslo opens in onboarding instead of direct entry
- restore normal behavior by launching `pnpm dev` normally later

**Step 3: Verify the skill stays repo-local**

Confirm the skill lives only under `.opencode/skills/` in this repository.

### Task 2: Add the helper script

**Files:**
- Create: `.opencode/skills/test-onboarding-flow/scripts/run-onboarding-test.sh`

**Step 1: Write the script**

The script should:
- resolve the repo root
- refuse to run if port `5173` is already serving something
- clear the known macOS dev-state locations
- clear the default orchestrator dev data dir
- execute `pnpm dev` with `VITE_VESLO_*` values blanked for the launched process

**Step 2: Make the script executable**

Run: `chmod +x .opencode/skills/test-onboarding-flow/scripts/run-onboarding-test.sh`

**Step 3: Smoke-check the script shape**

Run: `bash -n .opencode/skills/test-onboarding-flow/scripts/run-onboarding-test.sh`
Expected: no syntax errors

### Task 3: Verify and document

**Files:**
- Modify: `docs/plans/2026-03-09-onboarding-test-skill-design.md`
- Modify: `docs/plans/2026-03-09-onboarding-test-skill-implementation-plan.md`

**Step 1: Verify final contents**

Run:

```bash
rg -n "test-onboarding-flow|run-onboarding-test" .opencode/skills docs/plans
```

Expected: both docs and the new skill/script appear.

**Step 2: Review exact diff**

Run:

```bash
git diff -- docs/plans/2026-03-09-onboarding-test-skill-design.md docs/plans/2026-03-09-onboarding-test-skill-implementation-plan.md .opencode/skills/test-onboarding-flow
```

Expected: only the design/plan/skill/script changes appear.

**Step 3: Commit**

```bash
git add docs/plans/2026-03-09-onboarding-test-skill-design.md docs/plans/2026-03-09-onboarding-test-skill-implementation-plan.md .opencode/skills/test-onboarding-flow
git commit -m "docs: add onboarding test skill"
```
