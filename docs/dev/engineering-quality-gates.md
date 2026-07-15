# Engineering Quality Gates

This document is the canonical contract for routine engineering verification.
It describes implemented repository commands. GitHub branch protection and
monitoring administration remain external configuration, not a property of a
Markdown file.

## Required Local Gate

Run this from the repository root for a normal source-code handoff:

```bash
pnpm check
```

`pnpm check` is fail-fast and non-writing. It runs, in order:

1. Type-aware app lint (`check:lint`)
2. Typecheck coverage plus every workspace typecheck (`check:types`)
3. The explicit stable unit/contract set, including the browser-conditioned
   Solid reactivity contract (`check:unit`)
4. Desktop Rust format, Clippy, and tests (`check:rust`)
5. Import, cycle, route, and Veslo-header audits (`check:architecture`)

The command deliberately does not launch a desktop runtime and does not run the
full Tauri Pilot suite. A failed subcommand is itself the reproduction command;
do not replace it with an `--if-present`, `continue-on-error`, or auto-fix
wrapper.

The lint gate covers async correctness, unused disable directives, the
high-signal Solid JSX checks, and rejects React-style dependency arrays in
Solid reactive primitives. General Solid reactivity remains a visible
remediation item rather than a warning budget: it is not enabled as a required
rule until its existing findings are fixed owner by owner.

## Required Desktop Recovery Lane

For local-host lifecycle, sidecar, desktop startup, or Tauri recovery changes,
first follow the desktop process preflight in
`docs/dev/testing-playbook.md`, then run:

```bash
pnpm check:desktop-recovery
```

This builds the debug E2E desktop binary and runs only the focused VSLO-235
child-exit scenario against a fresh isolated profile. It proves the sequence
ready, owned child exit, `exited/child_exited`, explicit restart, and healthy
host. It is intentionally separate from `pnpm check` because it launches the
real desktop application.

## CI Contract

The `Quality` workflow publishes these stable job names on pushes and pull
requests for `main` and `dev`:

- `Quality / Static` — lint, types, and architecture checks
- `Quality / Unit` — explicit unit/contract suite
- `Quality / Rust` — Windows Rust checks
- `Quality / Desktop recovery` — Windows focused Tauri recovery proof
- `Quality / Gate` — aggregate that fails unless every previous job succeeds

The workflow uses the same repository commands as local verification, frozen
dependencies, and cancellation for superseded pull-request runs. Repository
administrators must separately require only `Quality / Gate` for both `main`
and `dev` and verify it with a real blocked pull request. Do not claim branch
protection is enabled solely because the workflow exists.

## Release Diagnostics Gate

For release workflow changes, run:

```bash
pnpm release:review --strict
```

Publishing workflows enable the release-only source-map pipeline. It creates a
single hidden-map frontend build, injects debug IDs, uploads the matching maps,
removes maps and source-map references, and only then packages Tauri. Missing
upload credentials or a failed upload blocks a publishing workflow. Manual
ad-hoc builds remain map-free unless the release-only switch is explicitly set.

See `docs/dev/state-and-config-reference.md` for release-owned variables and
`docs/dev/veslo-application-logs.md` for safe monitoring evidence. The manual
staging workflow has an opt-in compile-time renderer canary; its external event
inspection and alert-delivery drill still require authorized monitoring
configuration and are not replaced by local source-map tests.

## Report-Only Debt

These reports are useful but are not merge gates in this rollout:

```bash
pnpm audit:knip
pnpm audit:knip:strict
```

Do not turn existing report debt into a required check through a broad ignore
list or a generated baseline snapshot. Fix a bounded owner surface first, then
promote its rule in a separate change.
