---
name: skill-creator
description: Guide for creating effective Veslo skills. Use when users want to create or update user, workspace, organization, or public skills with local authoring, registry publishing, review, rollout, or materialization semantics.
---

# Veslo Registry-Aware Skill Creation

This skill guides creation and iteration of reusable Veslo skills. It combines normal skill authoring practice with Veslo's real registry, review, rollout, and local materialization model.

## Mandatory scope gate

Before giving path, API, install, or publishing advice, ask:

Where should this skill live: user skill, workspace skill, organization skill, or public skill?

Do not assume workspace scope. If the user already made the scope clear, restate it and continue.

Scope mapping for Veslo app/local proxy calls:

- User skill -> `scope: "user"`
- Workspace skill -> `scope: "workspace"`
- Organization skill -> `scope: "org"`
- Public skill -> `scope: "system"`

Registry responses may describe the same ownership as `personal`, `workspace`, `organization`, or `platform`.

Read `references/veslo-registry-workflows.md` when the user asks to publish, install, approve, distribute, lock, remove, restore, or materialize a skill through the registry.

## Veslo scope behavior

- User skill: author for the signed-in user's global skill root. A registry-backed user skill can be created with `POST /v1/skills`, versioned with `POST /v1/skills/:skillId/versions`, installed with `POST /v1/skill-installations`, and materialized with `/skills/materialization/sync-global`.
- Workspace skill: author under the selected workspace skill root, commonly `.opencode/skills/<skill-name>/SKILL.md`. Registry-backed workspace skills use the same create/version flow, then either `POST /v1/skill-installations` with a workspace target or `PATCH /v1/workspaces/:workspaceId/skill-set`.
- Organization skill: create the package and registry record, then request approval with `POST /v1/skills/:skillId/review-requests` and `scope: "org"`. The result is pending organization approval until an org skill admin approves it.
- Public skill: create the package and registry record, then request approval with `POST /v1/skills/:skillId/review-requests` and `scope: "system"`. The result is pending platform approval until a platform admin approves it.

Do not claim organization or public skills are distributed when only local files, a registry skill record, a package version, or a review request exists. Do not treat organization or public skills as immediate installs.

Locked public or required skills are data-driven by rollout policy, for example `removalPolicy: "locked"` on `POST /v1/skill-rollout-policies`; do not hardcode immutability into local files.

## About skills

Skills are modular, self-contained packages that extend an agent with specialized knowledge, workflows, tools, or bundled resources. They should contain only information the agent needs to perform the work.

Good skills provide:

- Specialized workflows for repeated tasks.
- Tool or API instructions that are easy to get wrong.
- Domain knowledge, schemas, or business rules.
- Bundled resources such as scripts, references, templates, or assets.

## Core principles

### Keep context lean

Only add context that the agent needs and is unlikely to know. Prefer short procedures and concrete examples over broad background explanations. Move detailed API notes or large domain references into `references/`.

### Match freedom to risk

- High freedom: use plain instructions when several approaches are acceptable.
- Medium freedom: use pseudocode or named patterns when consistency matters.
- Low freedom: use scripts when the operation is fragile, repetitive, or format-sensitive.

### Use progressive disclosure

Keep `SKILL.md` focused on trigger logic, workflow, and resource navigation. Put long details in files directly linked from `SKILL.md`, such as:

```
skill-name/
  SKILL.md
  references/
    api.md
    schema.md
  scripts/
    validate.py
  assets/
    template.docx
```

Avoid deeply nested reference chains. If a reference file is long, include a short table of contents at the top.

## Skill creation process

Follow these steps in order unless a step is clearly not applicable.

### 1. Understand the request

Confirm:

- The target Veslo scope from the mandatory scope gate.
- The concrete user prompts that should trigger the skill.
- The output the skill should produce.
- Any APIs, files, credentials, or permissions required.
- Whether the user wants only local authoring or also registry publishing, review, rollout, or installation.

Ask one or two focused questions if the scope or expected behavior is unclear.

### 2. Plan reusable contents

For each expected prompt, decide what the agent would otherwise rediscover or rewrite. Add:

- `references/` for schemas, API contracts, policies, examples, and domain rules.
- `scripts/` for deterministic operations that should not be rewritten each time.
- `assets/` for templates and files copied into outputs.

Do not add README, changelog, setup notes, or process documents unless the skill workflow explicitly consumes them.

### 3. Initialize or locate the skill

For a new skill, run:

```bash
scripts/init_skill.py <skill-name> --path <output-directory>
```

For an existing skill, inspect the current directory first and preserve user-owned content.

Choose the output directory from the confirmed scope:

- User skill: use the configured user skill root or prepare a registry package for a user-owned record.
- Workspace skill: use the selected workspace skill root, commonly `.opencode/skills/<skill-name>/`.
- Organization skill: author locally first, then prepare registry publish and review artifacts.
- Public skill: author locally first, then prepare registry publish and platform review artifacts.

### 4. Edit the skill

Write `SKILL.md` for another agent to use. Include:

- Frontmatter with `name` and `description`.
- A clear workflow for when the skill triggers.
- Required inputs, outputs, tools, and safety checks.
- Pointers to bundled resources and when to read or run them.
- Realistic examples only when they clarify trigger behavior or output quality.

Use imperative instructions. Keep the body concise; move detailed API or schema material into references.

Frontmatter example:

```yaml
---
name: my-skill
description: Use when users ask to "[specific phrase 1]", "[specific phrase 2]", or "[specific phrase 3]"; creates [specific output] from [specific inputs].
---
```

### 5. Validate and package

Run validation before claiming the skill is ready:

```bash
scripts/quick_validate.py <path/to/skill-folder>
```

If the skill includes scripts, run a representative script check. If the user needs a distributable package, run:

```bash
scripts/package_skill.py <path/to/skill-folder>
```

### 6. Publish or distribute only when requested

For registry-backed distribution, use the real Veslo proxy workflow from `references/veslo-registry-workflows.md`.

- User and workspace skills can be installed after create/version when the caller has the right host or owner auth.
- Organization and public skills require review before broader distribution.
- Rollout policies control distribution, update policy, and removal policy. Use `removalPolicy: "locked"` only for approved required skills.
- Local execution remains in Veslo desktop and local Veslo server; registry is catalog, package, governance, and desired-state infrastructure.

### 7. Iterate from real use

After the user uses the skill, update the smallest necessary part:

1. Identify what the agent struggled with.
2. Add or refine instructions, references, scripts, or assets.
3. Re-run validation and any relevant script checks.
4. If registry-backed, publish a new immutable version rather than changing an existing package version.
