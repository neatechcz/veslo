---
title: Server-Owned Transcript Ingestion Stability Implementation Plan
date: 2026-07-10
status: ready-for-implementation
done: false
repository_snapshot: veslo-main active working tree after session idle and MCP refresh stabilization
depends_on:
  - docs/plans/2026-07-10-session-queue-final-implementation-plan.md
supersedes_in_part:
  - docs/plans/2026-07-10-session-message-truth-render-stability-implementation-plan.md
tsi01_identity_read_port_recovery_contract_done: false
tsi02_server_canonical_ingest_done: false
tsi03_terminal_lifecycle_ownership_done: false
tsi04_ui_writer_retirement_done: false
tsi05_recovery_and_migration_done: false
tsi06_verification_and_docs_done: false
---

# Server-Owned Transcript Ingestion Stability Implementation Plan

## Canonical Status

done: false

Every phase in this document starts with `done: false`. A phase changes to
`done: true` only after its focused codebase tests pass and its acceptance
criteria are recorded in the completion log. No desktop/E2E scenario is part
of this plan.

## Goal

Make the server, not the desktop UI, the only durable transcript writer.

The selected session UI must render live OpenCode SSE state immediately, while
the server owns a bounded canonical transcript ingestion after a lifecycle
terminal transition or an explicit server-side recovery request. A transcript
append must never be used as an implicit lifecycle or queue-control signal.

## Problem Statement And Runtime Evidence

The current route is:

```text
OpenCode SSE
  -> app message/part store
  -> app scheduleTranscriptIngestion (600 ms debounce)
  -> app POST complete transcript snapshot
  -> server SQLite append + complete transcript read
  -> server infers lifecycle work from snapshot/reason
```

This route has four confirmed failure modes:

1. `message.updated` and `message.part.updated` each schedule a full snapshot
   write. A long response exceeds the 600 ms debounce repeatedly, so the UI
   serializes many full transcript writes for one run.
2. `session.idle` starts another background canonical snapshot path beside a
   final live-store snapshot. Both enter the same per-session writer queue.
3. `session-transcript:ingest-flush-start` is recorded before the queued writer
   begins. A slow-looking flush can therefore be queue wait plus write time,
   with no trace boundary identifying either portion.
4. `shouldReconcileLifecycleAfterTranscriptAppend(...)` treats an append whose
   latest assistant message looks terminal as a lifecycle wake-up. Historical
   `message.updated` snapshots can consequently read lifecycle state and
   schedule queue drain after the run has already completed.

Latest dev runtime evidence, 2026-07-10:

- three sends caused 44 `ingest-scheduled` events and 15 flushes;
- one flush was observed from `21:23:47.077Z` through `21:23:51.370Z`;
- the server processed `session.idle engine snapshot` at `21:23:47.200Z`, but
  the queued `message.updated` append did not arrive until `21:23:50.346Z`;
- both server appends triggered `server:conversation-run:transcript-reconcile`
  and queue-drain scheduling even though the lifecycle had already accepted a
  terminal result.

The prior narrow fix removed redundant `session.get` calls and concurrent MCP
status bursts. This plan deliberately does not reopen those owners.

## Target Architecture

```text
OpenCode SSE -> app store -> app render only

durable run lifecycle terminal/recovery
  -> server transcript-ingest coordinator
     (single-flight by workspace + normalized directory + OpenCode session)
  -> canonical engine/read-store transcript read
  -> host SQLite persist when watermark changed
  -> lifecycle-owned queue drain decision

app cold start / selected-session recovery
  -> server transcript read only
```

The canonical engine/read-store transcript is the source for a durable write.
The UI never uploads its potentially partial projection as durable truth.

## Hard Contracts

1. The app may render and cache SSE messages, but it must not persist complete
   transcript snapshots to the server during normal streaming or terminal
   completion.
2. A durable transcript ingest mutex is keyed exactly by
   `(workspaceId, normalizedDirectory, opencodeSessionId)`. `runId`, trigger,
   and request generation are request metadata, not components of the mutex.
   A second request for the same mutex records only the newest generation.
3. Only the server-side canonical read result may update the transcript store.
   Do not introduce a second client-owned durable cache or a client-generated
   revision as authority.
4. Queue draining is owned by durable lifecycle status. Transcript contents,
   including a terminal-looking assistant message, must not independently wake
   a queue.
5. The initial stabilization policy persists one terminal snapshot. Optional
   mid-stream checkpoints are explicitly deferred; if later required, they
   must be server-side, bounded, and version-gated.
6. A failed canonical read does not erase a prior persisted transcript. It
   enters at most three server-side canonical reads total: immediate, then
   after 2 seconds and 8 seconds. Each read has an 8-second timeout. On
   exhaustion it records `exhausted`, performs no lifecycle mutation, does not
   schedule queue drain, and leaves UI SSE rendering alone.
7. Remote workspace behavior remains fail-closed unless its server provides an
   equivalent canonical read-and-persist capability.
8. No phase adds desktop/E2E tests. Use unit, service, route, and source-owner
   tests only.

9. A UI SSE-loss recovery is an idempotent server command, not a transcript
   upload. Its request contains the same normalized workspace, directory,
   OpenCode session, and optional expected run id used by the mutex. Duplicate
   requests join the same coordinator work. The route requires collaborator
   scope and writable local workspace ownership; remote workspaces return a
   deliberate unsupported/fail-closed result until an equivalent remote server
   capability exists.

10. After TSI04, `POST /workspace/:id/sessions/:sessionId/transcript` is not a
    client write API. It rejects any snapshot body with a stable `410`
    `transcript_snapshot_write_retired` error and has no lifecycle side effect.
    The app client/types and every fixture that used it must migrate before the
    old endpoint is considered retired.

11. A destructive durable reconcile requires a complete canonical snapshot.
    The internal canonical-read port must return `complete: true` plus the
    complete message/part membership for the session scope. A bounded/limited
    read may update known rows only; it must never infer deletions. The terminal
    ingest therefore uses an internal unlimited/paged-complete read, not a UI
    transcript limit.

12. The durable watermark is a stable server-only hash of normalized canonical
    message payloads, normalized part payloads, their ordered identity set,
    and the authoritative deletion/membership set. It is not based only on
    update timestamps and is never included in trace payloads.

13. Every successful canonical write invalidates `sessionTranscriptPrefetch`
    for both the OpenCode session key and any resolved conversation alias using
    the same normalized directory. A subsequent transcript GET must not serve
    the old warm snapshot.

## Implementation Order

### TSI01 - Define identity, canonical-read port, recovery API, and observability

Priority: P0

Status: `done: false`

Owners:

- `packages/server/src/conversation-service.ts`
- `packages/server/src/conversation-run-lifecycle-controller.ts`
- `packages/server/src/routes/conversations.ts`
- `packages/app/src/app/lib/veslo-server/types.ts`
- `packages/app/src/app/lib/veslo-server-domains/conversations.ts`
- `packages/app/src/app/lib/veslo-server/client.ts`
- `packages/app/src/app/context/session-transcript-controller.ts`
- transcript/lifecycle unit tests

Implementation:

1. Add one normalized `TranscriptIngestIdentity`:
   `workspaceId`, `normalizedDirectory`, and `opencodeSessionId`. Require it
   at every coordinator, store, lifecycle, and recovery boundary. `runId`,
   trigger (`terminal-lifecycle` or `recovery`), and monotonic generation are
   request metadata only. No request carries UI messages or parts.
2. Add an internal `readCanonicalTranscript(identity, limit)` server port.
   It must call the conversation read-store/engine source directly, return
   the explicit source and diagnostic, and never take the host-first shortcut
   in `conversationService.loadTranscript()`. Public `GET .../transcript`
   behavior remains host-first and unchanged.
3. Define `POST /workspace/:id/sessions/:sessionId/transcript/recovery` as the
   narrow UI recovery command. Its body contains `directory` and optional
   `expectedRunId`; it returns an acknowledgement with ingest state, never a
   transcript. It uses `ensureWritable`, collaborator scope, normalized route
   workspace ownership, and the TSI01 identity. Duplicate requests use the
   coordinator mutex rather than a client-generated retry loop.
4. Define `expectedRunId` precisely. If absent, recovery is an unscoped
   selected-session/cold-start recovery. If present, the server resolves the
   latest durable run for the identity and must return `409`
   `recovery_run_mismatch` without scheduling ingest when it no longer equals
   `expectedRunId`. A mismatch never joins a replacement run or retries.
5. Define local/remote behavior explicitly. Local workspace recovery is
   supported. Remote workspace recovery returns an explicit unsupported result
   until its remote server can perform the same canonical read-and-persist
   operation; it must not fall back to UI snapshot upload.
6. Define trace events with separate timestamps for:
   `requested`, `joined-in-flight`, `writer-started`, `engine-read-complete`,
   `persist-complete`, `unchanged-skip`, `retry-scheduled`, and `failed`.
7. Change app transcript controller traces so `flush-start` means the writer
   actually begins, or add a distinct `flush-queued` event. Do not retain a
   misleading duration metric.
8. Record safe counts and identities only: workspace/session/run ids, trigger,
   message count, part count, queue wait duration, read duration, write
   duration, and whether persistence changed. Never log prompt or tool text.

Required tests:

- a queued ingest emits `requested` then `writer-started`, with queue wait
  distinguishable from persistence duration;
- joining the same key does not create another writer;
- identity normalization distinguishes same OpenCode session id in two
  directories and joins only equal normalized identities;
- public transcript GET remains host-first while the new canonical-read port
  reaches the configured read-store;
- recovery route rejects missing directory, foreign/unsupported remote scope,
  and unauthorised callers; duplicate recovery requests join one ingest;
- a recovery request with a mismatched `expectedRunId` returns the stable 409
  result and neither joins nor starts a replacement run;
- trace payload tests reject prompt/content fields.

Acceptance:

- every later phase has one non-ambiguous identity, canonical read seam, and
  recovery contract; a future runtime trace can prove whether delay is queue
  wait, engine read, SQLite write, or lifecycle work without payload content.

### TSI02 - Add server-owned canonical transcript ingest coordinator

Priority: P0

Status: `done: false`

Owners:

- `packages/server/src/conversation-service.ts`
- `packages/server/src/conversation-transcript-store.ts`
- `packages/server/src/conversation-read-store.ts`
- `packages/server/src/session-transcript-prefetch.ts`
- new focused server coordinator module adjacent to conversation service
- `packages/server/src/routes/conversations.ts`
- server service and route tests

Implementation:

1. Add a server coordinator keyed only by the TSI01
   `(workspaceId, normalizedDirectory, opencodeSessionId)` identity. It
   maintains one in-flight task and one latest dirty generation per key. Do
   not include `runId` in this key: two lifecycle observations for one session
   must coalesce, not run in parallel.
2. The coordinator reads through TSI01 `readCanonicalTranscript(...)`, not
   `conversationService.loadTranscript()`. The terminal/recovery path must use
   a complete canonical read with no UI `LIMIT`; if implementation requires
   paging, it must finish every page against one stable canonical read before
   returning `complete: true`. An incomplete or capped result may not perform
   destructive reconciliation.
3. Add a transcript-store operation for complete canonical reconciliation. It
   atomically upserts every canonical message/part and removes stored
   messages/parts absent from the complete canonical membership set. It must
   not use UI-provided `deletedMessageIds` or `deletedPartsByMessageId`.
4. Compute and retain a server-owned watermark as a stable hash of normalized,
   ordered message payloads, part payloads, and complete membership/deletion
   set. If the hash equals the last persisted hash, skip SQLite mutation and
   report `unchanged-skip`. Never expose the hash through API or trace output.
5. Enforce the fixed recovery policy from the hard contract: at most three
   reads total, delays `[0, 2_000, 8_000]`, and an 8-second timeout per read.
   A final failure records an exhausted diagnostic only; it cannot reopen
   lifecycle polling, alter run state, or delay queue drain.
6. After a successful changed write, invalidate `sessionTranscriptPrefetch` for
   the OpenCode session id and resolved conversation alias, both scoped by the
   normalized directory. The coordinator receives this invalidation port; do
   not rely on the retired HTTP append route to perform it.
7. Do not return a full transcript from the ingest operation. The operation is
   a durable command and should return an acknowledgement/diagnostic only.
   Existing `GET .../transcript` remains the read API.
8. Keep transcript store mutations transactional. Do not use the existing
   public UI append endpoint as the coordinator's
   transport. It is a client payload API and is the contract being retired.

Required tests:

- two terminal requests for one session produce one canonical engine read and
  one durable write when the watermark is unchanged;
- same workspace/session values with different normalized directories do not
  join; path variants for one normalized directory do join;
- a later dirty generation during an in-flight read produces at most one
  follow-up read/write;
- canonical read failure keeps the previous SQLite transcript intact;
- an incomplete/limited canonical read cannot delete a durable message or
  part; a complete canonical read removes stale messages and parts atomically;
- same message/part ids with changed payload but unchanged timestamps change
  the internal watermark and persist the new payload;
- warm prefetch cache -> changed canonical ingest -> subsequent transcript GET
  returns the newly persisted content for both OpenCode and conversation alias;
- an ingest acknowledgement contains no transcript body.

Acceptance:

- one completed run cannot create a serial queue of obsolete full snapshots;
- all durable transcript content originates at the server canonical-read seam.

### TSI03 - Make lifecycle terminal state the only queue wake-up owner

Priority: P0

Status: `done: false`

Owners:

- `packages/server/src/conversation-run-lifecycle-controller.ts`
- `packages/server/src/routes/conversations.ts`
- `packages/server/src/conversation-submit-service.ts`
- lifecycle controller and server conversation tests

Implementation:

1. When lifecycle reconciliation observes a terminal run, request TSI02 ingest
   for that run/session with the directory carried from the lifecycle target or
   durable queue row. Extend the lifecycle schedule input where necessary; do
   not reconstruct directory from an arbitrary active workspace.
2. Queue drain for the **server durable `conversation_run_queue`** remains tied
   to the same durable terminal lifecycle result. It
   must not wait for a client transcript append and must not be re-scheduled by
   a historical transcript write.
3. Remove `transcriptLatestAssistantLooksTerminal(...)` as a lifecycle wake-up
   predicate. Keep only explicit server-owned recovery paths where a terminal
   lifecycle status is independently verified.
4. Retire `handleTranscriptAppend(...)` as an append-driven lifecycle API, or
   reduce it to an internal compatibility no-op until TSI04 removes its final
   callers. Do not leave a hidden transcript-to-queue control path.
5. Replace the existing server conversation test whose contract is
   “POST transcript reconciles lifecycle and wakes queued runs”. Its successor
   must assert that a terminal lifecycle drains the next durable queued run
   without a transcript HTTP request. Do not change the app-local pending-draft
   queue/drain owner in this plan.

Required tests:

- a terminal lifecycle triggers one canonical ingest and one queue-drain
  decision;
- multiple `message.updated`-style transcript events after terminal status do
  not produce lifecycle reads or additional queue drains;
- an active lifecycle does not drain merely because a transcript has an
  assistant message;
- queued successor starts after lifecycle terminal transition even when no
  client is connected.

Acceptance:

- queue ownership is expressible entirely from durable run lifecycle state;
- transcript persistence is observability/data work, never a queue control
  signal.

### TSI04 - Retire every client snapshot writer and its public endpoint

Priority: P0

Status: `done: false`

Owners:

- `packages/app/src/app/context/session-event-stream.ts`
- `packages/app/src/app/context/session-transcript-controller.ts`
- `packages/app/src/app/context/session-lifecycle-recovery.ts`
- `packages/app/src/app/context/session-selection-controller.ts`
- `packages/app/src/app/context/session.ts`
- `packages/app/src/app/lib/veslo-server/types.ts`
- `packages/app/src/app/lib/veslo-server-domains/conversations.ts`
- `packages/app/src/app/lib/veslo-server/client.ts`
- `packages/server/src/routes/conversations.ts`
- `packages/server/src/conversation-service.ts`
- existing `packages/e2e/pilot-scenarios/*` transcript fixture scenarios
- `packages/app/src/app/context/conversation-service.ts`
- `packages/app/src/app/app.tsx`
- app context and session-flow tests

Implementation:

1. Remove normal `scheduleTranscriptIngestion(...)` calls from
   `message.updated`, `message.part.updated`, and `session.idle` paths once
   TSI02 is available.
2. Remove every remaining app `appendTranscriptSnapshot` writer path, not only
   the foreground SSE debounce: background workspace events, reconnect
   catch-up, `session.idle` engine snapshots, lifecycle terminal recovery, and
   `backfillRecoveredLiveHistory(...)` must either become a TSI01 recovery
   command or remain read/render-only.
3. Remove the app `appendTranscriptSnapshot` wiring used only to POST complete
   snapshots. Keep in-memory transcript state, deletion handling, and UI
   rendering intact.
4. Remove the UI-side post-append transcript hydration path. A live selected
   session is updated by SSE; cold start and selection use the existing server
   read API.
5. Replace UI transcript catch-up scheduling with the TSI01 narrow server recovery
   request only when the selected session has no assistant observation after a
   bounded delay. It must not upload a UI snapshot.
6. Keep one temporary compatibility guard only if an older server does not
   expose TSI02. That guard must fail closed to UI durability (render continues
   from SSE) rather than restoring continuous client snapshot uploads.
7. Retire the public client snapshot-write route after all callers migrate.
   `POST /workspace/:id/sessions/:sessionId/transcript` must reject a body
   containing messages, parts, or deletion fields with `410`
   `transcript_snapshot_write_retired`; delete its call into
   `conversationService.appendTranscript(...)`, prefetch invalidation, and
   `handleTranscriptAppend(...)` lifecycle side effect. Remove the app client
   method and `VesloSessionTranscriptAppendInput` from public client surfaces.
8. Update existing pilot fixture scenarios that seed transcripts through the
   retired endpoint. Give fixtures a server-owned canonical seed/read seam or
   seed their fake OpenCode source before requesting server recovery. Do not
   add a new pilot or make pilot execution a TSI acceptance gate.

Required tests:

- a stream of message/part SSE events changes the rendered/session store but
  makes zero client transcript append calls;
- `session.idle` makes zero client `session.get` calls and zero snapshot-upload
  calls;
- background workspace events, reconnect catch-up, lifecycle latest recovery,
  non-selected lifecycle recovery, and live history backfill make zero client
  transcript append calls;
- client append types/methods are absent from the app client surface and a
  snapshot-write POST receives the stable 410 retirement response with no
  lifecycle invocation;
- existing transcript-seeding pilot scenario sources no longer call the
  retired route.
- SSE loss requests server recovery once per session/run and does not create a
  local writer queue;
- cold selection still hydrates from the server transcript read surface.

Acceptance:

- normal UI streaming cannot cause transcript SQLite writes or server lifecycle
  reconciliation directly;
- the app no longer has a full-snapshot durable writer.

### TSI05 - Server-side bounded recovery and compatibility removal

Priority: P1

Status: `done: false`

Owners:

- server transcript ingest coordinator from TSI02
- lifecycle controller
- app `submitted-run-transcript-catchup.ts`
- focused server/app recovery tests

Implementation:

1. On a terminal lifecycle ingest that finds no assistant message yet, use the
   TSI02 fixed policy only: three canonical reads total at `0`, `2_000`, and
   `8_000` ms, each with an 8-second read timeout. Do not inherit the
   lifecycle reconciler's one-second / 600-attempt policy and do not retry
   indefinitely.
2. Deduplicate terminal and UI recovery by the same normalized identity. A
   second observation joins or replaces the pending generation; it must not
   create another retry loop or mutate lifecycle state after exhaustion.
3. Change app catch-up to observe the server result/read state and stop when
   SSE has already observed an assistant message. It must not be required for
   normal completion.
4. Remove the temporary compatibility guard from TSI04 after the supported
   server version is guaranteed to provide the canonical ingest contract.

Required tests:

- delayed engine transcript publication succeeds through bounded server retry;
- exhausted retry performs exactly three timed reads, leaves an existing
  persisted transcript visible, records a diagnostic, and neither changes run
  status nor schedules server durable queue drain;
- repeated UI recovery signals create one server retry sequence;
- a normal live SSE completion performs no app catch-up read/write work.

Acceptance:

- slow OpenCode transcript publication cannot produce UI-local persistence
  churn or falsely imply a failed completion.

### TSI06 - Verification, observability review, and documentation

Priority: P1

Status: `done: false`

Owners:

- focused app/server tests from TSI01–TSI05
- `docs/features/session-runtime.md`
- `docs/dev/conversation-workflow-contract.md`
- `docs/dev/opencode-workspace-runtime-architecture.md`
- a concise `docs/fixes/` checkpoint after implementation

Required verification:

```powershell
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec tsx --test src/app/tests/context/session-event-stream.test.ts src/app/tests/context/session-transcript-controller.test.ts src/app/tests/context/session-lifecycle-recovery.test.ts src/app/tests/context/submitted-run-transcript-catchup.test.ts src/app/tests/context/session-selection-controller.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/lib/veslo-server.test.ts

pnpm --filter veslo-server typecheck
pnpm --filter veslo-server exec bun test src/tests/conversation-read-store.test.ts src/tests/conversation-transcript-store.test.ts src/tests/conversation-service.test.ts src/tests/conversation-run-lifecycle-controller.test.ts src/tests/session-transcript-prefetch.test.ts src/tests/server-conversations.test.ts

git diff --check
```

Documentation must state:

- live UI transcript is an SSE projection;
- durable transcript persistence is server-owned canonical ingestion;
- lifecycle terminal state owns queue progression;
- normal app behavior never uploads complete transcript snapshots.

Deferred release recommendation (not a TSI completion gate): after the focused
tests are green, run one manually observed desktop/Tauri scenario covering a
terminal run, one server ingest, no UI append, a durable queued successor, and
workspace isolation. This remains outside the requested no-E2E plan and must
not block its `done: true` status.

Completion-log requirements:

- include exact focused test output/counts;
- include one sanitized trace summary showing one terminal ingest for a run,
  with no UI append events, no transcript-driven lifecycle reconcile, and a
  prefetch invalidation before a fresh server transcript read;
- explicitly state that desktop/E2E was intentionally not run.

Acceptance:

- the contracts above are reflected in code, tests, and current runtime docs;
- no old client-writer or transcript-driven queue wake-up path remains.

## Explicitly Out Of Scope

- desktop/Tauri pilot or E2E automation;
- a broad rewrite of message rendering, pending drafts, or queue UI;
- client-to-server streaming deltas or a new realtime transport;
- unbounded server checkpoints during generation;
- changing the durable queue data model or queue mutation API.

## Completion Log

Keep this section empty until implementation evidence exists.

- TSI01: `done: false`
- TSI02: `done: false`
- TSI03: `done: false`
- TSI04: `done: false`
- TSI05: `done: false`
- TSI06: `done: false`
