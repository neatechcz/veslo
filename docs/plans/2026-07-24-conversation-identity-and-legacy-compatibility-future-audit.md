---
title: Conversation Identity, Labels, and Legacy Compatibility Future Audit
date: 2026-07-24
status: proposed
done: false
scope: future hardening of workspace, conversation, OpenCode-session, run, event, and display-label identities
depends_on:
  - docs/dev/opencode-workspace-runtime-architecture.md
  - docs/plans/2026-07-22-one-workspace-one-engine-many-conversations-plan.md
  - docs/plans/2026-07-23-opencode-one-process-multi-workspace-skills-plan.md
---

# Conversation Identity, Labels, and Legacy Compatibility Future Audit

## Status and decision

This is a future-hardening audit, not an immediate implementation task. The
current runtime has no evidence that equal workspace or conversation labels
can merge conversations, route a prompt to a different engine, or mix
transcripts. Labels are display metadata; the durable server, queue, and UI
selection paths use scoped identifiers.

The audit nevertheless found terminology and compatibility debt worth
addressing before a directory-scoped shared-engine topology becomes a normal
production option. The work must remain backwards compatible with existing
workspaces, OpenCode sessions, stored transcripts, queued runs, UI route keys,
and older event envelopes.

Do not schedule this work merely because two conversations display the same
title. Schedule it when Veslo needs stronger cross-process collision handling,
when the shared-directory topology moves beyond capability-gated use, or when
the public conversation API is versioned.

## Audit verdict

### What is safe today

- A workspace display name is not a workspace identity.
- A conversation title, slug, or sidebar text is not a conversation identity.
- A process PID is not a conversation or engine-generation identity.
- A Veslo conversation binding is scoped by workspace and directory before it
  resolves an OpenCode session.
- UI conversation and sidebar row keys contain durable scope information; they
  do not key by title.
- Queue records, run records, and idempotency records use dedicated IDs rather
  than a session title or a process label.
- `engineOwnerId` is generated for a process generation. Two pooled engines
  therefore do not share process ownership merely because their workspaces or
  labels are similar.
- Duplicate raw OpenCode session IDs are intentionally supported in durable
  binding, transcript-prefetch, sidebar, and navigation paths when their
  workspace or directory scope differs.

Equal titles are therefore expected and safe for routing. They can still be a
user-experience ambiguity if two visible rows have the same title, but that is
not an identity collision.

### Future problems to address

1. One OpenCode session identity has four names across layers:
   `sessionID` in OpenCode event DTOs, generic `sessionId` in UI flow code,
   `opencodeSessionId` in public Veslo contracts, and `engineSessionId` in
   server/orchestrator persistence. The meanings overlap too much for a
   multi-engine system.

2. The live event-stream pin currently treats raw OpenCode session ID as the
   key for a workspace binding. It fails closed if that raw value later appears
   on another workspace. This prevents a cross-workspace leak, but a synthetic
   collision between two independent OpenCode processes would suppress the
   second stream instead of allowing two separately scoped sessions.

3. The submit contract accepts both `conversationId` and
   `opencodeSessionId`, but the execution target is selected from the
   conversation ID when both are present. A stale or mismatched second field
   should be rejected explicitly rather than silently ignored.

4. Workspace identity has intentional migration aliases: server registry ID,
   app-local ID, and deterministic local-path ID. This is necessary for old
   installs, but it needs one documented canonicalization and migration rule.

5. Older UI state can contain an unscoped raw session ID. It is only safe to
   recover when it resolves to exactly one scoped conversation. Ambiguity must
   not fall back to the currently active workspace.

## Target vocabulary

The following names are the target public and cross-layer contract. Existing
wire fields are retained until a separately approved deprecation window ends.

| Concept | Target field/name | Lifetime | Identity rule | Never use as |
| --- | --- | --- | --- | --- |
| Workspace | `workspaceId` | registry lifetime | server-authoritative canonical ID | display name or path label |
| Workspace root | `workspaceRoot` | registry lifetime | canonical authorized host path | OpenCode request directory |
| Directory instance | `directoryInstanceKey` | engine-side directory lifetime | canonical engine-side directory | workspace label or process ID |
| Directory freshness | `directoryInstanceEpoch` | directory-instance generation | increments after scoped disposal/reload | process generation |
| Veslo conversation | `conversationId` | durable conversation lifetime | bound to workspace + directory + OpenCode session | OpenCode session ID |
| OpenCode session | `opencodeSessionId` | upstream session lifetime | pinned to its creation directory | UI row key by itself |
| Run | `runId` | one accepted execution | server-generated run lifecycle ID | queue item or process ID |
| Client send attempt | `clientMessageId` | app/server retry window | idempotency key scoped by workspace | OpenCode message ID |
| Queue item | `queueItemId` | queued work item lifetime | queue-record identity | run ID |
| Engine generation | `engineOwnerId` | one OpenCode process generation | opaque owner token plus PID/start metadata | workspace or conversation ID |
| Display text | `workspaceLabel`, `conversationTitle` | mutable presentation lifetime | non-unique metadata | database, route, map, or event key |

`sessionID` is allowed only at the OpenCode adapter boundary because it is the
upstream DTO spelling. `engineSessionId` is a legacy persistence/internal
alias for `opencodeSessionId`; new cross-layer APIs must not introduce it.
Generic `sessionId` is allowed only where the type explicitly means a UI row
or an already-scoped session reference.

## Required identity graph

```text
workspaceId + workspaceRoot
  -> directoryInstanceKey + directoryInstanceEpoch
      -> conversationId <-> opencodeSessionId
          -> runId
              -> engineOwnerId

clientMessageId --idempotency--> one accepted run or queue item
queueItemId -------------------> one queued record / reserved run

workspaceLabel and conversationTitle are display-only side data.
```

In pooled mode, one `engineOwnerId` normally serves one workspace. In a future
shared-directory mode, one `engineOwnerId` can serve multiple directory
instances. Neither topology changes conversation identity.

## Backwards-compatible migration rules

### 1. Preserve all existing durable IDs

Do not rehash, regenerate, or rename persisted `conversationId`, OpenCode
session IDs, run IDs, queue IDs, or client message IDs. Old transcript and
queue records must remain addressable with their stored values. The migration
adds scoped interpretation around them; it does not rewrite their identity.

### 2. Treat old UI/session entries as untrusted aliases

Older local UI state can contain a raw selected session ID or an older compact
route key. Read it through this resolver:

```text
explicit current scoped selection
  -> stored scoped v2 UI key
  -> exact workspace + directory binding
  -> legacy raw session alias only when exactly one scoped binding exists
  -> no automatic selection
```

Never infer a workspace from the active tab when a raw session ID has multiple
valid bindings. Keep the old entry for diagnostics or replace it only after a
user explicitly selects one of the candidate conversations.

The existing compact UI key parser remains read-compatible. New writes use a
scoped key containing workspace, directory, Veslo conversation, and OpenCode
session identity. A successful read of an unambiguous legacy key may rewrite
only that local preference to the scoped form.

### 3. Version the event binding envelope additively

Introduce a future `vesloBinding` v2 envelope without changing the OpenCode
payload itself:

```text
bindingVersion: 2
workspaceId
directoryInstanceKey
directoryInstanceEpoch
conversationId
opencodeSessionId
engineOwnerId
```

The event-store key becomes the scoped tuple, at minimum
`workspaceId + opencodeSessionId`, and includes directory information whenever
the envelope provides it. `engineOwnerId` and epoch are fencing metadata, not
the conversation key.

Legacy envelopes without `bindingVersion` continue to work only when all of
the following hold:

1. the event arrived through an already scoped workspace route;
2. its raw OpenCode session ID is already known for that route, or resolves to
   exactly one durable binding in that workspace and directory;
3. it does not conflict with an established v2 scoped binding.

Otherwise ignore the event and emit a sanitized diagnostic. This preserves
today's no-leak behavior while allowing the new form to represent two equal
raw OpenCode IDs from independent engines.

### 4. Validate dual submit identifiers

Keep accepting a submit containing only `conversationId` or only
`opencodeSessionId`. If a client sends both, resolve them under the requested
workspace and directory and require that they identify the same binding. A
mismatch returns a structured client error; it must never silently choose one
field.

This remains compatible with old clients while making stale UI state and
future multi-engine bugs visible at the boundary.

### 5. Keep workspace aliases as migration-only lookup inputs

Server workspace ID remains canonical whenever available. App-local and
deterministic local-path IDs remain accepted aliases for recovery of older
runtime snapshots, but all new durable writes use the server canonical ID.

Directory normalization must keep current Windows, WSL, slash, extended-path,
and case-variant compatibility. A path spelling update may merge equivalent
Windows forms, but it must not widen a directory-scoped lookup to unrelated
nested directories or a whole workspace.

## Implementation phases when this work is scheduled

### Phase 0 - Characterize before changing contracts

- Add a single identity-contract fixture covering two workspaces, two engine
  generations, equal titles, equal synthetic raw OpenCode session IDs, nested
  directories, and a restart.
- Record the expected resolution at UI, server binding, queue, run, and SSE
  boundaries.
- Keep this fixture topology-neutral so it runs for pooled and future shared
  directory-scoped engines.

### Phase 1 - Introduce typed canonical names at boundaries

- Define explicit scoped identity values instead of passing generic strings
  through app/server/orchestrator boundaries.
- Adapt upstream `sessionID` to `opencodeSessionId` in one adapter.
- Keep `engineSessionId` as a read-compatible persistence field and migrate
  internal call sites incrementally; do not perform a database rewrite.
- Make labels explicit display-only properties named `workspaceLabel` and
  `conversationTitle` where a boundary currently exposes an ambiguous `name`
  or `title`.

### Phase 2 - Add v2 event routing while preserving v1 reads

- Stamp new session-scoped proxy events with the v2 binding envelope.
- Key event pinning, delta deduplication, background status, and abort aliases
  by a scoped event identity rather than raw session ID alone.
- Accept legacy events with the fail-closed resolver above.
- Keep metrics for accepted v1, accepted v2, ambiguous legacy rejection, and
  scope mismatch rejection. Remove v1 only after a measured release window.

### Phase 3 - Close server submit ambiguity

- Add dual-ID equality validation.
- Return the canonical pair in all successful and structured failed submit
  responses.
- Preserve old single-ID request forms indefinitely unless the public API has a
  separately announced major version.

### Phase 4 - Optional duplicate-label UX

- Do not force globally unique labels.
- When equal conversation titles are visible in the same list, show a compact
  non-identity discriminator such as project/directory or a short creation
  time.
- Keep the raw IDs out of normal product UI; expose them only in developer
  diagnostics or a copy action.

## Acceptance matrix

| Scenario | Required result |
| --- | --- |
| Two engines, two conversations, same title | Two independently selectable rows; no routing or transcript merge |
| Two engines, synthetic equal raw OpenCode session IDs | Separate v2 SSE state, status, transcript, abort, and delta-dedup scopes |
| Same workspace, two nested directories, equal raw session ID | Durable binding and sidebar rows remain distinct; an unscoped legacy selection is rejected as ambiguous |
| Old compact UI key with one matching binding | Conversation opens and local preference upgrades to scoped form |
| Old compact UI key with multiple matching bindings | No automatic open; user chooses a scoped row |
| Legacy SSE event for known unambiguous session | Continues to update its scoped conversation |
| Legacy SSE event with ambiguous or conflicting scope | Ignored with diagnostic; never applied to the active workspace by fallback |
| Submit with only conversation ID or only OpenCode session ID | Remains accepted |
| Submit with matching dual IDs | Remains accepted and returns canonical pair |
| Submit with mismatched dual IDs | Structured rejection before an engine is selected |
| Process restart | New `engineOwnerId`; old conversation/session/run history remains unchanged |
| A and B share a directory-scoped engine process | A's event/revision epoch cannot be applied to B's conversation |

## Non-goals

- Do not make titles or workspace display names globally unique.
- Do not make `engineOwnerId` part of durable conversation identity.
- Do not migrate existing OpenCode session IDs or regenerate conversation IDs.
- Do not enable shared-directory runtime merely to perform this naming cleanup.
- Do not remove pooled-per-workspace fallback or legacy compatibility before
  the capability gates in the multi-workspace skill plan pass.

## Exit criteria

This plan is complete only when all new writes and events carry the canonical
scoped contract, old persisted/UI/event forms remain safely readable, and the
acceptance matrix passes against the bundled OpenCode runtime. Until then it
remains a proposed future audit and the current pooled production topology
continues to be the safety baseline.
