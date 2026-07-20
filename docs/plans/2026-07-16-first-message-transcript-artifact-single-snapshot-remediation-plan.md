---
title: First-Message Transcript Read Coordination and Artifact Projection Remediation Plan
date: 2026-07-16
status: implementation-verified-awaiting-desktop-trace
done: false
repository_snapshot: commit 771b14377936fb624dbcfd93b63c5870b3717ecd with a dirty working tree; this plan's implementation is intentionally uncommitted alongside unrelated user changes
repository_commit: 771b14377936fb624dbcfd93b63c5870b3717ecd
related_completed_plan: docs/plans/2026-07-16-first-message-send-request-fanout-audit-and-remediation-plan.md
scope: coordinate every first-message transcript reader, remove the standalone latest-run artifact request, and preserve pagination, alias, lifecycle, and read-only contracts
---

# First-Message Transcript Read Coordination and Artifact Projection Remediation Plan

## Executive decision

Replace the timer-driven `/artifacts/latest-run` read with an optional artifact
projection on the transcript read, but do **not** treat that endpoint change as
an isolated UI fix. The implementation has three coordinated decisions:

1. The shared server transcript cache materializes one bounded **source
   snapshot** at `200` messages. Each consumer receives a view sliced to its
   requested UI limit. The normal initial UI transcript remains `140`; only
   artifact derivation sees all `200` source messages.
2. Generic sidebar prefetch is a background owner only. It must not prefetch or
   hydrate the selected, clicked, or explicitly reserved session. Selection and
   terminal recovery own that session's projection read.
3. A server artifact projection is valid only for an explicit UI projection
   scope: canonical workspace/directory identity, UI session identity,
   selection version, and expected durable run id. During a live run, locally
   derived artifacts always win.

This retains the defensive transcript fallback and the server-owned submit
contract. It removes a duplicate data-read path, not a prompt path.

## Implementation checkpoint — 2026-07-16

TRP01 through TRP06 are implemented and their automated contract coverage is
green in the current checkout. `done` deliberately remains `false`: the only
remaining completion evidence is a **fresh desktop** first-message trace with
both a controlled-cold and a warm source cache. No older trace is accepted as
evidence for that gate.

The implemented shape is the one specified below:

- the server owns one 200-message source cache and slices each response to its
  requested display limit;
- selection and terminal recovery request an optional transcript artifact
  projection instead of the render-driven artifact timer;
- a selected/reserved session is excluded from generic sidebar prefetch and
  its defensive hydration path;
- projection publication is fenced by canonical identity, selection version,
  and lifecycle run identity; and
- app and server projection trace events identify caller, display limit, source
  limit, cache outcome (server), and bounded timing without content or paths.

The full automated quality components have passed: focused app and server
contracts, both package typechecks, `check:lint`, `check:types`,
`check:architecture`, `check:unit` (including its server binary rebuild), and
`check:rust`. The exact remaining desktop-trace procedure is retained in
[Focused verification](#focused-verification).

## Why this plan exists

The first-message audit established one accepted submit and one
`prompt_async`, but found independent transcript readers after a new session is
materialized:

```text
server submit
  -> createSessionAndOpen
  -> selectSession
     -> passive transcript fallback (UI limit 140)
     -> previous app.tsx artifact timer (120 ms)
        -> standalone artifact endpoint (source limit 200)
```

The old artifact endpoint loads a transcript before deriving artifacts. The
prefetch store joins an in-flight read only when the existing limit is at least
the later limit. A `140` read followed by `200` can therefore cause two cold
source loads.

The sidebar adds a second, previously omitted owner:

```text
workspace-session-list interest
  -> Dashboard.prefetchSessionTranscripts
  -> server sidebar prefetch (default 140)
  -> shared transcript cache
```

The selected session is included in that interest today. Without coordinating
it, replacing the timer with a `200` projection request simply moves the same
`140 + 200` collision to the sidebar path.

## Verified current facts

- `workspace-session-list.tsx` reports selected and clicked sessions as
  prefetch interest; `dashboard.tsx` forwards it to
  `prefetchSessionTranscripts`.
- `session-transcript-prefetch.ts` uses default limit `140`, returns a warm
  snapshot only when its cached limit is sufficient, and joins an in-flight
  request only when `existing.limit >= requested.limit`.
- `app.tsx` immediately hydrates every snapshot returned from sidebar prefetch.
- `session-selection-controller.ts` uses `requestLimit` for pagination
  bookkeeping. Hydrating `200` messages while recording `140` would make the
  next earlier-history request incorrectly ask for `160`.
- Selection and lifecycle recovery retarget only the top-level transcript
  session id. An embedded artifact response would otherwise retain its
  OpenCode identity.
- The internal server cache type is
  `SessionTranscriptSnapshot` in `packages/server/src/session-transcript-prefetch.ts`.
  It is not the general server `types.ts` model.

## Invariants

The implementation must preserve these contracts:

1. A first send produces one accepted submit, one materialization, and one
   `prompt_async`. No transcript or artifact reader may submit, create, run,
   abort, or start an engine.
2. The initial offline/passive transcript fallback remains available. It is a
   read reliability mechanism, not duplicate send logic.
3. Normal UI pagination remains based on the returned display limit. A UI
   holding 140 messages records limit 140; a UI holding 160 records 160.
4. The server cache may contain up to 200 source messages, but background
   prefetch and normal selection do not silently hydrate 200 messages merely
   because artifact derivation needs that source window.
5. Generic sidebar prefetch can hydrate only background, unselected sessions.
   The selected/reserved session is hydrated by selection or terminal recovery.
6. A previous run's server artifacts never hide local artifacts of a newly
   accepted running run.
7. A terminal projection is published only when it belongs to the exact
   lifecycle run that completed.
8. No trace event contains prompt text, tokens, workspace paths, raw cache
   keys, session titles, or raw artifact payloads.

## Architecture

### Terms and identities

There are three identities; they must not be compared as one interchangeable
`sessionId` string:

| Identity | Owner | Meaning |
| --- | --- | --- |
| `uiSessionId` | app | The selected/sidebar session key used for UI state. |
| `conversationId` | server binding | Veslo conversation identity, if known. |
| `opencodeSessionId` | transcript store | Canonical engine transcript identity. |

The durable server identity is:

```ts
type ServerTranscriptIdentity = {
  workspaceId: string;
  directory: string | null;
  conversationId: string | null;
  opencodeSessionId: string | null;
};
```

The app wraps it in a display-only scope:

```ts
type TranscriptProjectionScope = ServerTranscriptIdentity & {
  uiSessionId: string;
  selectionVersion: number;
  expectedRunId: string | null;
};
```

`uiSessionId` is never used as proof of server identity. The app resolves the
known conversation/OpenCode aliases through the existing remembered
conversation scope, then validates returned server aliases before it publishes
the projection. If a canonical identity is unknown, the response must match the
exact route identity that initiated the read; a loose alias intersection is not
sufficient.

### One source snapshot, sliced transport views

`SessionTranscriptPrefetchStore` becomes the owner of bounded source material:

```text
all transcript consumers
  -> shared source snapshot keyed by workspace + canonical directory + OpenCode session
  -> source load limit: 200
  -> consumer view: slice to its requested display limit
```

The server cache keeps a `200`-message `SessionTranscriptSnapshot` internally.
It is intentionally still a transcript-only cache: do **not** add artifact
payloads to that cache type. The cache's existing entry and byte limits continue
to bound the larger source payload.

Add a view helper in `session-transcript-prefetch.ts` that:

1. receives a cached or newly loaded source snapshot and a requested display
   limit;
2. returns only the newest messages permitted by that display limit;
3. retains `limit: displayLimit` in the returned transport snapshot; and
4. prunes `partsByMessageId` to returned message ids.

The cache materialization limit is fixed at the existing artifact contract
maximum (`200`). Thus a background request logically asking for `140` and a
projection request logically asking for `140` both share the same single
`200` source load. This is not merely a lower-limit join heuristic; it removes
the `140 + 200` in-flight split at the source owner.

### Transcript projection HTTP contract

Extend, rather than replace, the existing route:

```text
GET /workspace/:id/sessions/:sessionId/transcript
  ?limit=<display-limit>
  &directory=<directory>
  &include=latest-run-artifacts
  &caller=passive-selection|terminal-recovery
```

`include=latest-run-artifacts` is opt-in. For a projection request the route:

1. validates the include and caller values strictly;
2. loads or joins one internal source snapshot at `200`;
3. derives `latestRunArtifacts` from all 200 source messages and their parts;
4. returns the ordinary transcript view sliced to the requested display limit
   (normally `140`); and
5. includes server aliases and directory with the artifact response.

The response contract is therefore:

```ts
type VesloSessionTranscriptSnapshot = {
  // existing UI-facing display snapshot
  workspaceId: string;
  sessionId: string;
  directory?: string;
  conversationId?: string;
  opencodeSessionId?: string;
  limit: number; // display limit, never the hidden source limit
  messages: MessageInfo[];
  partsByMessageId: Record<string, Part[]>;

  latestRunArtifacts?: VesloSessionLatestRunArtifacts & {
    directory?: string;
    conversationId?: string;
    opencodeSessionId?: string;
    runId: string | null;
  };
};
```

`latestRunArtifacts.runId` is the durable freshness fence. `null` is valid only
when the loaded source transcript has no identifiable run. The standalone
`/artifacts/latest-run` route remains temporarily compatible but the app must
have no production caller before it can be removed.

### Read ownership

| Read intent | Owner | Source limit | UI view | Projection | Hydrates selected session? |
| --- | --- | ---: | ---: | --- | --- |
| Background sidebar row | sidebar prefetch | 200 shared source | 140 | no | no |
| Selected first materialization | selection controller | 200 shared source | 140 | yes | yes, after stale guard |
| Terminal accepted run | lifecycle recovery | 200 shared source | 140 | yes | yes, after lifecycle guard |
| Load earlier history | selection controller | 200 shared source | requested 160/180/etc. | no | yes |

The sidebar must report only background rows. Before any selection begins, the
selection owner reserves its `TranscriptProjectionScope`; the sidebar interest
builder excludes every raw row that resolves to that scope's UI,
conversation, or OpenCode alias from `clicked`, `selected`, `loadedTopLevel`,
and `expandedSubagent` prefetch lists. This reservation is installed before
`selectSession`/first-materialization exposes the selected session to reactive
sidebar effects.

The hydrated prefetch client must additionally skip selected or reserved
snapshots defensively. The selection/lifecycle owner remains the sole writer of
selected transcript and projection state even if a stale background response
arrives.

### Projection store and lifecycle behavior

Create a small, testable projection state owner instead of an `app.tsx` timer
effect. Its public operations are:

```ts
reserveTranscriptProjection(scope: TranscriptProjectionScope): void;
invalidateTranscriptProjection(scope: TranscriptProjectionScope): void;
publishTranscriptProjection(
  scope: TranscriptProjectionScope,
  snapshot: VesloSessionTranscriptSnapshot,
): void;
currentTranscriptProjection(): VesloSessionLatestRunArtifacts | undefined;
```

`publishTranscriptProjection` is the only writer of server artifact display
state. It accepts a response only when all conditions hold:

1. the workspace, normalized directory, and canonical returned aliases match
   the scope;
2. the scope's `selectionVersion` is still current;
3. if `expectedRunId` is present,
   `snapshot.latestRunArtifacts?.runId === expectedRunId`; and
4. the session has no active `submitted`, `running`, `retry`, or `blocked` run.

At accepted-run admission, call `invalidateTranscriptProjection` synchronously
with the accepted run id before the UI marks the run active. The artifact
selector then always uses local `deriveArtifacts(...)` during that run.

The existing `select-session-guard.ts` is the source of the selection version;
do not add an unrelated render counter. Expose its current version from the
selection controller. Construct the lifecycle recovery controller after the
selection controller in `session.ts` so it can capture that version when a
terminal transcript read starts.

For terminal recovery, a projection with a missing or mismatching run id is
not a successful durable projection. Keep the local display, emit a bounded
`projection-run-mismatch` outcome, and use the existing terminal transcript
retry path. Never compensate by calling `/artifacts/latest-run`.

## Rejected approaches

### Keep the artifact timer and increase its debounce

Rejected. It leaves independent read owners and remains timing-dependent.

### Return 200 transcript messages to the UI just because artifacts need 200

Rejected. It breaks the current pagination contract unless every selection and
load-earlier bookkeeping path is widened. Keeping `200` internal and returning
the requested UI view is smaller and preserves behavior.

### Make only the direct projection route join a smaller 140 request

Rejected. A 140 source read does not contain the 200-message artifact window.
The shared cache instead owns one 200 source snapshot and gives each caller a
correct display view.

### Let generic sidebar prefetch hydrate the selected session

Rejected. It leaves two UI state owners and can apply a background snapshot
over a live or selection-controlled transcript.

### Add artifact data to the server prefetch cache

Rejected. Artifacts are a derived HTTP read model. Keeping the cache
transcript-only avoids cache invalidation and alias complexity for derived UI
payloads.

## Implementation slices

### TRP01 - make the server cache source/view aware

**Status:** implemented; source/view, cold/join/warm, invalidation, and
display-limit contracts are covered by focused server tests.

Owners:

- `packages/server/src/session-transcript-prefetch.ts`
- `packages/server/src/server.ts`
- `packages/server/src/tests/server-session-transcript-prefetch.test.ts`

Changes:

1. Separate the internal source limit (`200`) from each caller's display limit.
   The cache entry stores the source snapshot; `getOrLoad` and warm reads
   return sliced views.
2. Preserve the cache key as workspace + normalized directory + canonical
   OpenCode session id. Do not key cache entries by UI session id.
3. Make all in-flight consumers join the one source promise for that cache key.
   Expose an outcome of `cold`, `join`, or `warm` to the route-facing caller.
4. Keep existing cache eviction, stale TTL, invalidation, and unavailable
   diagnostics. Account cache bytes from the internal source snapshot.
5. Test controlled cold, join, and warm states with a fake clock/store. Do not
   infer cold-load count from HTTP calls.

Acceptance:

- concurrent display-140 and projection-source-200 reads make one cold
  `loadTranscript` call at 200;
- a warm 200 source cache causes zero new cold loads and returns a 140 view to
  a 140 caller;
- a 160 load-earlier caller receives `limit: 160`, 160-or-fewer messages, and
  only parts for those messages;
- cache invalidation prevents a stale source snapshot from being reused; and
- no artifact payload is stored in the internal cache type.

### TRP02 - add the projection response at the server boundary

**Status:** implemented; route projection and artifact-derived response
contracts are covered by focused server tests.

Owners:

- `packages/server/src/routes/conversations.ts`
- `packages/server/src/session-artifacts.ts`
- `packages/server/src/session-transcript-prefetch.ts`
- `packages/server/src/tests/server.conversation-session-routes.test.ts`
- `packages/server/src/tests/session-artifacts.test.ts`

Changes:

1. Parse `include=latest-run-artifacts` and the bounded projection caller.
   Unknown values are no projection; they are not a hidden feature flag.
2. Obtain one source snapshot through TRP01, derive artifacts from the full
   source snapshot, then serialize the normal display-limited transcript view.
3. Return `directory`, `conversationId`, `opencodeSessionId`, and `runId` with
   the projection. Preserve the route's current authorization, directory
   validation, and unavailable behavior.
4. Retain the standalone artifact route temporarily, but factor both endpoints
   through the same artifact derivation helper so their semantics cannot drift.
5. Do not change `packages/server/src/types.ts` for cache storage. Change the
   cache type only if TRP01 needs source/view metadata; projection remains an
   HTTP DTO field.

Acceptance:

- a projection route response makes one source-cache acquisition and no
  internal call to `/artifacts/latest-run`;
- `latestRunArtifacts.runId` equals the run derived from the full source
  snapshot, including the intentional no-run `null` case;
- its transcript payload respects the requested display limit and has a
  matching `snapshot.limit`;
- no include flag preserves the existing response shape; and
- artifact aliases/directory are present for the app validator.

### TRP03 - coordinate sidebar prefetch with selected-session ownership

**Status:** implemented; selected-session reservation, alias filtering, and
defensive background-hydration contracts are covered by focused app tests.

Owners:

- `packages/app/src/app/components/session/workspace-session-list-prefetch-interest.ts`
- `packages/app/src/app/components/session/workspace-session-list.tsx`
- `packages/app/src/app/pages/dashboard.tsx`
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/tests/components/session/workspace-session-list-prefetch.test.ts`
- `packages/app/src/app/tests/components/session/workspace-session-list-prefetch-interest.test.ts`
- `packages/app/src/app/tests/context/session-select-background-hydration.test.ts`

Changes:

1. Introduce one app-level selected-session read reservation based on
   `TranscriptProjectionScope`. Install it before a sidebar click or first
   server materialization calls `selectSession`.
2. Make the sidebar interest builder emit background-only rows. Filter the
   reserved scope's UI/conversation/OpenCode aliases out of every prefetch list,
   not merely the `selectedSessionId` field.
3. Keep 140 as the prefetch transport/display limit. The shared server source
   cache handles the 200 source window; the sidebar neither requests artifacts
   nor owns a selected-session projection.
4. In `hydratedVesloServerClient.prefetchSessionTranscripts`, skip hydration of
   a selected/reserved snapshot as a defensive second guard. Continue to
   remember safe server alias mappings for background snapshots.
5. Clear or replace reservations only on a newer selection/run fence. Do not
   clear one while its direct selection/recovery read is still in flight.

Acceptance:

- first materialization produces no generic 140 prefetch for its selected
  session, even when that session is also a visible top-level row;
- a background prefetch may hydrate an unselected row but cannot overwrite the
  selected/reserved transcript;
- selected, clicked, expanded, and loaded aliases do not reintroduce the same
  target through a second input field; and
- the selected direct projection and any surviving background timing share at
  most one cold server source load through TRP01.

### TRP04 - expose typed projection and trace options

**Status:** implemented; typed include/caller/trace options and the absence of
a production standalone-artifact caller are covered by focused app tests.

Owners:

- `packages/app/src/app/lib/veslo-server/types.ts`
- `packages/app/src/app/lib/veslo-server-domains/conversations.ts`
- `packages/app/src/app/lib/veslo-server/client.ts`
- `packages/app/src/app/context/conversation-service.ts`
- `packages/app/src/app/tests/lib/veslo-server.test.ts`
- `packages/app/src/app/tests/lib/veslo-server-session-prefetch.test.ts`
- `packages/app/src/app/tests/context/conversation-service.test.ts`

Changes:

1. Add optional `latestRunArtifacts` to the app transcript response type,
   including server directory/conversation/OpenCode aliases and `runId`.
2. Extend transcript read options with:

   ```ts
   includeLatestRunArtifacts?: boolean;
   caller?: "passive-selection" | "terminal-recovery";
   sendTraceId?: string | null;
   ```

3. Preserve existing positional facade calls for old readers. New options must
   not silently change their display limit or directory behavior.
4. Serialize `include` and caller only for projection reads. Forward
   `sendTraceId` through `x-veslo-send-trace-id`.
5. Let `getTranscriptFromVesloReadApi` request a projection only for passive
   selection and terminal recovery. Pass the active send trace for a first
   selection and the lifecycle diagnostic trace for terminal recovery when
   available.

Acceptance:

- a projection fetch has the exact include/caller query and trace header;
- an ordinary transcript fetch has no projection query/header changes;
- read registration remains passive and joins its existing workspace
  registration; and
- fetch-client tests prove zero normal-path calls to
  `/artifacts/latest-run`.

### TRP05 - publish projections through selection and lifecycle owners

**Status:** implemented; selection and terminal-recovery publication are
fenced by scope, selection version, and durable run id in focused app tests.

Owners:

- `packages/app/src/app/context/session-artifact-projection.ts` (new small owner)
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/context/session.ts`
- `packages/app/src/app/context/session-selection-controller.ts`
- `packages/app/src/app/context/session-lifecycle-recovery.ts`
- `packages/app/src/app/context/conversation-service.ts`
- `packages/app/src/app/context/session-lifecycle-recovery.test.ts`
- focused session/app tests below

Changes:

1. Delete `latestRunArtifactRefreshKey`, its 120 ms `createEffect`, and its
   direct `getSessionLatestRunArtifacts` call.
2. Introduce the projection owner described above. Its display selector checks
   canonical identity, selection version, and run fence before preferring a
   server response.
3. At accepted-run admission, reserve/invalidate projection state with the new
   run id before marking that session active. Local `deriveArtifacts` wins for
   the entire active lifecycle.
4. Add `publishTranscriptProjection(scope, snapshot)` to
   `SessionSelectionControllerDeps`. Invoke it only after the existing
   `abortIfStale` and transcript-observation checks, and after hydration uses
   the returned display `snapshot.limit` for pagination bookkeeping.
5. Expose `currentSelectionVersion()` from the existing selection controller.
   In `session.ts`, construct that controller before lifecycle recovery and
   pass the version reader into lifecycle recovery.
6. Add the explicit lifecycle callback:

   ```ts
   publishTranscriptProjection(
     scope: TranscriptProjectionScope,
     snapshot: VesloSessionTranscriptSnapshot,
   ): void;
   ```

   `recoverTerminalRun` captures the selection version before its read, checks
   the existing current-run/generation fence after it resolves, hydrates the
   canonical transcript, and then calls this callback. `session.ts` rejects a
   stale selection version before forwarding to the app projection owner.
7. Do not mutate embedded artifact identity during top-level transcript
   retargeting. Validate server aliases, then associate the response with the
   UI session only in the projection owner's wrapper scope.
8. Treat a terminal projection run mismatch as bounded recovery retry, not as
   a successful hydration and not as a second endpoint request.

Acceptance:

- a previous server projection plus a new accepted running run renders local
  artifacts and never prefers the old projection;
- a stale selection response, including A -> B -> A selection changes, cannot
  publish artifacts for the wrong selection version;
- UI session, conversation, and OpenCode aliases are accepted only when they
  resolve to one canonical server identity;
- terminal recovery publishes exactly once for a matching run and publishes
  nothing after a superseding lifecycle generation; and
- first selection records pagination from `snapshot.limit`, so a 140 display
  snapshot requests 160 next and never believes it already loaded 200.

### TRP06 - make the budget observable and prove behavior

**Status:** implemented in code and automated tests; fresh desktop cold/warm
trace evidence remains pending before this plan can be marked done.

Owners:

- `packages/server/src/routes/conversations.ts`
- `packages/server/src/session-transcript-prefetch.ts`
- `packages/app/src/app/context/conversation-service.ts`
- existing send-workflow trace tests

Changes:

1. Emit content-free projection events:

   ```text
   app:session-transcript-projection:request | settle | reject
   server:session-transcript-projection:start | settle | error
     caller: passive-selection | terminal-recovery
     traceId: send trace id or null
     displayLimit: number
     sourceLimit: 200
     cacheOutcome: cold | join | warm
     durationMs: settle/error only
   ```

2. The server route reads the existing send trace header before the cache read.
   It owns server start/settle/error events; the app owns request/settle
   events.
3. Keep trace payloads free of paths, prompts, session titles, tokens, raw
   cache keys, artifact data, and raw error messages.
4. Test three separate quantities: HTTP requests, cold source loads, and
   in-flight joins. Clear/invalidate the test cache or create a fresh store
   before asserting a cold load; warm-cache tests assert zero new cold loads.

First-message acceptance budget under a controlled cold cache:

| Work | Budget |
| --- | ---: |
| Accepted submit | 1 |
| OpenCode `prompt_async` | 1 |
| Selected-session generic sidebar prefetch | 0 |
| Passive projection HTTP read, when fallback is needed | 1 |
| Standalone `/artifacts/latest-run` HTTP read | 0 |
| Cold transcript source loads for the selected scope | 1 |
| Additional reads triggered by streamed part/count changes | 0 |

A warm-cache run may have zero cold source loads. That does not waive the
selected-prefetch exclusion or allow a standalone artifact request.

## Focused verification

Run from repository root:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/context/session-selection-controller.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/context/session-lifecycle-recovery.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts src/app/tests/lib/veslo-server.test.ts src/app/tests/components/session/workspace-session-list-prefetch.test.ts src/app/tests/components/session/workspace-session-list-prefetch-interest.test.ts

pnpm --filter veslo-server exec bun test src/tests/server.conversation-session-routes.test.ts src/tests/server-session-transcript-prefetch.test.ts src/tests/session-artifacts.test.ts

pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server typecheck
pnpm check
pnpm --filter veslo-server build:bin
```

`veslo-server` is the real package name. `@neatech/veslo-server` is invalid and
fails before server tests run.

The current checkout has passed the focused app suite (203 tests), focused
server suite (43 tests), both package typechecks, and all constituent quality
gates listed above. `check:unit` rebuilt `veslo-server` through
`check:services`; the explicit final `build:bin` command keeps the binary used
by the desktop trace current if the trace is run later.

After those checks, run one fresh content-free desktop first-message trace with
the existing send-workflow trace variables. Verify the controlled-cold budget
above, then repeat with a warm source cache to prove that the trace reports
`warm` and zero new cold loads. Do not use an older trace as evidence.

## Completion definition

Set `done: true` only when all statements are true:

- no production app caller uses the render-driven artifact timer or
  `/artifacts/latest-run`;
- all transcript consumers share the bounded 200-message source cache while
  preserving their requested UI display limits;
- selected/clicked/reserved sidebar targets are not generic prefetch or
  hydration owners;
- selection pagination uses the response display limit, not hidden source data;
- projection publication validates canonical aliases, selection version, and
  lifecycle run id;
- targeted app and server tests prove cold, join, warm, alias, pagination,
  selected-prefetch, stale-selection, and terminal-recovery behavior; and
- a fresh desktop trace proves one submit, one prompt, no standalone artifact
  read, and one selected-scope cold source load when the cache starts cold.
