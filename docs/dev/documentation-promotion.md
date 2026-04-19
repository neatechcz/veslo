# Documentation Promotion

This document defines how implementation knowledge becomes durable documentation.

## Goal

Keep shipped behavior documented in stable reference docs instead of leaving it only in plans, PR notes, or code comments.

## Promotion Rule

When a verified implementation changes durable behavior, configuration, runtime flow, or developer workflow:

1. update an existing canonical doc, or
2. create a new canonical doc under `docs/dev/` or `docs/features/`

Do not stop at updating `docs/plans/*`.

## What Is Not Canonical

- `docs/plans/*`
- `pr/*`
- `packages/app/pr/*`
- ad hoc review notes

Those files explain history. They do not define the new steady state.

## Promotion Checklist

- Did the shipped behavior change?
- Did persistence or config semantics change?
- Did testing, rebuild, or verification workflow change?
- Did the UI expose a new surface that future coding agents must know?
- Did old docs become misleading after the change?

If any answer is yes, durable docs must be updated.

## Where to Promote

- `docs/dev/`
  For coding-agent workflows, source-of-truth maps, runtime contracts, persistence, rebuild rules, and testing guidance.
- `docs/features/`
  For shipped feature semantics and non-obvious behavior.
- root docs
  For repo-wide rules or product-wide semantics.
- `packages/docs/`
  Only when user-facing public docs changed.

## Writing Rule

Document the current steady state, not the story of how the implementation evolved.

Prefer:

- current behavior
- current config location
- current limitations
- current verification rules

Avoid:

- speculative future behavior
- stale design alternatives
- implementation diary prose

## Enforcement

Use `.opencode/skills/documenting-implemented-state/SKILL.md` before claiming completion for features and bugfixes.
