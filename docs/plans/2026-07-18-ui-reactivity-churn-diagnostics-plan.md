---
title: UI Reactivity Churn Diagnostics Plan
date: 2026-07-18
status: proposed
done: false
working_tree_scope: documentation-only plan; existing dirty application changes are excluded
scope: dev-only Solid UI reactivity and composer-focus diagnostics for manually controlled pnpm dev runs and .tmp trace analysis
---

# UI Reactivity Churn Diagnostics Plan

## Goal

Find UI work that is redundant: effects that run without a visible consequence,
state writes that preserve the same semantic state, and DOM commits that repeat
an unchanged UI model.

This is an observability-first change. It does not begin by rewriting effects
or trying to reduce their raw count. A reactive effect may correctly run more
than once. It is wasteful only when its execution produces an avoidable state
write, derived-model change, or DOM commit.

The operator runs the application manually through `pnpm dev`. Diagnostics are
read from the local `.tmp` trace files after a controlled interaction sequence.
This plan deliberately excludes Tauri Pilot, browser automation, and E2E
fixtures.

## First user-facing contract: composer focus stability

The first diagnostic slice is not generic render counting. It is the concrete
failure in which a user loses the ability to continue typing while a session is
streaming or receives a store/route update.

While the user is editing, the composer must retain the same
`editorInstanceId`, remain connected to the DOM, and retain focus unless a
known user-visible action authorizes a focus change. The allowed reasons are:

- the user clicked or tabbed to another control;
- an explicitly opened modal, picker, or command palette owns focus;
- navigation selected another session;
- the app window was hidden or lost operating-system focus;
- the composer itself was intentionally removed by a visible session branch.

Any other editor `focusout`, editor-node removal, or instance change is a
diagnostic incident. A prompt replacement is an incident only when it lacks an
authorized draft-mutation reason defined below. The contract is deliberately
not "always focus the editor during a stream"; forcing focus back would break
menus, modals, keyboard navigation, and accessibility.

Solid components run once and update fine-grained reactive expressions rather
than React-style re-rendering the whole component. The initial investigation
therefore targets named effects, conditional JSX branches, and actual DOM-node
replacement. It does not interpret a component function invocation as evidence
of a visible re-render.

## Current constraint: the observer can affect what it observes

The existing session diagnostics combine three useful signals:

1. `session-ui:state-change` records selected session presentation state.
2. `session-ui:render-source-mark` records a suspected render source.
3. `session-ui:dom-mutation-batch` records MutationObserver batches.

They are not yet a causal chain. More importantly, the temporary render-source
marker is held in a reactive signal and its developer badge is rendered inside
the session DOM subtree observed by `MutationObserver`. Updating the marker can
therefore produce a developer-only DOM mutation that is then attributed to the
application UI.

No conclusion about redundant rendering is trustworthy until this measurement
feedback loop is removed.

## Diagnostic contract

Every sampled UI change must be explainable by a short causal chain:

```text
external input or interaction
  -> named effect or controller
  -> state write
  -> derived UI model fingerprint changes or stays equal
  -> DOM commit in a named surface
```

The trace records identities, revisions, booleans, counts, stable hashes, and
component/effect labels only. It must never record message text, prompts, file
paths, credentials, or raw DOM HTML.

Instrumentation must be development-only and opt-in. It must not alter the
production render tree, the app's timing, request behavior, or persistence.

### Streaming revisions are explicit

Message count, part count, and stable message IDs do not distinguish a
legitimate streaming text update from a redundant commit: text can change while
all three remain equal. The message projection therefore owns two local,
non-content counters:

- `streamPartRevision` increments when a displayed streaming part changes its
  visible value. The trace contains the counter and part type, never the value.
- `displayRevision` increments when the visible message-block model changes
  structurally or `streamPartRevision` advances.

These counters are derived at the projection owner, not from MutationObserver
output and not from the existing recomputation counter. A commit after an
advancing `streamPartRevision` is an expected streaming delta. A commit with
unchanged `displayRevision` and `streamPartRevision` is a
redundant-commit candidate.

### Draft mutation reasons are explicit

An editor text difference is not automatically an incident. The composer
records a bounded `draftMutationReason` before each relevant editor write:

- `user-input`
- `submit-clear`
- `history-navigation`
- `slash-select`
- `session-switch`
- `external-sync`

The trace carries only the reason, editor instance, local revision, and text
lengths. These reasons authorize normal send, history, command, and session
flows. An incident is an active-editor text change without a valid reason, or
an `external-sync` whose caller cannot identify an authoritative source.

## Phase 1: make existing mutation diagnostics non-invasive

### Ownership

- `packages/app/src/app/pages/session.tsx`
- A small reusable dev-only helper under `packages/app/src/app/lib/`
- Focused tests beside the current session UI diagnostic tests

### Changes

1. Move render-source diagnostic state to a non-reactive trace buffer or a
   ref-like holder. It may feed `.tmp` events, but it must not cause a session
   render solely to update the diagnostic.
2. Remove the diagnostic badge from the observed session subtree, or explicitly
   exclude that node and all descendants from mutation collection.
3. Keep `MutationObserver` as a validation signal, not as the primary source
   of causality. Batch once per animation frame as today.
4. Record a single `ui-diagnostics:observer-ready` event describing whether the
   observer is enabled and which diagnostic nodes are excluded. Do not emit it
   repeatedly.

### Acceptance

- With an idle, loaded session and diagnostics enabled, the diagnostic marker
  may update without creating a DOM mutation batch.
- A mutation batch never names a diagnostic badge as its target.
- Disabling diagnostics leaves the session render path unchanged.

## Phase 2: introduce a sampled causal trace model

### Trace fields

Use a short-lived `causeId` that starts at a manual interaction or known
external input. An asynchronous continuation receives the cause explicitly;
there is no global ambient context that can leak between sessions.

`causeId` is never assigned to a DOM batch by whichever event happened last.
Every semantic state write allocates a monotonically increasing
`surfaceRevision` for its named surface and records its `causeId`. The surface
keeps a short revision journal until the animation-frame flush. A DOM batch
reports its observed revision range and the union of matching cause IDs. If the
relationship cannot be established, it is `unattributed`; if several writes
share a frame, it is `ambiguous` and retains every relevant ID. The tracer must
never guess one "latest" cause.

Add these events:

| Event | Meaning |
| --- | --- |
| `ui-cause:start` | A manual interaction, session event, or transcript ingest began a sampled chain. |
| `ui-effect:run` | A named high-fan-out effect executed, with its input revision fingerprint. |
| `ui-state:write` | The effect attempted a write; identify whether the next value is referentially and semantically changed. |
| `ui-model:derived` | A named UI model was re-evaluated; report its structural fingerprint and whether it changed. |
| `ui-dom:commit` | A MutationObserver batch reports its surface revision range, zero or more causes, and explicit attribution confidence. |
| `ui-cause:settled` | The cause completed; report aggregate effect runs, writes, model changes, and commits. |

For the composer-focus slice, add the following events to the same local ring
buffer rather than creating a second independent observer:

| Event | Meaning |
| --- | --- |
| `ui-focus:intent` | A named owner requested focus, with a reason label. |
| `ui-focus:changed` | `focusin` or `focusout`; identify only element role/type, composer instance, and whether the change is authorized. |
| `ui-composer:mount` / `ui-composer:dispose` | The composer editor lifecycle, using a generated non-content instance ID. |
| `ui-composer:dom-removed` | The active editor node was removed or replaced according to the existing session mutation observer. |

An incident persists a bounded five-second window around the event. Normal
focus activity stays in the in-memory ring buffer and is written only in the
per-cause summary. This prevents focus and effect instrumentation from adding
per-event Tauri IPC work to the typing path.

### Incident-window transport

The existing workflow trace persists every `recordSendWorkflowTrace` event
through Tauri IPC. The UI effect tracer must not call it for each effect, focus
change, or draft write.

Instead it owns a bounded local ring buffer enabled by
`VITE_VESLO_UI_EFFECT_TRACE=1`. On an incident it freezes a five-second
before/after window, coalesces identical entries, and makes one batched IPC
call with a `ui-effect-trace:incident-window` payload. The desktop side appends
that single payload to `.tmp`. A manual explicit dump uses the same batch
format; normal event flow remains local.

`semanticChanged: false` is the crucial signal. It means a computation or
write ran but produced the same modeled output. It is not automatically a bug;
the report ranks it for review.

### Sampling boundaries

Do not instrument every Solid signal or monkey-patch framework primitives.
That would be noisy, invasive, and unable to distinguish framework bookkeeping
from product work. Instrument only named owners that can fan out into visible
session rendering:

1. Session selection and route synchronization.
2. Transcript ingestion/projection and `displayedEffectiveMessages`.
3. Run presentation and composer availability.
4. Queue handoff and pending draft state.
5. Reload banner and workspace/runtime readiness state used by the session
   surface.
6. `MessageList` block derivation and its stable-key model.

Start with the session page. `app.tsx`, startup hydration, and connection
controllers are added only after a session trace demonstrates that their output
causes UI churn.

The initial named owners are intentionally concrete:

1. Composer mount's automatic focus request.
2. Composer `props.prompt` to editor synchronization, including each branch
   that calls the focus helper.
3. The global `veslo:focusPrompt` listener.
4. Session transcript/message-list derivation and conditional branches around
   the composer surface.
5. The existing session mutation observer, extended with active composer
   identity and focus state instead of adding another full-tree observer.

Every owner receives an explicit label and a pure input fingerprint. Do not use
automatic stack inspection or a generic effect wrapper across all Solid
effects.

### Fingerprints

Each owner supplies a small explicit fingerprint, such as:

- selected workspace/session ID and phase;
- message count, stable message IDs, part count, and streaming status;
- `displayRevision` and `streamPartRevision` for the message surface;
- composer mode and pending-draft key;
- boolean visibility state for a banner or indicator.

Arrays and records must be represented by stable IDs/counts or a bounded hash,
not serialized payloads. Fingerprint construction is a pure tested helper so
that a diagnostic cannot accidentally read unrelated reactive state.

## Phase 3: aggregate `.tmp` traces into findings

### New local script

Add a read-only Node script under `packages/app/scripts/` that consumes the
latest local UI trace files. It prints a deterministic report grouped by
`causeId`, surface, and effect owner.

It ranks:

1. Effect runs with no state write and no derived-model change.
2. Writes where `semanticChanged: false`.
3. Repeated equal `displayRevision`/`streamPartRevision` fingerprints followed
   by DOM commits.
4. More than one run of the same owner for the same input revision.
5. DOM commits with no active or recently settled cause.
6. High fan-out causes: one input that touches multiple independent session
   surfaces.

The report retains first/last timestamps and counts, not raw application
content. It must work against a manually captured `.tmp` directory and should
fail clearly if the expected trace schema is absent.

### Anti-noise rules

- Coalesce events inside an animation frame and summarize repeated identical
  fingerprints.
- Cap per-cause event volume, then emit one explicit truncation counter.
- Ignore the diagnostic DOM surface itself.
- Treat streaming token updates as an expected changing input; compare each
  update only to the immediately preceding explicit `streamPartRevision`.
- Keep multiple causes when one animation frame contains input, streaming, and
  overlay writes; do not collapse them to a guessed winner.
- Keep the existing general send trace separate. This plan adds a UI analysis
  layer rather than turning every normal trace into high-volume telemetry.

## Phase 4: manually operated scenarios

For each `pnpm dev` run, perform one scenario at a time and note its start in
the trace:

1. Open an already loaded session and leave it idle for ten seconds.
2. Switch between two loaded sessions without sending a message.
3. Send one short prompt, observe streaming, then wait for terminal transcript
   hydration.
4. Open and close the session sidebars without changing content.
5. Place a longer draft in the composer, keep typing while another prompt
   streams, and verify the editor remains connected, is the same instance, and
   keeps focus unless an allowed focus owner intervened.
6. Toggle one UI state such as the reload notice only when it is actually
   eligible to render.

The operator should avoid combining scenarios in one trace unless explicitly
testing interaction between them. The script accepts a time range or `causeId`
so a single `.tmp` directory can still contain multiple trials.

One deliberate concurrency trial is the exception: type in the composer while
an assistant stream updates. Its expected output is several cause IDs in the
same frame, or explicit `ambiguous`/`unattributed` attribution. It must never
report input as the sole cause merely because it happened last.

## Phase 5: fix only confirmed owners

For each top-ranked finding, add a focused regression test and make the
smallest owner-local change. Typical remedies are:

- turn an effect that only derives data into a memo;
- guard a setter against an equal semantic value;
- keep object/array identity stable when its visible fingerprint is equal;
- narrow an effect's reactive inputs;
- merge two effects that implement the same state transition.

Do not delete an effect merely because it ran frequently. Keep an effect when
it owns an external subscription, cleanup, persistence, or a distinct state
transition even if its visible output is unchanged.

## Completion criteria

The diagnostic phase is complete when:

1. Diagnostics cannot create their own observed DOM mutations.
2. A manual run can associate every material session DOM commit with a named
   cause, or explicitly reports it as unexplained.
3. The local report identifies the top redundant effect/write/commit chains by
   count and surface.
4. At least one confirmed redundant chain has an owner-local regression test
   and fix.
5. The reporting remains opt-in, development-only, and contains no user
   content or secrets.
6. A focus-loss incident can be classified as a composer remount, an explicit
   focus owner, prompt/store synchronization, or a long synchronous operation;
   it is never only an unexplained DOM batch.
7. Tests prove that a diagnostic marker creates no observed mutation record, an
   advancing streaming revision is not churn, authorized draft mutations are
   not incidents, and two causes in one frame remain separate or explicitly
   ambiguous.

## Verification commands

Run focused app tests and type checking after each instrumentation increment:

```powershell
pnpm --dir packages/app typecheck
pnpm --dir packages/app exec node --test --import=tsx/esm src/app/tests/pages/session-inline-loading.test.ts
pnpm --dir packages/app exec node --test --import=tsx/esm src/app/tests/app-view-props.test.ts
git diff --check
```

Then start the application manually with the diagnostic flag enabled, execute
one scenario above, and inspect the latest `.tmp` trace with the new report
script. No Tauri Pilot command is part of the acceptance path.

Add focused tests for the pure revision, draft-reason, incident-window, and
surface-attribution helpers. The general session tests above are regression
coverage only; they are not evidence that these new invariants hold.
