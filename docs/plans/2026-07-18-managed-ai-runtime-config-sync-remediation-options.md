---
title: Managed AI Runtime Config Sync Remediation
date: 2026-07-18
status: in_progress
done: false
scope: active-workspace managed AI config reconciliation only
---

# Managed AI Runtime Config Sync Remediation

## Approved direction

The desktop app must reconcile a managed AI runtime config when its **effective
desired config** changes, while avoiding a new config read for unrelated UI,
engine, session, or lifecycle changes.

This implementation preserves explicit verification before a cold runtime
start and adds an explicit freshness revalidation for an actual send, even if
the installed config remains merely usable.

It does not change transcript, composer draft, SSE, or Den registry ownership.

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
7. Only a flight with an explicit `verified` outcome may become a completed
   active intent. A failure, authority-pending return, or stale cancellation
   must remain retryable.
8. A managed config descriptor includes the selectable-model roster and known
   capability metadata, not only its effective model.

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

Make flight completion explicit:

```ts
type ManagedAiConfigSyncOutcome =
  | { kind: "verified" }
  | { kind: "skipped-pending" }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string };
```

The current wrapper converts a rejected internal promise to a resolved caller
promise so active effects do not produce unhandled rejections. That behavior
may remain, but the wrapper must return the typed outcome internally. A stale
return after an awaited read is `cancelled`, not `verified`. An authority-pending
preflight is `skipped-pending`, not a successful completed intent.

Maintain:

```ts
const lastSuccessfulActiveIntentByScope = new Map<string, string>();
```

For `reason: "active-workspace"`, return before `getConfig` when the scope has
already completed that exact semantic intent. Populate the map only after the
current, non-cancelled flight returns `{ kind: "verified" }`. Clear or replace
the entry when a different intent becomes current; never populate it for
`skipped-pending`, `cancelled`, or `failed`.

`runtime-start` and `send-preflight` bypass this completed-intent shortcut,
but keep the existing in-flight join behavior. They are explicit freshness
boundaries, rather than accidental UI-driven polling. In particular,
send-preflight must perform its descriptor revalidation even when the current
config passes the existing *usable routing and credential* check; that check
does not validate a stale selectable-model roster.

### Boot adjustment

`context/veslo-server-connection.ts` becomes the explicit owner of the
connection-level authority state. It exposes a stable tri-state accessor:

```ts
type ManagedAiConfigAuthority =
  | { kind: "pending" }
  | { kind: "server"; workspaceConfigId: string }
  | { kind: "project-fallback"; reason: "serverless" | "unwritable" };
```

`server` is valid only when the selected server config target is known and the
server reports **both** `config.read` and `config.write`. The reconciliation
path always begins with `getConfig`, so write capability alone is insufficient.

While authority is `pending`, the active effect returns
`{ kind: "skipped-pending" }` and does not write the project fallback. Once
authority settles, it chooses one of:

- writable server config;
- confirmed project fallback.

The connection owner must not infer `project-fallback` merely from the initial
`vesloServerStatus() === "disconnected"` value. The app composition layer may
combine the connection authority with the acknowledged workspace mapping, but
must not recreate its own independent authority decision.

### Descriptor construction

The intent must derive from a deterministic, secret-free
`desiredConfigDescriptorHash`, representing the data that
`formatManagedAiAccessConfig()` would render. For a managed profile it includes
at least:

- provider ID and effective model;
- selectable models in deterministic order;
- each selectable model's capability status, attachment capability, and known
  input modalities;
- the effective server/engine route and target workspace config ID;
- hashes, never values, of the server-client and gateway credentials.

`profile.updatedAt` is not a substitute for this descriptor. It may be retained
as diagnostic provenance, but must not be the correctness mechanism that
detects roster or capability changes.

### Files and changes

- `packages/app/src/app/context/managed-ai-runtime-config.ts`
  - extract semantic intent construction from the current flight resolver;
  - return typed completion outcomes and add completed-intent tracking for
    `active-workspace` only;
  - retain the existing in-flight and stale-write maps;
  - compute a descriptor hash from rendered managed-config inputs, including
    selectable model capabilities;
  - expose the exact `reason`, outcome, descriptor hash, and authority in
    flight trace events;
  - use the connection-owned authority accessor before project fallback;
  - add descriptor revalidation to the real send-preflight path.
- `packages/app/src/app/controllers/managed-ai-config-sync.ts`
  - extend the pure preflight decision with the authority-pending branch and
    the typed outcome decision helpers.
- `packages/app/src/app/context/veslo-server-connection.ts`
  - own and expose `ManagedAiConfigAuthority`; server authority requires both
    config read and write capabilities and an acknowledged config workspace ID.
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
3. Changing model, provider routing output, token hash, config authority,
   target server workspace, selectable-model roster, or model capability causes
   exactly one new read.
4. A changed intent still prevents an older in-flight read from writing.
5. `runtime-start` and every real send-preflight revalidate even after an
   active intent was completed. A usable-but-stale model roster is repaired by
   send-preflight.
6. During local server bootstrap, no project write occurs until config
   authority is resolved; a confirmed serverless/unwritable case still uses
   the project fallback.
7. `failed`, `cancelled`, and `skipped-pending` outcomes never populate
   `lastSuccessfulActiveIntentByScope`; a later retry may run.

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
  This is intentional; runtime-start, every real send-preflight, reconnect, or
  explicit refresh are the freshness boundaries.

## Implementation status

This direction directly fixes both confirmed causes: completed identical active intents
will not re-read config, and project fallback waits for connection authority to
settle. It preserves the existing explicit startup/send checks and does not
introduce another lifecycle controller.

## Trace changes required before verification

Every config-sync flight should carry:

- `reason`: `active-workspace`, `runtime-start`, or `send-preflight`;
- a non-secret `scopeKey` and intent hash;
- `outcome`: `verified`, `skipped-pending`, `cancelled`, or `failed`;
- `decision`: `start`, `join`, `completed-intent-skip`, `read`, `write`, or
  `explicit-revalidation`;
- changed semantic input groups relative to the last observed intent;
- config authority: `pending`, `server`, or `project-fallback`.

This corrects the current ambiguity where a flight log does not reveal why its
fingerprint changed or whether it was safe to record as completed.

## Acceptance evidence

A new desktop manual run must show:

1. At most one normal active reconciliation after authority and managed access
   settle for a stable workspace/config intent.
2. No active config read during first-session materialization, ordinary stream
   updates, terminal lifecycle completion, or unrelated session UI changes.
3. One intentional read remains permitted for runtime-start or a send that
   needs config repair/revalidation; every real send has descriptor freshness
   validation even if current routing is usable.
4. No project fallback write while a local server is merely still connecting.
5. A roster/capability change at the same effective model produces one
   descriptor change and one reconciliation.
6. No regression in managed AI send, runtime bootstrap, config write, or
   stale-flight protection tests.
