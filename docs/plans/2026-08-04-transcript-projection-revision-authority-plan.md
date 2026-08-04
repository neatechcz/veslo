---
title: Transcript Projection Revision Authority Plan
date: 2026-08-04
status: proposed
done: false
scope: one revision authority for the transcript projection stages, and a whole-collection rewrite that is bounded rather than routine; correctness first, projection cost second
related:
  - docs/plans/2026-08-04-production-feedback-continuation-kiss-remediation-plan.md
  - docs/plans/2026-08-04-runtime-degraded-state-ownership-and-diagnostics-plan.md
  - docs/plans/2026-07-18-kiss-message-delivery-and-transcript-projection-plan.md
  - docs/dev/app-map.md
---

# Transcript Projection Revision Authority Plan

## Executive verdict

After a queued message was delivered, the transcript briefly rendered two
assistant answers in a row, and corrected itself only when the next message
arrived. This is a correctness defect, not a performance one: the user was shown
a state that never existed. Reducing projection cost would shorten the window in
which it is visible without removing the cause, so cost is treated here as a
secondary benefit.

Two observations from a real desktop session support one hypothesis.

1. **The projection stages do not share a revision authority.** Four stages
   report their own `revision`, and they drift systematically — not merely at the
   end of the run. At one sampled instant `canonical` and `visible` were at 13
   while `viewport-rendered` and `selected-session` were at 15; across the run
   the maxima were 27, 27, 28 and 30. The layer that draws is therefore ahead of
   the layer that decides what is true, which is exactly the shape of a
   transient duplicate that a later write repairs.
2. **The transcript is replaced wholesale on more paths than it needs to be.**
   A `transcript.snapshot-hydrate` write targets the whole `collection`. It
   fired eight times, seven of them inside a 90 ms burst across seven different
   sessions. Reconnect catch-up independently replaces a session's messages with
   a bounded refetch.

The repair is to give the projection one revision owner, and to make a
whole-collection rewrite a deliberate, bounded event rather than a routine one.

## Evidence

From the 2026-08-04 desktop run (local send-workflow mirrors):

| Signal | Observation |
| --- | --- |
| Stage revisions | `canonical` 27, `visible` 27, `viewport-rendered` 28, `selected-session` 30 |
| Drift is not terminal-only | At 19:20:44.339: canonical 13, visible 13, viewport-rendered 15, selected-session 15 |
| Whole-collection writes | `transcript.snapshot-hydrate` → `collection`, 8 occurrences |
| Burst | 7 of those within 19:20:32.501–19:20:32.592, each a different session |
| Incremental writes | `sse.part.updated` 58, `sse.message.updated` 22 |
| Reconnect in the same run | `live → reconnecting → catching-up → live` at 19:20:05–19:20:08 |

The reconnect matters because catch-up refetches a bounded window of messages and
replaces the session's list. The user also reported the connection banner
appearing once in this session, which is consistent.

## Current-code audit

This section separates what the traces prove from what still needs reading.

**Established from traces**

- Four projection stages each emit a `revision`, and those counters are not the
  same sequence.
- A whole-collection transcript write exists and is used for hydration.
- Incremental part/message writes dominate normal streaming, so the
  wholesale path is the exception rather than the steady state.

**Still to confirm in code**

- Which stage, if any, is intended to be authoritative today.
- Whether `viewport-rendered` and `selected-session` derive from the canonical
  projection or maintain independent state that can be written directly.
- Whether the duplicate render comes from a stale row surviving a rewrite, or
  from two stages disagreeing about the same row for one frame.
- Whether the reconnect catch-up replacement and the hydration burst can
  interleave for the same session.

Do not begin implementation until the second list is answered; the fix differs
depending on whether the drift is a derivation bug or a write-path bug.

## Required invariants

1. One revision authority. Presentation stages read it; they never advance a
   revision of their own.
2. A rendered transcript is always a projection of canonical state. A stage may
   lag it, but may never be ahead of it.
3. A whole-collection rewrite is a bounded, explicit event with a recorded
   reason. It is never the routine path for normal streaming updates.
4. A rewrite must not resurrect, duplicate, or reorder rows that canonical state
   no longer contains.
5. Reconnect catch-up may refresh a session, but its bounded refetch must
   reconcile against canonical identity rather than replace by position.
6. No user-visible state may depend on a later unrelated write to become
   correct.
7. Diagnostics stay content-free: revisions, counts, owners and reasons only.

## KISS implementation plan

### Slice 1 — make the drift explainable before changing it (P0)

1. Record, on every projection boundary, both the stage revision and the source
   revision it was derived from.
2. Record the owner and reason on every whole-collection write.
3. Reproduce the reported sequence — queue a message, let it deliver, observe
   the transcript — and capture the traces.
4. Determine from that capture whether the stages diverge because they derive
   from different inputs or because one is written directly.

**Exit criterion:** the drift can be attributed to a specific write path, with a
capture that shows it.

### Slice 2 — one revision authority (P0)

1. Make canonical projection the only writer of the revision.
2. Change presentation stages to carry the canonical revision they rendered,
   not their own counter.
3. Add an assertion that a presented revision is never greater than canonical.
   Treat a violation as a defect, not as a state to tolerate.
4. Add focused tests for: a stage lagging canonical is acceptable; a stage ahead
   of canonical is rejected; a rewrite followed by an incremental update leaves
   exactly one row per canonical message.

**Exit criterion:** no stage can report a revision the canonical projection has
not reached.

### Slice 3 — bound the whole-collection rewrite (P1)

1. Give hydration an explicit reason and keep it out of the steady-state path.
2. Establish whether the seven-session burst is necessary at that moment or is
   eager work that could be demand-driven; if eager, make it demand-driven.
3. Make reconnect catch-up reconcile by canonical message identity instead of
   replacing the list, so a refetch cannot reorder or duplicate.
4. Only after correctness is settled, measure whether the remaining rewrite cost
   is worth reducing further. Do not tune before the invariant holds.

**Exit criterion:** a whole-collection rewrite happens for a stated reason, and
cannot change what the user already correctly saw.

## Verification matrix

| Scenario | Required proof |
| --- | --- |
| Queued message delivered | Exactly one assistant row per canonical assistant message, at every stage, without waiting for a later write. |
| Reconnect during an active conversation | Catch-up reconciles by identity; no duplicate or reordered rows. |
| Hydration burst | Whole-collection writes carry a reason and do not affect the active session's rendered rows. |
| Stage revisions | No stage ever reports a revision greater than canonical. |
| Streaming updates | Part and message updates stay incremental; no wholesale rewrite is triggered. |
| Diagnostics | Revision and rewrite records contain no transcript content. |

## Explicit non-goals

- treating this as a rendering performance problem and tuning cost before the
  revision invariant holds;
- rewriting the transcript store or introducing a second projection pipeline;
- changing message delivery, admission, queueing, or runtime lifecycle;
- removing hydration or reconnect catch-up, both of which are legitimate;
- implementing the broader discriminated transcript-render-item migration from
  the 2026-07-18 plan as a prerequisite for this repair.

## Why this is the KISS boundary

```text
a presentation stage
  --must not advance--> a revision of its own

a rendered row
  --must not exist--> without a canonical row behind it

a whole-collection rewrite
  --must be--> bounded, explained, and not the steady-state path

a correct on-screen state
  --must not require--> a later unrelated write to stay correct
```
