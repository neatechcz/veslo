---
title: Send Workflow Trace Volume and Sidebar Smoothness Plan
date: 2026-07-13
status: proposed
done: false
repository_snapshot: current veslo-main working tree
scope: development trace transport and sidebar activity diagnostics
---

# Send Workflow Trace Volume and Sidebar Smoothness Plan

## Decision

Keep durable run lifecycle, SSE ingestion, transcript reconciliation, and the
sidebar activity projection unchanged. Reduce work that is purely diagnostic:

1. do not emit a persistent sidebar trace for transitions where both the old
   and new values are inactive;
2. deliver trace entries to the desktop process in bounded batches rather
   than one Tauri IPC request and one flushed file write per browser event;
3. retain immediate delivery only for errors and terminal diagnostic events;
4. make high-cardinality detail opt-in through a verbose trace mode.

This is a diagnostics transport fix, not a change to session state ownership
or the spinner's activation contract.

## Evidence

The newest inspected dev runtime started at `2026-07-13T00:07:11.684Z`
(`02:07:11.684 CEST`) and produced 326 merged trace entries.

| Category | Count | Interpretation |
| --- | ---: | --- |
| `sidebar-session-activity:transition` | 115 | activity-projection diagnostics |
| `null -> { active: false, phase: idle }` | 99 | first projection of 99 hydrated historical sidebar rows |
| meaningful active transitions | 13 | three sends: activate, authority/phase handoff, run, terminal release |
| assistant SSE message/part traces | 15 | normal updates for those three responses |

The trace file is append-only across runtimes. Its full 10,076-line size is
not evidence for a single run. Earlier runtime segments nevertheless show the
same startup pattern: 147, 148, 100, 49, and 149 initial-idle activity traces.
One older segment additionally contains 266 row mount/unmount diagnostics.

The high volume has a concrete transport cost. `recordSendWorkflowTrace()`:

```text
pushes an in-memory entry
  -> invokes Tauri `log_ui_event` once per entry
    -> serializes JSON
    -> appends a line under a process-wide mutex
    -> flushes the file
    -> writes stderr
    -> forwards to the debug-log forwarder
```

The browser call is fire-and-forget, so it does not synchronously block a
render. It can still queue hundreds of IPC requests and corresponding Rust
commands during startup. On a desktop application this is unnecessary main
process, stderr, file-system, and forwarding work close to UI hydration.

## Confirmed non-findings

- The latest three sends do **not** contain an activity bounce while one run
  is active. Each follows `idle -> submitted -> running -> idle`.
- `session.idle` is intentionally deferred to lifecycle reconciliation; it
  arrives before the terminal activity release and is not itself a spinner
  restart.
- The 99 initial-idle records are diagnostics, not 99 visible spinner state
  writes.
- The earlier row mount/unmount traces belong to an older runtime segment.
  They cannot be used as evidence that the current runtime remounted 203 rows.

## Target Contract

### Sidebar activity trace contract

The activity projection continues to update normally for every row. Its
persistent diagnostic trace emits only one of:

- `inactive -> active`;
- `active -> inactive`;
- active phase/source change when verbose tracing is enabled;
- any transition to `phase: error`.

It must not emit initial inactive rows, inactive source changes, inactive row
removal, or an active phase change in ordinary tracing. This gives a normal
send at most two sidebar trace events: start and terminal release.

### Trace-delivery contract

- The browser keeps its existing bounded 2,000-entry in-memory diagnostic
  buffer immediately.
- Normal persistent trace entries are queued and sent in an ordered batch at
  most once every 100 ms, with a maximum batch size (for example 64 entries).
- Error and terminal entries flush the pending batch first and are delivered
  immediately.
- A batch is one IPC command, one lock acquisition, one append-open, and one
  file flush per destination, while preserving one NDJSON line per entry.
- If batch delivery fails, browser diagnostics remain available and the send
  path must remain unaffected.
- Existing single-event `log_ui_event` remains available for unrelated UI
  diagnostics. Do not change its semantics globally.

### Verbose contract

`VESLO_SEND_WORKFLOW_TRACE_VERBOSE=1` (or the equivalent existing browser
debug flag) enables high-cardinality events such as active phase/source
handoffs, per-part SSE updates, and row-level projection detail. Ordinary
`VESLO_SEND_WORKFLOW_TRACE=1` remains suitable for normal local diagnosis.

## Implementation slices

### TVS01 — Remove redundant sidebar activity diagnostics

**Owner:** `packages/app/src/app/app.tsx`

The activity trace effect must compare old and new projection values but only
record the contract events above. Preserve the projection map itself; this is
strictly a diagnostic filter.

The working tree already contains the minimum first guard:

```ts
if (!previous?.active && !current?.active) continue;
```

Refine it before landing so `active -> active` phase/source changes are also
ordinary-trace silent, except for `error` or explicit verbose mode. Add a
source-level test covering an initial 99-row projection and asserting zero
persistent sidebar trace calls.

### TVS02 — Batch only send-workflow trace transport

**Owners:**

- `packages/app/src/app/lib/send-workflow-trace.ts`
- `packages/app/src/app/lib/tauri.ts`
- `packages/desktop/src-tauri/src/commands/misc.rs`
- `packages/desktop/src-tauri/src/lib.rs`

Introduce a dedicated batched command for `send-workflow-trace`, rather than
changing `log_ui_event` or every existing caller:

```ts
appendSendWorkflowTraceBatch(entries: readonly TraceEntry[]): Promise<void>
```

The browser module owns the queue, timer, batch-size split, ordering, and
critical flush. The Rust handler accepts an ordered array of already serialized
NDJSON entries and appends them while holding the existing trace write lock.
It must call `flush` once after the complete batch, not once per entry.

Do not route the batched trace back through `log_ui_event`: that would retain
the per-entry stderr and debug-forwarder work which this slice intends to
avoid. Instead emit one compact batch-level stderr diagnostic only when the
verbose mode is enabled or a write fails.

### TVS03 — Classify existing high-volume trace producers

**Owners:** `session-event-stream.ts`, `session-transcript-controller.ts`,
`session-selection-controller.ts`, and `send-workflow-trace.ts`

Add an optional trace priority:

```ts
type SendWorkflowTracePriority = "normal" | "critical" | "verbose";
```

Keep the default `normal` for existing send milestones to avoid a broad
behavior change. Mark per-part updates, repeated transcript scheduling,
configuration comparisons, and row diagnostics `verbose`. Mark terminal
errors and terminal lifecycle result diagnostics `critical`.

This slice is deliberately after batching. It should use runtime counts from
a fresh baseline to select the remaining producers, not mechanically relabel
every trace call.

## Tests

1. Unit-test trace classification: initial inactive projection, inactive
   metadata change, and inactive row deletion produce no normal trace.
2. Unit-test that `inactive -> active`, `active -> inactive`, and error release
   are retained; active phase handoff appears only in verbose mode.
3. Test batching with a fake Tauri transport:
   - 65 normal entries become batches of 64 and 1 in original order;
   - a critical entry flushes normal entries first;
   - a failed transport does not throw into the caller;
   - memory buffer still receives every entry.
4. Rust command test: an N-entry batch yields N valid NDJSON lines and only
   uses the dedicated trace file path.
5. Regression test: ordinary trace mode does not invoke generic
   `log_ui_event` once for each send-workflow entry.

Use the established form:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm <focused-tests>
pnpm --filter @neatech/veslo-ui typecheck
cargo test -p veslo-desktop <focused-tests>
git diff --check
```

## Runtime acceptance test

Start a fresh desktop runtime, select a workspace with roughly 100 existing
sessions, then send three short prompts in the same session.

Expected ordinary trace result:

- zero `null -> idle` sidebar trace events at hydration;
- at most two sidebar events per completed send;
- no per-part SSE or active phase-handoff lines unless verbose mode is enabled;
- far fewer UI-to-Tauri calls than trace entries, with ordered NDJSON output;
- spinner remains visually continuous from activation through terminal
  lifecycle release.

Compare responsiveness and trace counts with the current 326-event runtime.
This plan does not claim that logging was the only possible cause of a visual
stutter; it removes a confirmed avoidable source of IPC and synchronous disk
flush traffic first.

## Out of scope

- changing conversation-run ownership or lifecycle semantics;
- changing SSE routing or durable transcript ingestion;
- changing the sidebar data model or session ordering;
- broad logging-system replacement;
- hiding real errors to reduce log volume.
