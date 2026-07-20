---
title: Composer Draft Integrity and Viewport Churn Fix Plan
date: 2026-07-18
status: in_progress
done: false
scope: session composer ownership and local-echo viewport identity; Den registry is a separate operational follow-up
---

# Composer Draft Integrity and Viewport Churn Fix Plan

## Problem statement

The latest manual `pnpm dev` trace contains a real user-data-loss incident.
During first-session materialization, the focused `composer_2` contained 20
characters. At `2026-07-18T17:29:33.113Z`, `composer.prompt-sync` received an
empty `props.prompt`; the editor then applied an `external-sync` mutation from
20 characters to zero. This is a client state-ownership failure, not inference,
SSE content, or gateway behavior.

The same trace has a separate allocation problem. Canonical and visible
transcript projections changed 13 times, while the viewport projection changed
154 times. `resolveTranscriptSourceMessages()` allocates
`[...messages, localSubmittedMessage]` whenever a local echo is visible, and
the viewport can also allocate a slice for windowing. This increases downstream
model and DOM work, but it is not itself the proven cause of draft loss.

The running Den deployment separately returns `skill_registry_invalid_payload`
for registry materialization. Its local metadata-reconstruction fix has
regression coverage, but its database/deployment verification is an independent
production operation. It is recorded below only as a follow-up and is not a
dependency, acceptance condition, or completion condition of this draft/viewport
plan.

## Evidence and boundary of certainty

### Confirmed

- The focused editor was cleared by an external prop sync in the trace.
- A first session changes the composer storage owner from an unpublished
  pending-draft key to a real session key.
- The app now has a pending-draft-to-session remap in the materialization path;
  the next manual run must verify that it eliminates the observed empty prop.
- `composer-draft-handoff.ts` owns a revision only inside one Composer instance.
- The viewport local-echo source allocation and window slice allocation exist.

### Not yet proven

The trace does **not** prove that an old center Composer asynchronously wrote
the empty value after the footer Composer had received user input. That is a
credible remaining race because clears are instance-local today, but the
captured incident is also fully explained by the missing pending-to-real draft
ownership transfer. Do not present the old-Composer theory as the root cause
until parent-level tracing identifies the writer.

### Implementation checkpoint â€” 2026-07-18

- The parent draft entry now owns its value and revision atomically; delayed
  clears are conditional on the captured explicit storage key and revision.
- First-session handoff now also transfers the no-session bucket when no
  explicit pending draft key exists. A fresh desktop reproduction exposed this
  missing branch: the former remap returned `noop`, then an old focused
  Composer received an empty prop.
- A pending-to-real ownership-key transition is diagnostic-authorized for the
  outgoing Composer only. It does not suppress a focused external sync when
  the storage key is unchanged.
- The final clean-run trace check remains required before changing `done` to
  `true`; the earlier runtime archive is retained as a failing-regression
  witness, not completion evidence.

## Invariants

1. A user draft belongs to one explicit composer storage key.
2. A delayed clear may mutate that key only if its captured revision is still
   current for that key.
3. A session switch deliberately isolates drafts. A pending-to-real
   materialization deliberately transfers the pending draft; it is not a normal
   session switch, and transfers the draft **before** publishing the selected
   real session.
4. A focused editor may be externally synchronized only by an authorized
   storage-key/revision transition. An unexpected non-user clear is an incident.
5. Viewport array identity may change only when its canonical input, local echo
   visibility/content, search state, or window state changes.

## Step 0 — validate the current pending-to-real draft remap

**Owners**

- `packages/app/src/app/app.tsx`
- `packages/app/src/app/pages/session-composer-drafts.ts`
- `packages/app/src/app/pages/session-conversation-flow.ts`
- `packages/app/src/app/pages/session.tsx`

The existing change moves the follow-up draft from the captured pending bucket
to the materialized real session bucket in the materialization callback. The
ordering is a correctness contract: resolve and move the draft first, then
publish `selectedSessionId` for the real session. A batch alone is not enough
as a specification; once `selectedSessionId` is visible,
`currentComposerStorageKey()` points at the real-session bucket and a Composer
may observe an empty prompt.

Keep this change and run the exact manual reproduction before adding another
mechanism:

1. Open a no-session surface.
2. Send `ahoj`.
3. While the first answer is starting, type a distinct second draft.
4. Wait for the real session to materialize and for the answer to stream.
5. Verify the second draft remains in the footer composer and can be sent.

**Acceptance**

- No `ui-incident:draft-external-sync-while-focused` occurs.
- The storage handoff does not leak a draft into an unrelated existing session.
- Existing unit coverage for pending-draft remapping passes.
- A behavioral handoff test observes `remap pending draft -> publish selected
  real session` and fails for the reverse order; a source-order assertion alone
  is insufficient.

If this fixes the reproduction, retain Step 1 as defense in depth only if a
delayed writer is still observable. If it does not, Step 1 becomes required.

## Step 1 — move delayed-clear authority to the parent draft store

**Owners**

- `packages/app/src/app/app.tsx`
- `packages/app/src/app/pages/session-composer-drafts.ts`
- `packages/app/src/app/app-view-props.ts`
- `packages/app/src/app/pages/session.tsx`
- `packages/app/src/app/components/session/composer.tsx`
- `packages/app/src/app/components/session/composer-draft-handoff.ts`
- `packages/app/src/app/context/composer-target-controller.ts`
- `packages/app/src/app/context/pending-session-draft-controller.ts`
- `packages/app/src/app/pages/session-send-workflow.ts`
- `packages/app/src/app/pages/session-mutation-workflow.ts`

Introduce a small, pure parent-owned draft-state model. Its key is the
**resolved composer storage key** from `resolveComposerStorageKey()`, never a
raw pending-draft ID; all pending routes deliberately resolve to the same
unpublished bucket. Each entry owns:

- the draft value;
- a monotonically increasing `draftRevision`;
- `captureDraftRevision(storageKey)`;
- `clearDraftIfRevision(storageKey, expectedRevision): boolean`.

Replace every dependency on the raw `Record<string, ComposerDraft>` setter with
a single `ComposerDraftStateStore` command boundary. It exposes only typed
operations such as `writeDraft`, `deleteDraft`, `movePendingDraft`,
`captureDraftRevision`, and `clearDraftIfRevision`; it does not expose the old
record updater. The four controller/workflow owners above must call this same
boundary, so a target change, pending-draft restore, send cleanup, or session
mutation cannot bypass revision handling.

Every parent write that changes a draft semantically increments the revision.
This includes user draft updates, explicit clear/history application, and
retry/restore of that draft entry. A target or session switch alone is not a
draft write and does not advance any revision. A semantic no-op preserves the
revision and object identity. A pure pending-to-real storage-key move preserves
the entire `{ draft, revision }` entry without incrementing it: it is an
ownership move, not a content change. Draft and revision are one atomic state
entry; no independent revision map may be moved or updated later than its
draft.

`clearDraftIfRevision(storageKey, expectedRevision)` is one atomic parent
operation: it compares the entry revision, replaces the draft with the explicit
empty-draft value, and advances the same entry's revision in one store update.
It never clears a separate global "active draft" and it never changes only the
revision. Every normal draft write must likewise receive an explicit resolved
storage key; no caller may infer the key at commit time from current selection.
That prevents a late Composer instance from writing or clearing whichever key
has become active since it captured its work.

Pass both the explicit storage key and the parent conditional-clear capability
to Composer. At submit time Composer captures the parent revision for the key
that owns the submitted draft. Its existing local handoff controller may still
prevent duplicate local operations, but `clearSubmittedDraft()` must first ask
the parent to clear that exact key at that exact revision. Only a successful
parent clear may clear the local editor DOM and attachments.

This is intentionally per storage key, not one global active-composer counter:
a deliberate switch to another real session must not let a stale Composer
change the newly selected session, and materializing a pending draft must move
its `{ draft, revision }` entry atomically with its value.

### Materialization collision policy

A newly materialized real-session bucket is expected to be empty. If it already
contains a semantically different draft, the remap must fail closed: preserve
both the pending source and the real-session target, return a content-free
draft-remap conflict/incident, and perform no automatic transfer. It must never
overwrite either value or advance either revision. This slice does **not**
introduce a draft-conflict UI, draft persistence state, or an explicit
user-resolution flow. The backend session may already exist, so the conflict
result must not block, delay, or otherwise decide existing session
materialization, route selection, or run lifecycle publication. If target and
source are semantically equal, retain the target entry and remove the source as
an idempotent deduplication without changing the target revision. A successful
empty-target transfer moves the whole `{ draft, revision }` entry unchanged
before the normal existing session-publication flow observes the real-session
key.

Do **not** special-case `props.prompt === ""` in Composer. Empty props are
legitimate for explicit clear, history navigation, and a successful submission;
the authorization must be at the shared-store boundary.

### Required tests

- Pure draft-state test: a conditional clear succeeds at the captured revision
  and fails after a newer write to the same key.
- Cross-instance regression: Composer A submits `ahoj`; Composer B, sharing the
  same draft key after a UI branch transition, writes a new prompt; A's delayed
  clear is rejected and B's text remains in the store and editor.
- Session-isolation regression: a stale clear from session A cannot touch the
  draft for session B.
- Pending materialization regression: moving a pending draft moves both draft
  value and revision unchanged exactly once; a repeated handoff is a no-op.
- Collision regression: a non-empty, semantically different real-session target
  remains intact, the pending source remains recoverable, a content-free
  conflict is recorded, and the existing session-publication/lifecycle flow is
  unaffected by the draft-remap result.
- Late-writer regression: an instance that captured pending key/revision before
  materialization cannot write or clear the real-session key after the parent
  has remapped or selected it.
- Command-boundary regression: each target controller, pending-draft controller,
  send workflow, and mutation workflow performs draft changes through the shared
  state-store command API; no dependency retains the raw record setter.

## Step 2 — make the writer observable without adding typing-path IPC

**Owners**

- `packages/app/src/app/lib/ui-effect-trace.ts`
- `packages/app/src/app/components/session/composer.tsx`
- `packages/app/src/app/app.tsx`

Under the existing explicit dev UI trace flag only, emit content-free records
for:

- `composer-draft:revision-captured`;
- `composer-draft:conditional-clear` with `applied`, storage-key kind, expected
  revision, actual revision, command owner, and monotonic `writeId`;
- `composer-draft:write` only for non-input ownership transitions (remap,
  explicit clear, history/session switch), not every keystroke. It includes the
  command owner, operation, storage-key kind, previous/next revision, and a
  runtime-monotonic `writeId` allocated by the shared draft-state store.

Keep these entries in the existing bounded incident ring and flush one batch on
an actual focus/draft incident. Never emit prompt text, attachment URLs, or a
per-keystroke IPC event.

**Acceptance**

For a future incident, the `.tmp` window can attribute the empty prop to a
specific parent write or prove that no parent clear occurred.

## Step 3 — finish the small viewport identity fix before incremental projection

**Owners**

- `packages/app/src/app/components/session/pending-submit-model.ts`
- `packages/app/src/app/pages/session.tsx`
- `packages/app/src/app/pages/session-transcript-viewport.ts`
- `packages/app/src/app/context/session-transcript-write-diagnostics.ts`
- `packages/app/src/app/tests/components/session/pending-submit-model.test.ts`
- `packages/app/src/app/tests/pages/session-transcript-viewport.test.ts`
- `packages/app/src/app/tests/context/session-transcript-write-diagnostics.test.ts`

The local optimistic message projection must retain its object identity while
the pending draft object and workspace root are unchanged. This removes the
most direct source of redundant `[...messages, localSubmittedMessage]` input
changes. Keep the current direct `renderedMessages` memo in the viewport; it
protects against transcript flashing during fast idle/running transitions.

After Step 0/1 has been manually verified, use one controlled stream to measure
remaining viewport changes. Only if the viewport still returns a new array for
identical input references and identical search/window state, add a tiny
last-input identity cache inside the viewport owner for:

- source messages reference;
- local echo reference;
- search-active flag;
- window-expanded flag;
- window start.

The cache must return its previous rendered array only for an identical input
tuple. It must not cache by message text, suppress a valid stream delta, or move
windowing/anchoring responsibility out of the viewport.

### Measurement protocol

The stable `.tmp` trace mirror is append-only and is not by itself a run
boundary. Before every manual measurement, complete the desktop runtime
preflight below, then launch a fresh desktop process through
`scripts/dev-with-force-sidecars.mjs`. The wrapper clears only its exact
send-workflow mirror set (base/UI/server/orchestrator), never the whole `.tmp`
directory. Record the timestamped runtime archive
path printed by that launch as the authoritative run identifier. If a mirror
cannot be cleared, the analysis must filter every record by that new archive's
run/trace identifiers; it must not call the newest line in the shared mirror a
new run.

For every `viewport-rendered` identity transition, emit a content-free tuple:

```text
(canonical array identity, local-echo identity, search-active,
 window-expanded, window-start, selected-display-session)
```

Identity values are process-local opaque sequence numbers, never serialized
message data. The trace records previous and next tuple plus whether the output
array identity changed. The acceptance question is exact: every viewport output
identity change must have a changed input tuple. A changed tuple may still
return the prior array only when the projection formally proves it is the same
ordered result. “Less churn” is not an acceptance criterion.

**Acceptance**

- With a local echo visible, repeated unrelated reactive work does not change
  `viewport-rendered` array identity.
- A canonical message update, local echo add/remove, search change, or window
  change does update the projection as expected.
- Every observed viewport output-identity change has a changed recorded input
  tuple; an equal tuple preserves the previous output reference.
- Focused projection/diagnostic coverage proves: an equal tuple returns the
  same output reference; a changed tuple may retain the prior reference only
  when the ordered rendered result is semantically identical.
- Do not start incremental MessageList/block projection unless post-fix traces
  show unchanged viewport inputs but materially expensive block derivation.

## Separate operational follow-up — deploy and verify the Den registry fix

**Status:** external to this plan; does not block or determine `done`

**Owners**

- `services/den/src/skills/db-store.ts`
- `services/den/drizzle/0021_skill_version_package_metadata.sql`
- `.github/workflows/deploy-owned-server.yml`
- `docs/dev/cloud-deployments.md`

The database migration and the Den image must deploy together through the
owned-server workflow. Do not attempt to mark the problem fixed by running a
local migration without a configured database URL. Its result must be tracked
in its own operational task or fix note, not folded into the draft-loss or
viewport acceptance evidence.

Before rollout, confirm the target release includes the guarded reconstruction
of legacy metadata only when its package hash agrees. After rollout:

1. Query `/health` for the newly deployed Den instance.
2. Confirm the owned-server workflow run, deployed commit, and selected Den
   image/digest are the intended release rather than relying on a nonexistent
   `/version` endpoint.
3. Materialize a representative existing system skill and a representative
   existing non-system/user or workspace skill.
4. Confirm no `skill_registry_invalid_payload` / 502 occurs in server or app
   traces.

Keep the mismatched-package-hash scenario as a local regression test. Do not
create or tamper with production data merely to exercise the negative path.

## Core-plan verification sequence

1. Run focused unit tests for composer draft state, Composer handoff, pending
   draft remap, and viewport projection.
2. Run `pnpm --dir packages/app typecheck` and `git diff --check`.
3. Before a desktop run, perform the required runtime preflight from
   `docs/dev/testing-playbook.md`: identify running Veslo dev/test processes,
   stop only instances known to have been started for this repo, and verify the
   relevant process set is empty. If an unowned/user runtime is present, stop
   and report it instead of starting a second instance.
4. Build fresh sidecars and launch only through the force-sidecar wrapper:

   ```powershell
   node scripts/dev-with-force-sidecars.mjs
   ```

   The wrapper itself performs the forced sidecar preparation. Capture the
   timestamped trace archive printed by this new process. This archive is the
   evidence boundary; the mirror is only a convenience copy.
5. Execute the first-session reproduction plus a normal A-to-B session switch.
6. Inspect only records belonging to that captured run/archive:
   - no focused external clear;
   - conditional clear, if attempted, has an attributable outcome;
   - draft remains isolated across ordinary session switching;
   - every viewport identity change maps to a changed recorded input tuple.

## Non-goals

- Do not mask the issue by ignoring empty prompt props in a focused Composer.
- Do not force focus back to the editor after every state change.
- Do not treat raw MessageList recompute count as a correctness or performance
  metric without its projection-boundary context.
- Do not start a broad incremental transcript/block projection rewrite before
  the smaller ownership and identity fixes have been measured.
- Do not treat the Den registry deployment as UI validation or use its status
  to block the composer/viewport completion decision.

## Completion definition

This plan is complete when the parent draft store atomically guards delayed
clears by explicit storage key and revision, pending-to-real remap preserves
both drafts and records a conflict without deciding session lifecycle, and a
fresh desktop run proves both draft preservation and the viewport input-tuple
identity contract. The separate Den operational follow-up has its own
completion decision.
