---
name: skill-creator
description: Guide for creating effective Veslo skills. Use when users want to create or update user, workspace, organization, or public skills with local authoring, registry publishing, review, and materialization semantics.
---

# Veslo Registry-Aware Skill Creation

This skill is a template and checklist for creating Veslo skills. It supports one workflow with four explicit scopes, not separate scope-specific skills.

## Mandatory scope gate

Before giving path, API, install, or publishing advice, ask:

Where should this skill live: user skill, workspace skill, organization skill, or public skill?

Do not assume workspace scope. If the user has already made the scope clear, restate the scope and continue.

Scope mapping for Veslo registry proxy calls:

- User skill -> `scope: "user"`
- Workspace skill -> `scope: "workspace"`
- Organization skill -> `scope: "org"`
- Public skill -> `scope: "system"`

Registry responses may describe the same ownership as `personal`, `workspace`, `organization`, or `platform`.

## Scope behavior

- User skill: author locally for the signed-in user's global skill root, then optionally publish and install through `POST /v1/skills`, `POST /v1/skills/:skillId/versions`, and `POST /v1/skill-installations`.
- Workspace skill: author locally for the selected workspace under `.opencode/skills/<skill-name>/SKILL.md`, then optionally publish and install for that workspace or patch the workspace skill set.
- Organization skill: create the skill package and registry record, then use `POST /v1/skills/:skillId/review-requests` with `scope: "org"`. Treat it as pending organization approval until approved by an org skill admin.
- Public skill: create the skill package and registry record, then use `POST /v1/skills/:skillId/review-requests` with `scope: "system"`. Treat it as pending platform approval until approved by a platform admin.

Do not claim organization or public skills are distributed when only the local files, skill record, package version, or review request exists. Do not treat organization or public skills as immediate installs.

Locked public or required skills are data-driven by rollout policy, for example `removalPolicy: "locked"` on `POST /v1/skill-rollout-policies`; do not hardcode immutability into local files.

## Local authoring behavior

- Use a file mutation tool on the real target path instead of pasting the whole skill into chat.
- Writing a workspace skill file lets Veslo show the reload banner above the conversation so the user can activate the new skill immediately.
- Keep registry-backed materialization server-controlled. Managed workspace packages materialize under `.opencode/skills/veslo-managed/` and should not overwrite user-authored skill folders.

## Design goals

- Portable: safe to copy between machines.
- Reconstructable: can recreate any required local state.
- Self-building: can bootstrap its own config or state.
- Credential-safe: no committed secrets; graceful first-time setup.

## Recommended structure

```
<skill-root>/
  <skill-name>/
    SKILL.md
    references/
    scripts/
    assets/
```

Use `references/` for detailed APIs and domain knowledge, `scripts/` for repeatable deterministic work, and `assets/` for files copied into outputs. Do not add README or process notes unless the skill itself must consume them.

## Trigger phrases

The `description` field is how the agent decides when to use the skill. Include specific trigger phrases and the real work the skill performs.

Bad example:

```yaml
description: Use when working with content.
```

Good example:

```yaml
description: Use when users ask to create meeting minutes, "vytvor zapis ze schuzky", summarize transcript requirements, or prepare client-ready follow-up notes.
```

Quick validation:

- Contains concrete trigger phrases.
- Uses "when", "use when", or "triggers".
- Describes the output or action, not just the topic.

## Frontmatter Template

```yaml
---
name: my-skill
description: Use when users ask to "[specific phrase 1]", "[specific phrase 2]", or "[specific phrase 3]"; creates [specific output] from [specific inputs].
---
```

## Authoring Checklist

1. Confirm the target scope with the mandatory scope gate.
2. Define when the skill triggers, what inputs it expects, and what it outputs.
3. Add only resources the agent will actually use: `references/`, `scripts/`, or `assets/`.
4. Keep `SKILL.md` concise and move long API details into references.
5. Test scripts by running them and validate the final skill frontmatter.
6. For user or workspace skills, write the local skill files and then perform any requested registry install flow.
7. For organization or public skills, stop at review request unless an authorized admin explicitly approves and configures rollout.
