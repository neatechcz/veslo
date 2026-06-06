# Registry-Aware Skill Creator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update Veslo's installable and internal skill-creator guidance so skill creation uses the real Veslo user/workspace/organization/public registry workflows instead of assuming workspace-local output.

**Architecture:** Keep one `skill-creator` entrypoint. Add a required scope gate, shared authoring workflow, and scope-specific API workflows. Update both the user-installable skill template and the internal delegated skill creator pack, then update the hidden subagent instruction so it no longer blocks organization/public skill creation.

**Tech Stack:** Markdown skill packages, TypeScript source-contract tests, Bun server tests, Node app unit tests, Veslo server build and binary build.

---

### Task 1: Add Contract Tests For Registry-Aware Skill Creator Guidance

**Files:**
- Create: `packages/app/src/app/data/skill-creator-contract.test.ts`
- Modify: `packages/server/src/internal-system.test.ts`

**Step 1: Add the app template contract test**

Create `packages/app/src/app/data/skill-creator-contract.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const template = readFileSync(new URL("./skill-creator.md", import.meta.url), "utf8");

test("installable skill creator requires an explicit Veslo skill scope", () => {
  assert.match(template, /Where should this skill live: user skill, workspace skill, organization skill, or public skill\?/);
  assert.match(template, /Do not assume workspace scope/);
  assert.match(template, /User skill -> `scope: "user"`/);
  assert.match(template, /Workspace skill -> `scope: "workspace"`/);
  assert.match(template, /Organization skill -> `scope: "org"`/);
  assert.match(template, /Public skill -> `scope: "system"`/);
  assert.match(template, /POST \/v1\/skills/);
  assert.match(template, /POST \/v1\/skills\/:skillId\/versions/);
  assert.match(template, /POST \/v1\/skills\/:skillId\/review-requests/);
  assert.match(template, /removalPolicy: "locked"/);
});

test("installable skill creator does not describe organization or public skills as immediate installs", () => {
  assert.match(template, /Do not claim organization or public skills are distributed/);
  assert.doesNotMatch(template, /only in this workspace/);
  assert.doesNotMatch(template, /workspace-only/);
});
```

**Step 2: Extend the internal-system provisioning test**

In the existing "writes internal packs, hidden agents, managed routing block, and manifest" test, read the provisioned internal skill-creator pack and hidden subagent:

```ts
const skillCreatorSkill = await readFile(
  join(workspaceRoot, ".opencode", "veslo", "internal", "skill-creator", "SKILL.md"),
  "utf8",
);
expect(skillCreatorSkill).toContain("Veslo Registry-Aware Skill Creation");
expect(skillCreatorSkill).toContain("Where should this skill live: user skill, workspace skill, organization skill, or public skill?");
expect(skillCreatorSkill).toContain('scope: "system"');
expect(skillCreatorSkill).toContain('removalPolicy: "locked"');

const skillCreatorSubagent = await readFile(
  join(workspaceRoot, ".opencode", "agents", "veslo-internal-skill-creator.md"),
  "utf8",
);
expect(skillCreatorSubagent).toContain("Do not assume workspace scope");
expect(skillCreatorSubagent).toContain("organization skill");
expect(skillCreatorSubagent).toContain("public skill");
expect(skillCreatorSubagent).not.toContain("Create or update skills only in this workspace");
expect(skillCreatorSubagent).not.toContain("Do not write company-global/shared skills in this flow");
```

**Step 3: Run tests and confirm they fail**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- src/app/data/skill-creator-contract.test.ts
pnpm --filter veslo-server test -- internal-system
```

Expected:
- App test fails because the installable template is still workspace-oriented.
- Server test fails because the internal pack/subagent still contains workspace-only restrictions.

**Step 4: Commit**

Do not commit yet if tests were not run or did not fail for the expected reason. Otherwise:

```bash
git add packages/app/src/app/data/skill-creator-contract.test.ts packages/server/src/internal-system.test.ts
git commit -m "test: cover registry-aware skill creator guidance"
```

### Task 2: Update The Installable Skill-Creator Template

**Files:**
- Modify: `packages/app/src/app/data/skill-creator.md`

**Step 1: Replace the workspace-only model**

Rewrite the template so it keeps the useful concise guidance but changes the model:

```md
# Skill Creator

This skill creates or updates Veslo skills through the real Veslo skill model.

## Veslo Registry-Aware Skill Creation

Before creating or updating a skill, determine the target scope.

If the user did not explicitly choose a scope, ask exactly one question and wait:

> Where should this skill live: user skill, workspace skill, organization skill, or public skill?

Do not assume workspace scope.

Use product terms in user-facing text:
- user skill
- workspace skill
- organization skill
- public skill

Use API scopes only when describing or calling the API:
- User skill -> `scope: "user"`
- Workspace skill -> `scope: "workspace"`
- Organization skill -> `scope: "org"`
- Public skill -> `scope: "system"`
```

Keep the existing trigger and frontmatter guidance, but remove wording that says the skill is only a workspace template.

**Step 2: Add real API workflows**

Add a compact API workflow section:

```md
## API Workflows

User skill:
1. Create or update a package-ready skill directory.
2. Create registry skill with `scope: "user"`.
3. Create skill version with `POST /v1/skills/:skillId/versions`.
4. Create user installation with `POST /v1/skill-installations`.
5. Trigger or report `POST /skills/materialization/sync-global`.

Workspace skill:
1. Create or update a package-ready skill directory.
2. Create registry skill with `scope: "workspace"` and `workspaceId`.
3. Create skill version.
4. Create workspace installation or update `PATCH /v1/workspaces/:workspaceId/skill-set`.
5. Trigger or report `POST /workspace/:id/skills/materialization/sync`.

Organization skill:
1. Create or update a package-ready skill directory.
2. Create registry skill with `scope: "org"` and `orgId`.
3. Create skill version.
4. Create review request with `POST /v1/skills/:skillId/review-requests` and `scope: "org"`.
5. Report pending organization approval.

Public skill:
1. Create or update a package-ready skill directory.
2. Create registry skill with `scope: "system"`.
3. Create skill version.
4. Create review request with `scope: "system"`.
5. Report pending platform approval.
```

**Step 3: Add locking and honesty guardrails**

Add:

```md
## Public Skill Locking

Public/platform skills use immutable package versions. A platform rollout can use `removalPolicy: "locked"` so normal users cannot remove the managed rollout. Platform admins can still publish future versions or change rollout policy.

## Reporting Rules

Do not claim organization or public skills are distributed until approval and a separate installation, rollout policy, or workspace skill-set sync applies them.

If registry configuration or required permissions are missing, report the block. Do not pretend the skill was published or installed.
```

**Step 4: Run the app contract test**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- src/app/data/skill-creator-contract.test.ts
```

Expected: pass.

**Step 5: Commit**

```bash
git add packages/app/src/app/data/skill-creator.md packages/app/src/app/data/skill-creator-contract.test.ts
git commit -m "feat: make installable skill creator registry-aware"
```

### Task 3: Update The Internal Skill-Creator Pack

**Files:**
- Modify: `internal/veslo-internal-packs/skill-creator/SKILL.md`
- Create: `internal/veslo-internal-packs/skill-creator/references/veslo-registry-workflows.md`

**Step 1: Add a router section to SKILL.md**

Near the beginning of the internal pack, add:

```md
## Veslo Registry-Aware Skill Creation

Before creating or updating a skill, determine the target scope. If scope is missing, ask exactly one question and wait:

> Where should this skill live: user skill, workspace skill, organization skill, or public skill?

Do not assume workspace scope.

Follow the shared skill authoring process in this file. For Veslo-specific registry API workflows, read `references/veslo-registry-workflows.md` after the target scope is known.
```

**Step 2: Add the scope reference**

Create `references/veslo-registry-workflows.md` with:

```md
# Veslo Registry Workflows

## Mapping

- User skill -> `scope: "user"` / visibility `personal`
- Workspace skill -> `scope: "workspace"` / visibility `workspace`
- Organization skill -> `scope: "org"` / visibility `organization`
- Public skill -> `scope: "system"` / visibility `platform`

## Real API Surface

- `POST /v1/skills`
- `POST /v1/skills/:skillId/versions`
- `POST /v1/skill-installations`
- `PATCH /v1/workspaces/:workspaceId/skill-set`
- `POST /v1/skills/:skillId/review-requests`
- `POST /v1/skill-rollout-policies`
- `POST /skills/materialization/sync-global`
- `POST /workspace/:id/skills/materialization/sync`

## Workflows

[Copy the four scope workflows from the approved design document, including public skill locking and reporting rules.]
```

Use exact text from the approved design for the four workflows so the internal delegated agent has enough context without bloating the top-level `SKILL.md`.

**Step 3: Remove obsolete workspace-only guidance**

Update old wording that says new skills should always be created in a workspace path. Replace it with:

```md
Create local files only for the chosen scope or as an explicit local authoring draft. User, organization, and public workflows must not be silently downgraded to workspace-local files.
```

**Step 4: Validate the internal skill**

Run:

```bash
python3 internal/veslo-internal-packs/skill-creator/scripts/quick_validate.py internal/veslo-internal-packs/skill-creator
```

Expected: `Skill is valid!`

**Step 5: Commit**

```bash
git add internal/veslo-internal-packs/skill-creator/SKILL.md internal/veslo-internal-packs/skill-creator/references/veslo-registry-workflows.md
git commit -m "feat: teach internal skill creator Veslo registry scopes"
```

### Task 4: Update Hidden Internal Skill-Creator Agent Instructions

**Files:**
- Modify: `packages/server/src/internal-system.ts`

**Step 1: Update the internal skill-creator agent document**

Replace the workspace-only rules:

```md
- Create or update skills only in this workspace at `.opencode/skills/<name>/SKILL.md`.
- Do not write company-global/shared skills in this flow.
```

with:

```md
- Do not assume workspace scope. If the user did not choose a target, ask whether this should be a user skill, workspace skill, organization skill, or public skill.
- Use `.opencode/veslo/internal/skill-creator/SKILL.md` and its Veslo registry workflow reference before creating files.
- Create workspace-local files only when the user chooses workspace scope or explicitly asks for a local draft.
- For user, organization, and public skills, follow the real Veslo registry workflow and report missing registry configuration or permissions instead of silently writing workspace-only files.
- Do not claim organization or public skills are distributed until approval and installation, rollout, or workspace skill-set sync succeeds.
```

**Step 2: Bump the internal system version**

Change `INTERNAL_SYSTEM_VERSION` to a new dated value, for example:

```ts
export const INTERNAL_SYSTEM_VERSION = "2026-06-05.1";
```

This makes existing workspaces refresh the managed internal skill pack and hidden subagent.

**Step 3: Run the server test**

Run:

```bash
pnpm --filter veslo-server test -- internal-system
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/server/src/internal-system.ts packages/server/src/internal-system.test.ts
git commit -m "feat: route internal skill creator by Veslo skill scope"
```

### Task 5: Final Verification And Server Binary Rebuild

**Files:**
- No source edits unless verification finds a real issue.

**Step 1: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- src/app/data/skill-creator-contract.test.ts
pnpm --filter veslo-server test -- internal-system
```

Expected: pass.

**Step 2: Run type/build checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server build
```

Expected: pass.

**Step 3: Rebuild the Veslo server binary**

Because this plan changes `packages/server/src`, run:

```bash
pnpm --filter veslo-server build:bin
```

Expected: `dist/bin/veslo-server` is rebuilt successfully.

**Step 4: Check git status**

Run:

```bash
git status --short
```

Expected: only intentional files are modified. Do not revert unrelated pre-existing changes.

**Step 5: Final commit if verification required fixups**

If verification caused small fixups, commit them:

```bash
git add <fixed-files>
git commit -m "fix: complete registry-aware skill creator verification"
```

Otherwise no final commit is needed.

## Execution Choice

Plan complete and saved to `docs/plans/2026-06-05-registry-aware-skill-creator-implementation-plan.md`.

Two execution options:

1. **Subagent-Driven (this session)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Parallel Session (separate)** - open a new session with executing-plans, batch execution with checkpoints.

Which approach?
