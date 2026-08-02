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
   Solid reactivity and renderer-recovery DOM contracts (`check:unit`)
4. Desktop Rust format, Clippy, and tests (`check:rust`)
5. Import, cycle, route, and Veslo-header audits (`check:architecture`)

The command deliberately does not launch a desktop runtime and does not run the
full WebDriverIO desktop suite. A failed subcommand is itself the reproduction command;
do not replace it with an `--if-present`, `continue-on-error`, or auto-fix
wrapper.

## Workspace Engine Concurrency Gate

For changes to the pooled workspace engine, lifecycle ownership, queue
idempotency, or generation recovery, run the deterministic headless oracle:

```bash
pnpm --filter veslo-server build:bin
pnpm --filter veslo-orchestrator build
node packages/orchestrator/scripts/workspace-one-engine-many-conversations.integration.mjs
```

The oracle is separate from the desktop lanes. It verifies the compiled server
binary, one engine slot per workspace, ten independent conversation/session/run
identities, abort isolation, and engine-loss reconciliation to a new generation.
The generated JSON artifact under `.tmp/runtime-oracle/` is the review evidence.

For the stronger full-chain service proof, run the actual server, orchestrator,
and shipped OpenCode sidecar together:

```bash
pnpm --filter veslo-server build:bin
pnpm --filter veslo-orchestrator build
node packages/orchestrator/scripts/veslo-server-orchestrator-opencode.integration.mjs
```

This headless scenario uses only a loopback deterministic provider. It validates
real HTTP submit and queue routes, ten distinct lifecycle identities on one
workspace owner generation, abort isolation, authenticated engine-loss
notification, server terminalization, replacement generation, and recovery
through the replacement. It does not use a desktop driver or the UI. The test
intentionally runs its ephemeral OpenCode child with `VESLO_DISABLE_SANDBOX=1`;
this is not a claim that production sandbox isolation has been verified.

Run the bundled OpenCode compatibility gates as a separate non-desktop lane:

```bash
node packages/orchestrator/scripts/opencode-workspace-concurrency.integration.mjs
node packages/orchestrator/scripts/opencode-directory-scoped-skills.integration.mjs
node packages/orchestrator/scripts/opencode-directory-scoped-runtime.integration.mjs
node packages/orchestrator/scripts/opencode-directory-scoped-scaling.integration.mjs
```

The first gate uses the shipped OpenCode binary with a local deterministic
provider and verifies ten concurrent prompts plus restart-preserved session
IDs. The second records a fingerprinted Gate A/B/C capability result: directory
isolation with prompt execution, Veslo effective-view policy closure, and
explicit per-directory disposal. A passing upstream disposal observation alone
does not enable shared topology; the Veslo admission/epoch and desktop gates
remain required. These commands do not use a desktop driver.

## Required Headless Service Gate

```bash
pnpm check:services
```

This gate builds the local Veslo server and starts the same orchestrator
`start` service topology used by development, without Vite, Tauri, Solid, or
OpenCode Router. It uses an isolated profile, loopback ports, a deterministic
Node fake OpenCode process that requires the generated start-mode Basic auth
header, explicit external binaries, and
`VESLO_DISABLE_SANDBOX=1` so Windows does not select the WSL sandbox. It proves
authenticated first-submit and idempotency behavior, failure/retry boundaries,
restart durability, and managed-AI access/session-correlation boundaries
including legacy headers, stale authorization, ambiguous runs, and redacted
upstream failures. Failure output keeps sanitized service logs and traces under
the test-owned `.tmp` directory.

It does not prove renderer recovery, WebView behavior, native commands, a real
model/provider call, or the desktop child-exit lifecycle. Those remain owned by
the focused desktop recovery lane.

The lint gate covers async correctness, unused disable directives, high-signal
Solid JSX checks, and rejects React-style dependency arrays in Solid reactive
primitives. `solid/reactivity` is enforced across app source. The injected
`effect` wrapper is registered as a reactive primitive because it defaults to
`createEffect`; do not add global callback or promise APIs as
reactive-function exceptions. Browser-conditioned contract tests prove exact
rerun and disposal behavior for the highest-risk lifecycle owners.

## Required Desktop Recovery Lane

For local-host lifecycle, sidecar, desktop startup, or Tauri recovery changes,
first follow the desktop process preflight in `docs/dev/testing-playbook.md`.
The existing `pnpm check:desktop-recovery` command is legacy Pilot tooling and
is not a supported gate. Add and run a focused owned WebDriverIO scenario
before claiming desktop recovery coverage; until then, the headless service and
workspace-engine gates are the required regression proof.

## CI Contract

The `Quality` workflow publishes these stable job names on pushes and pull
requests for `main` and `dev`:

- `Quality / Static` — lint, types, and architecture checks
- `Quality / Unit` — explicit unit/contract suite
- `Quality / Services (Windows)` — headless service-runtime proof on Windows
- `Quality / Rust` — Windows Rust checks
- `Quality / Desktop recovery` — legacy lane; replace with WebDriverIO recovery proof before treating it as required
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
