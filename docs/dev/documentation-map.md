# Documentation Map

This file defines where Veslo documentation lives and which documents are canonical for future coding work.

## Priority Order

When documents disagree, use this order:

1. Current shipped code
2. Durable developer docs in `docs/dev/` and `docs/features/`
3. Root product and architecture docs
4. Public docs in `packages/docs/`
5. Historical implementation material in `docs/plans/`

`docs/plans/` records design and implementation history. It is not the final source of truth for shipped behavior.

## Root Documents

- `AGENTS.md`
  Short repo-wide entry point for always-on agent guardrails and links to scoped instruction files.
- `CLAUDE.md`
  Claude Code wrapper that imports the repo-wide `AGENTS.md`.
- `README.md`
  Entry point for the repo and map of the available documentation.
- `VISION.md`
  Product intent and positioning.
- `PRINCIPLES.md`
  Decision framework and product guardrails.
- `PRODUCT.md`
  Product semantics, flows, and user-facing requirements.
- `ARCHITECTURE.md`
  Runtime model, capability model, and system-level design.
- `INFRASTRUCTURE.md`
  Operational assumptions, infra constraints, and platform capabilities.

## Scoped Instruction Files

- `packages/app/AGENTS.md` and `packages/app/CLAUDE.md`
  Shared SolidJS app-shell and UI instructions.
- `packages/desktop/AGENTS.md` and `packages/desktop/CLAUDE.md`
  Tauri runtime and desktop E2E instructions.
- `packages/server/AGENTS.md` and `packages/server/CLAUDE.md`
  Server and orchestrator integration instructions.
- `.github/copilot-instructions.md`
  Repository-wide GitHub Copilot instructions.
- `.github/instructions/*.instructions.md`
  Path-specific GitHub Copilot instructions.

## Durable Developer Docs

### `docs/dev/`

Use these for coding-agent work, implementation changes, and system maintenance.

- `docs/dev/documentation-map.md`
- `docs/dev/app-map.md`
- `docs/dev/state-and-config-reference.md`
- `docs/dev/veslo-server-app-contract.md`
- `docs/dev/testing-playbook.md`
- `docs/dev/build-and-rebuild-matrix.md`
- `docs/dev/documentation-promotion.md`

### `docs/features/`

Use these for shipped feature semantics and non-obvious runtime behavior.

- `docs/features/onboarding-and-auth.md`
- `docs/features/settings-and-preferences.md`
- `docs/features/extensions-and-integrations.md`
- `docs/features/session-runtime.md`
- `docs/features/workspace-config-and-sharing.md`
- `docs/features/soul-and-automations.md`

## Specialized Deep Dives

- `docs/desktop-updater.md`
  Dedicated updater behavior, environment limitations, and release feed mechanics.
- `docs/agents-doc/agents.md`
  Agent modes, built-in agent behavior, and agent-specific implementation details.

## Public Docs

`packages/docs/` contains public-facing or operator-facing documentation for users and adopters. Do not treat it as the primary source for internal coding behavior unless a user-facing workflow is being updated.

## Historical Docs

- `docs/plans/`
  Design docs, implementation plans, and verification artifacts.
- `docs/superpowers/`
  Superpowers-related planning and specs.
- `pr/` and `packages/app/pr/`
  PR-oriented context and one-off notes.

## Maintenance Rule

When a verified implementation changes durable behavior, configuration, runtime flow, or developer workflow:

- update an existing canonical doc in `docs/dev/`, `docs/features/`, or the relevant root doc, or
- create a new canonical doc if no durable home exists.

Use `.opencode/skills/documenting-implemented-state/SKILL.md` before claiming completion.
