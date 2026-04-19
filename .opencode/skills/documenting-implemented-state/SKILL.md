---
name: documenting-implemented-state
description: Use when a verified feature or bugfix changed behavior, configuration, runtime flow, or developer workflow in this repository and durable developer docs must be updated before claiming completion
---

# Documenting Implemented State

## Overview

Keep durable developer documentation aligned with shipped code. Use this after implementation and fresh verification, before claiming the work is complete.

## When to Use

- A feature or bugfix changed real behavior, not just code structure.
- A config surface, persistence rule, or runtime flow changed.
- A testing, rebuild, or verification workflow changed for future agents.
- A previously undocumented app surface is now important enough to become canonical.

Do not use when:

- The change is a pure refactor with no durable behavior or workflow impact.
- The only documentation touched would be temporary planning notes.

## Quick Use

1. Read the verified diff and the fresh verification evidence.
2. Classify the doc impact:
   - feature behavior
   - config or persistence
   - onboarding, auth, or runtime flow
   - testing, rebuild, or debugging workflow
   - no durable doc impact
3. Update the smallest canonical document that future coding agents should trust.
4. If no canonical document exists, create one under `docs/dev/` or `docs/features/`.
5. In the final summary, state which durable docs changed, or explicitly state why no durable doc update was needed.

## Canonical Targets

- Root product and architecture docs:
  - `AGENTS.md`
  - `README.md`
  - `PRODUCT.md`
  - `ARCHITECTURE.md`
  - `INFRASTRUCTURE.md`
- Durable developer reference:
  - `docs/dev/*.md`
  - `docs/features/*.md`
  - `docs/desktop-updater.md`
- Public docs only when the shipped user-facing workflow changed:
  - `packages/docs/*.mdx`
  - `packages/docs/tutorials/*.mdx`

## Decision Rules

- Prefer updating one existing canonical document over scattering the same fact across many files.
- Treat `docs/plans/*` as implementation history, not source of truth for shipped behavior.
- Do not document planned or aspirational behavior as if it already shipped.
- If code and docs disagree, update docs to match the verified code, not the old plan.
- If the repo lacks a durable home for an important behavior, create a focused new doc instead of burying it in a long plan file.

## What to Capture

- The behavior that now exists.
- The scope of the setting, config key, or workflow.
- Where the state is stored or resolved from, if that matters for future coding work.
- Any reload, restart, rebuild, or verification requirement that future agents must know.
- Any important non-obvious limitation, fallback, or guardrail.

## Common Mistakes

- Updating only `docs/plans/*` and leaving canonical docs stale.
- Writing a changelog instead of documenting the new steady state.
- Duplicating the same fact in multiple files without a clear source of truth.
- Skipping docs because the implementation “looks obvious” in code.
- Claiming completion without stating whether durable docs changed.

## Final Gate

Before claiming completion, be able to say one of these two things truthfully:

- `Updated durable docs:` followed by the canonical files changed.
- `No durable docs impact:` followed by a concrete reason.
