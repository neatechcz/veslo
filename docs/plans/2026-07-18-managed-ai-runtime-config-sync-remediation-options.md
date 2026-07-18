---
title: Managed AI Runtime Config Sync Remediation Options
date: 2026-07-18
status: proposed
done: false
scope: active-workspace managed AI config reconciliation only
---

# Managed AI Runtime Config Sync Remediation Options

## Decision to make

The desktop app must reconcile a managed AI runtime config when its **effective
desired config** changes, while avoiding a new config read for unrelated UI,
engine, session, or lifecycle changes.

This document proposes two implementation paths. Both preserve explicit
verification before a cold runtime start and before a send when the current
config is unusable. They differ in how strongly they separate boot-time
server-config ownership from the project-file fallback.

No choice in this document changes transcript, composer draft, SSE, or Den
registry ownership.

## Observed behavior

The latest manual run began at `2026-07-18T19:01:44Z`.

1. Before managed access and server capabilities had settled, config sync read
   the project config.
2. Once managed access became available, it correctly wrote the new managed
   project config once.
3. Once the Veslo server became writable, it correctly read the server config
   and found it current.
4. Six later `active-workspace` flights read the same current server config and
   skipped the write. One of them took about 7.1 seconds.

The duplicate reads are not a gateway, auth, or config-content failure. They
are caused by an active Solid effect being invalidated after the prior matching
flight has settled.

## Root cause

`createManagedAiRuntimeConfigSync` has one active effect:

```ts
effect(() => {
  void syncActiveWorkspaceManagedAiConfig();
});
```

The synchronous intent resolver reads active workspace data, managed access,
server status/capabilities, resolved server workspace ID, routing, engine, and
orchestrator inputs. It therefore subscribes to all of them.

The current fingerprint is intentionally broad. It contains, among other
things, raw engine/sandbox diagnostic inputs. For a direct, non-sandboxed
runtime, a transition such as `engineChildKind: null -> "direct"` can make a
new fingerprint even when the generated runtime config is identical.

The single-flight map solves only concurrent work:

```ts
const existing = managedAiConfigSyncInFlight.get(intent.fingerprint);
if (existing) return existing.promise;
```

After the promise settles, its entry is deleted. There is no record that the
same intent has already completed successfully. A later invalidation therefore
reads the same config again.

The boot path has a second, smaller ownership issue. It treats both of these
states as project-file fallback:

- the local Veslo server has not finished connecting yet;
- the active workspace is genuinely not writable through a Veslo server.

That is why this run wrote the project config just before the server-owned
config became available.

## Required invariants

1. A changed effective config must still be reconciled exactly once per target
   workspace.
2. A stale async flight must never write after a newer desired config wins.
3. A normal active-workspace reactivity update must not re-read an already
   verified identical config.
4. `runtime-start` and `send-preflight` retain a path to revalidate config
   state, including externally changed/deleted config.
5. Project-file fallback remains available for a genuinely unavailable or
   unwritable server; it must not race a local server that is still resolving.
6. A diagnostic event must distinguish a semantic config change, a joined
   flight, a completed-intent skip, and an explicit revalidation.

## Option A — semantic completed-intent dedupe (recommended)

### Idea

Keep the present owner and asynchronous stale-write protections, but make
active reconciliation idempotent after success.

Split intent construction into a memoized *semantic desired-config intent*.
The intent includes only values that can change the target or generated
configuration:

- target app and server workspace IDs;
- chosen config source and target root;
- managed provider/profile fields actually rendered into config;
- default model only for the non-managed branch;
- resolved server and engine URLs that are actually emitted;
- server-client and gateway-token hashes;
- explicit config authority/capability state.

Do not include raw engine, orchestrator, or diagnostic fields once their
effective route is already represented. For example, with
`requiresEngineBaseUrl === false`, a direct-engine lifecycle update must not
be an independent config input.

Maintain:

```ts
const lastSuccessfulActiveIntentByScope = new Map<string, string>();
```

For `reason: "active-workspace"`, return before `getConfig` when the scope has
already completed that exact semantic intent. Populate the map only after the
current, non-cancelled flight completed its read/decision/write successfully.
Clear or replace the entry when a different intent becomes current.

`runtime-start` and `send-preflight` bypass this completed-intent shortcut,
but keep the existing in-flight join behavior. They are explicit freshness
boundaries, rather than accidental UI-driven polling.

### Boot adjustment

Add a narrow preflight result such as `server-config-authority-pending`.
While a local Veslo server probe/capability resolution is still unresolved,
the active effect does not write the project fallback. Once authority settles,
it chooses one of:

- writable server config;
- confirmed project fallback.

This needs one explicit connection-readiness accessor from the connection
owner. It must not infer "unavailable" merely from the initial
`vesloServerStatus() === "disconnected"` value.

### Files and changes

- `packages/app/src/app/context/managed-ai-runtime-config.ts`
  - extract semantic intent construction from the current flight resolver;
  - add completed-intent tracking for `active-workspace` only;
  - retain the existing in-flight and stale-write maps;
  - expose the exact `reason` in flight trace events;
  - use a resolved config-authority preflight before project fallback.
- `packages/app/src/app/controllers/managed-ai-config-sync.ts`
  - extend the pure preflight decision with the authority-pending branch.
- `packages/app/src/app/app.tsx`
  - pass the single connection-authority readiness accessor; do not add a
    second config owner or a UI-level timer.
- `packages/app/src/app/tests/context/managed-ai-runtime-config.test.ts`
  - update the old sequential-read expectation to the new active-effect
    contract and add real Solid reactivity coverage.

### Tests

1. Two sequential active syncs with the same completed semantic intent cause
   one `getConfig` call, not two.
2. Changing only an engine object from absent to direct, while the effective
   emitted routes are unchanged, causes no second active read.
3. Changing model, provider routing output, token hash, config authority, or
   target server workspace causes exactly one new read.
4. A changed intent still prevents an older in-flight read from writing.
5. `runtime-start` and a send repair path revalidate even after an active
   intent was completed.
6. During local server bootstrap, no project write occurs until config
   authority is resolved; a confirmed serverless/unwritable case still uses
   the project fallback.

### Benefits

- Smallest ownership-respecting change.
- Removes the measured redundant reads without a timer, debounce, or polling
  policy.
- Keeps the existing recovery behavior at explicit runtime/send boundaries.
- Makes the future trace attributable.

### Risks

- The semantic intent must be derived from actual config output, not merely a
  shortened version of the current broad fingerprint.
- An external config edit is not discovered by unrelated UI state changes.
  This is intentional; runtime-start, send validation, reconnect, or explicit
  refresh are the freshness boundaries.

## Option B — explicit config-reconciliation state machine

### Idea

Replace the ambient active effect with a workspace-scoped controller whose
inputs are explicit events:

- config authority resolved or changed;
- managed access semantic profile changed;
- selected/default model changed;
- provider routing output changed;
- explicit runtime-start;
- explicit send-preflight;
- explicit reconnect or user refresh.

Each workspace has a state similar to:

```ts
type ReconciliationState =
  | { phase: "authority-pending" }
  | { phase: "dirty"; intent: SemanticConfigIntent }
  | { phase: "syncing"; intent: SemanticConfigIntent }
  | { phase: "verified"; intent: SemanticConfigIntent }
  | { phase: "failed"; intent: SemanticConfigIntent; error: string };
```

The controller accepts `request(intent, freshness)` and decides whether to
join, skip a verified equivalent intent, or read/reconcile. It owns all
per-workspace generations, cancellation, successful checkpoints, and trace
provenance. `app.tsx` only translates its existing owner events into controller
requests.

### Files and changes

- New `packages/app/src/app/controllers/managed-ai-config-reconciliation.ts`
  - pure transition helpers for request/join/skip/complete/fail;
  - no network and no Solid imports.
- `packages/app/src/app/context/managed-ai-runtime-config.ts`
  - becomes the I/O adapter around the controller;
  - removes broad implicit config-sync tracking from its active effect;
  - retains formatting, read/patch, and stale-write guards.
- `packages/app/src/app/app.tsx`
  - emits explicit semantic invalidations from the existing workspace, access,
    and server connection owners.
- Focused controller and context tests.

### Tests

All Option A behavior tests apply, plus:

1. Interleaved authority/profile/routing changes collapse to the latest intent
   for one workspace without losing another workspace's pending sync.
2. A reconnect marks only its affected workspace route dirty.
3. A failed sync remains retryable without treating an old verified intent as
   current.
4. An explicit send request may demand freshness while an active request may
   accept a verified equivalent config.

### Benefits

- Strongest ownership boundary and best observability.
- Removes accidental subscriptions from the config owner entirely.
- Better long-term fit if config reconciliation expands to multi-workspace,
  offline, or user-edit conflict handling.

### Risks

- Materially larger refactor with more migration surface.
- Easy to duplicate existing runtime-start and send-readiness policy unless
  the controller's request API is kept very narrow.
- Not justified solely by the currently measured duplicate reads.

## Recommendation

Implement **Option A** first.

It directly fixes both confirmed causes: completed identical active intents
will not re-read config, and project fallback waits for connection authority to
settle. It preserves the existing explicit startup/send checks and does not
introduce another lifecycle controller.

Consider Option B only if Option A's follow-up trace still shows meaningful
config-sync requests whose semantic intent is unchanged, or if the product
needs first-class multi-workspace reconciliation state.

## Trace changes required before verification

Every config-sync flight should carry:

- `reason`: `active-workspace`, `runtime-start`, or `send-preflight`;
- a non-secret `scopeKey` and intent hash;
- `decision`: `start`, `join`, `completed-intent-skip`, `read`, `write`, or
  `explicit-revalidation`;
- changed semantic input groups relative to the last observed intent;
- config authority: `pending`, `server`, or `project-fallback`.

This corrects the current ambiguity where `runtime-start` is labelled as an
`active-effect` caller and a flight log does not reveal why its fingerprint
changed.

## Acceptance evidence

A new desktop manual run must show:

1. At most one normal active reconciliation after authority and managed access
   settle for a stable workspace/config intent.
2. No active config read during first-session materialization, ordinary stream
   updates, terminal lifecycle completion, or unrelated session UI changes.
3. One intentional read remains permitted for runtime-start or a send that
   needs config repair/revalidation.
4. No project fallback write while a local server is merely still connecting.
5. No regression in managed AI send, runtime bootstrap, config write, or
   stale-flight protection tests.
