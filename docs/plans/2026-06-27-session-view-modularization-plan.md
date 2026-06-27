---
title: Session View Modularization Implementation Plan
date: 2026-06-27
target: packages/app/src/app/pages/session.tsx
done: true
---

# Session View Modularization Implementation Plan

## Goal

Reduce `packages/app/src/app/pages/session.tsx` from a high-risk page monolith into a small
integration shell plus a few durable domain modules. The public `SessionView` entry point and the
existing caller in `packages/app/src/app/app.tsx` should remain stable during the first pass.

The final `done: true` value is allowed only after every phase below has its own `done: true`, the
phase progress log names the test that was written or updated first, and the verification commands
pass.

## Audit Snapshot

Current risk profile for `session.tsx`:

- 5,600+ lines in one page component.
- Large `SessionViewProps` facade with roughly 180 props.
- Many reactive roots: signals, memos, effects, mount hooks, cleanup hooks, event listeners,
  timeouts, and intervals.
- High churn and high product impact: session sending, queueing, pending sessions, scrolling,
  search, command palette, sharing, sidebars, and composer wiring all converge in one file.
- Existing tests include several source-contract tests that directly read `session.tsx`; those tests
  must be updated deliberately when behavior moves into modules.

## Non-Goals

- Do not rename or shrink `SessionViewProps` in the first implementation pass.
- Do not change the external `SessionView` call site in `app.tsx` unless a phase explicitly proves
  it is required.
- Do not split into tiny helper files such as one file per label, toast, or boolean flag.
- Do not move JSX first while leaving orchestration logic tangled in `session.tsx`.
- Do not rewrite the page to a class-based architecture during this plan. Use controller/factory
  modules with clear dependency injection; class boundaries can be reconsidered after the behavior is
  modular and covered.
- Do not mix visual redesign with extraction.

## Module Size Rule

Create a module only when it owns a durable domain boundary and enough state to justify the file.
Prefer one coherent controller over several small utility modules.

Target module size guidance:

- Pure model helpers can be smaller when they are heavily tested and reused.
- Controllers should usually be larger than roughly 150 lines.
- Avoid modules that only wrap one accessor, one setter, or one JSX fragment.

## Test-First Rule

Before extracting each module:

1. Add or update the behavior test that captures the expected contract.
2. Run the focused test and record the result in the progress log.
3. Extract the module.
4. Run the same focused test again.
5. Run the broader verification set for the phase.
6. Only then change the phase from `done: false` to `done: true`.

If an existing test already covers a phase, the implementation log must name that existing test
before code is moved. If an existing source-contract test becomes brittle because code moved out of
`session.tsx`, convert it to assert the new module or the behavior instead of weakening coverage.

## Verification Commands

Focused existing checks:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-pending-instance.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-transcript-viewport.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/workspace-share-controller.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-composer-entry.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-escape-stop-confirmation.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts
```

Phase completion check:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-transcript-viewport.test.ts src/app/tests/pages/workspace-share-controller.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts
```

Use `pnpm --filter @neatech/veslo-ui test:unit` as the final broad app-side check if the focused
suite passes and the phase touches shared behavior.

## Phase 0: Baseline Guardrails

done: true

Purpose:

- Freeze the current behavior contracts before moving code.
- Identify source-contract tests that will fail only because code moved.
- Add one modularization contract test that prevents replacing one monolith with many tiny files.

Target files:

- `packages/app/src/app/pages/session.tsx`
- `packages/app/src/app/pages/session-pending-instance.test.ts`
- `packages/app/src/app/tests/pages/session-message-queue.test.ts`
- `packages/app/src/app/tests/pages/session-scroll-behavior.test.ts`
- New test if needed: `packages/app/src/app/tests/pages/session-view-modularization.test.ts`

Tasks:

- id: P0.1
  done: true
  task: Inventory all tests that read `session.tsx` source directly and classify each as behavior,
    wiring, or brittle source placement coverage.
- id: P0.2
  done: true
  task: Add or update a modularization contract test that allows durable session modules but rejects
    accidental tiny-module fragmentation.
- id: P0.3
  done: true
  task: Record the current focused test results before any extraction.

Source-contract inventory:

- Behavior/source placement tests to convert during Phase 1 or Phase 2 when logic moves:
  `packages/app/src/app/pages/session-pending-instance.test.ts`,
  `packages/app/src/app/tests/pages/session-message-queue.test.ts`,
  `packages/app/src/app/tests/pages/session-message-replacement.test.ts`,
  `packages/app/src/app/tests/pages/session-scroll-behavior.test.ts`,
  `packages/app/src/app/tests/pages/session-inline-loading.test.ts`,
  `packages/app/src/app/tests/pages/workspace-switching-specific-bugs.test.ts`.
- Wiring/layout/source contract tests to keep or retarget as shell components appear:
  `packages/app/src/app/tests/app-feedback-flow.contract.test.ts`,
  `packages/app/src/app/pages/session-composer-entry.test.ts`,
  `packages/app/src/app/pages/session-escape-stop-confirmation.test.ts`,
  `packages/app/src/app/tests/components/layout/global-sidebar-prefs.test.ts`,
  `packages/app/src/app/tests/components/session/composer-screenshot-staging-regression.test.ts`,
  `packages/app/src/app/tests/components/session/session-center-width.test.ts`,
  `packages/app/src/app/tests/components/session/session-typography.test.ts`,
  `packages/app/src/app/tests/components/session/workspace-session-list-prefetch.test.ts`,
  `packages/app/src/app/tests/components/sidebar-status-controls-account-menu.test.ts`,
  `packages/app/src/app/tests/pages/session-admin-ai-access.test.ts`,
  `packages/app/src/app/tests/pages/session-navigation.test.ts`,
  `packages/app/src/app/tests/pages/session-permission-path-layout.test.ts`,
  `packages/app/src/app/tests/pages/session-sidebar-navigation-context.test.ts`,
  `packages/app/src/app/tests/pages/session-sidebar-navigation-layout.test.ts`,
  `packages/app/src/app/tests/pages/session-titlebar-layout.test.ts`,
  `packages/app/src/app/tests/pages/session-todo-panel-layout.test.ts`,
  `packages/app/src/app/tests/pages/sidebar-archived-settings-navigation.test.ts`,
  `packages/app/src/app/tests/pages/sidebar-directory-session-wiring.test.ts`,
  `packages/app/src/app/tests/pages/sidebar-update-prompt-actions.test.ts`,
  `packages/app/src/app/tests/reload-banner-i18n.test.ts`.
- Path fixture only: `packages/app/src/app/tests/components/session/artifact-family-model.test.ts`.

Completion criteria:

- The focused existing checks run.
- Any failing baseline is documented before extraction starts.
- No production code is moved in this phase unless a test path must be corrected.

## Phase 1: Conversation Flow Controller

done: true

Purpose:

Extract the highest-risk behavior first: prompt sending, optimistic pending submit, pending session
instance handoff, queued drafts, run state, cancel/retry, and edit queue actions.

Target module:

- `packages/app/src/app/pages/session-conversation-flow.ts`

Existing related modules:

- `packages/app/src/app/components/session/session-queue-model.ts`
- `packages/app/src/app/components/session/pending-submit-model.ts`
- `packages/app/src/app/components/session/pending-session-instance-model.ts`
- `packages/app/src/app/components/session/session-loading-state-model.ts`

Behavior to own:

- Queue identity and captured session keys.
- Pending submit lifecycle.
- Pending session instance key creation and materialized handoff.
- `sendPromptImmediate` and `handleSendPrompt` orchestration.
- Queue drain and `sendNow` bypass behavior.
- Runtime idle/busy state as exposed to the page.
- Cancel and retry handlers.
- Queued draft edit and user message replacement handlers.

Test first:

- Add or update `packages/app/src/app/tests/pages/session-conversation-flow.test.ts`.
- Keep existing focused tests green:
  - `src/app/pages/session-pending-instance.test.ts`
  - `src/app/tests/pages/session-message-queue.test.ts`
  - `src/app/tests/pages/session-message-replacement.test.ts`
  - `src/app/tests/components/session/session-queue-model.test.ts`
  - `src/app/tests/components/session/pending-submit-model.test.ts`
  - `src/app/components/session/pending-session-instance-model.test.ts`
  - `src/app/tests/components/session/session-loading-state-model.test.ts`

Required test cases:

- id: P1.T1
  done: true
  task: First send on a pending session creates the pending instance key and optimistic submit.
- id: P1.T2
  done: true
  task: Materialized session handoff remaps queue state, pending submit state, and run state.
- id: P1.T3
  done: true
  task: Send failure after materialization restores the failed optimistic draft to the correct
    pending key.
- id: P1.T4
  done: true
  task: Queue drain uses the captured session key instead of the currently active session.
- id: P1.T5
  done: true
  task: `sendNow` bypasses the queue and unpauses only after the send is accepted.
- id: P1.T6
  done: true
  task: Session switch preserves visible run state until the runtime is actually idle.

Implementation tasks:

- id: P1.0
  done: true
  task: Extract run-state equality/update helpers and pending queue/pause/run remap helpers into
    `session-conversation-flow.ts`; keep async send orchestration in `session.tsx` until the next
    test-first slice.
- id: P1.0a
  done: true
  task: Extract `handleSendPrompt` branch selection into `resolveSendPromptAction` so queue/edit/send
    decision priority is behavior-tested outside `session.tsx`.
- id: P1.0b
  done: true
  task: Extract queue-drain start/completion decisions into `session-conversation-flow.ts` so stale
    pending navigation and remapped queue ownership are behavior-tested outside `session.tsx`.
- id: P1.0c
  done: true
  task: Extract session queue key and workspace-scope resolution into `session-conversation-flow.ts`
    so pending draft, private workspace, UI conversation scope, and legacy pending identity handling
    are tested as model behavior.
- id: P1.0d
  done: true
  task: Extract first-send pending handoff scope and failure cleanup decisions into
    `session-conversation-flow.ts`; keep the async send side effects in `session.tsx` until the
    controller extraction step.
- id: P1.0e
  done: true
  task: Extract pending handoff materialization validation and pending submitted draft cleanup/failure
    record transforms into `session-conversation-flow.ts`; keep the async callback and UI side effects
    in `session.tsx` until the controller extraction step.
- id: P1.1
  done: true
  task: Create the controller with explicit grouped dependencies instead of passing the full
    `props` object.
- id: P1.1a
  done: true
  task: Move `sendPromptImmediate` into `session-conversation-flow.ts` behind the controller
    dependency boundary; keep `session.tsx` as the dependency wiring shell for this send path.
- id: P1.1b
  done: true
  task: Move queue-drain orchestration and its per-session in-flight lock into
    `session-conversation-flow.ts`; keep `session.tsx` as the queue dependency wiring shell.
- id: P1.1c
  done: true
  task: Move the `handleSendPrompt` action switch into `session-conversation-flow.ts`, including
    queued edit save/send-now, append-to-queue, send-now, normal send, and transcript replacement
    branches; keep `session.tsx` as the trace and composer-entry dismissal wrapper.
- id: P1.1d
  done: true
  task: Move queued draft edit/cancel/move callbacks and transcript edit recovery into
    `session-conversation-flow.ts`; keep `session.tsx` as the JSX callback wiring shell.
- id: P1.1e
  done: true
  task: Move cancel/retry run orchestration into `session-conversation-flow.ts`, including queue
    pause before abort, abort busy state, stop confirmation clearing, retry fallback after abort
    failure, and toast sequencing.
- id: P1.1f
  done: true
  task: Move selected-session switch edit cleanup into `session-conversation-flow.ts`, including
    restoring an edited queued draft, clearing the previous session composer draft, and resetting
    queued/transcript edit state.
- id: P1.2
  done: true
  task: Move send, queue, pending-submit, pending-instance, cancel, retry, and edit orchestration
    from `session.tsx` into the controller. The immediate send, queue-drain, send action switch,
    queued edit save/send-now side effects, append branches, replacement send path, queued draft
    edit/cancel/move callbacks, transcript edit recovery, cancel run, and retry run are complete;
    session-switch queued edit restore wiring is complete.
- id: P1.3
  done: true
  task: Keep `session.tsx` as the integration layer that binds controller outputs to existing
    composer, message list, titlebar, and sidebar props.
- id: P1.4
  done: true
  task: Convert source-contract tests that assumed this logic lived directly in `session.tsx` to
    assert the controller or behavior instead.

Completion criteria:

- New controller tests pass before and after extraction.
- Focused session pending, queue, replacement, and model tests pass.
- `pnpm --filter @neatech/veslo-ui typecheck` passes.

Current status:

- done: true
- Completed first safe slice: `session-conversation-flow.ts` now owns run-state identity helpers and
  pending-to-real queue/pause/run remap helpers.
- Completed second safe slice: `session-conversation-flow.ts` now owns send action branch selection,
  while `session.tsx` remains responsible for the async side effects in each action branch.
- Completed third safe slice: `session-conversation-flow.ts` now owns queue-drain start/completion
  decisions, including stale pending navigation and remapped queue ownership.
- Completed fourth safe slice: `session-conversation-flow.ts` now owns queue key/workspace scope
  resolution for pending drafts, private chat workspaces, UI conversation refs, and legacy pending
  keys.
- Completed fifth safe slice: `session-conversation-flow.ts` now owns first-send pending handoff
  scope and failure cleanup decisions; `session.tsx` still performs the async effects.
- Completed sixth safe slice: `session-conversation-flow.ts` now owns pending handoff materialization
  validation plus pending submitted draft cleanup/failure record transforms; `session.tsx` still
  performs the callback, tracing, queue restore, scroll, and run-state side effects.
- Completed seventh safe slice: `session-conversation-flow.ts` now exposes
  `createSessionConversationFlow` with explicit dependency groups and owns the async
  `sendPromptImmediate` path, including optimistic submit, pending handoff materialization, AI-access
  blocking, replacement routing, stale-navigation cleanup, tracing, scroll intent, and run-state
  side effects through injected dependencies.
- Completed eighth safe slice: `session-conversation-flow.ts` now owns queue-drain orchestration,
  including the per-session in-flight lock, stale pending navigation guard, captured session key,
  accepted removal, rejected error marking, and remapped queue owner resolution through injected
  queue dependencies.
- Completed ninth safe slice: `session-conversation-flow.ts` now owns the `handleSendPrompt`
  action switch, including queued edit save/send-now, append-to-queue, explicit send-now, normal
  send, and transcript replacement branches. `session.tsx` now records send trace, dismisses the
  composer entry state, and delegates to the controller.
- Completed tenth safe slice: `session-conversation-flow.ts` now owns queued draft edit/cancel/move
  callbacks and transcript edit recovery for failed pending submitted messages. `session.tsx` now
  delegates queue list and message edit callbacks to the controller.
- Completed eleventh safe slice: `session-conversation-flow.ts` now owns cancel/retry run
  orchestration, including queue pause before abort, abort busy state, stop confirmation clearing,
  retry fallback after abort failure, and stop/retry toast sequencing.
- Completed twelfth safe slice: `session-conversation-flow.ts` now owns selected-session switch edit
  cleanup, including restoring an edited queued draft, clearing the previous session composer draft,
  and resetting queued/transcript edit state.
- Remaining in this phase: none.

## Phase 2: Transcript Viewport Controller

done: true

Purpose:

Extract transcript rendering-window and scrolling behavior after conversation state is stable. This
area is high impact because subtle regressions create lost context, jumping scroll, or hidden
messages.

Target module:

- `packages/app/src/app/pages/session-transcript-viewport.ts`

Behavior to own:

- `renderedMessages` and any batching/windowing policy.
- Hidden message count and reveal-earlier behavior.
- Initial bottom anchor and jump-to-latest behavior.
- Near-bottom detection.
- Stick-to-bottom behavior for incoming messages.
- Scroll throttling, timeout cleanup, and observer cleanup.

Test first:

- Add or update `packages/app/src/app/tests/pages/session-transcript-viewport.test.ts`.
- Keep existing focused tests green:
  - `src/app/tests/pages/session-scroll-behavior.test.ts`
  - `src/app/pages/session-pending-instance.test.ts`
  - `src/app/tests/components/session/session-center-width.test.ts` if layout assumptions are touched.

Required test cases:

- id: P2.T1
  done: true
  task: Initial transcript render anchors to the latest message without requiring user scroll.
- id: P2.T2
  done: true
  task: New assistant/user output sticks to bottom only when the viewport was already near bottom.
- id: P2.T3
  done: true
  task: Revealing earlier messages preserves the visual anchor instead of jumping to top or bottom.
- id: P2.T4
  done: true
  task: Cleanup clears observers, animation frames, and timers.
- id: P2.T5
  done: true
  task: Decide and test whether the currently bypassed batching path is intentionally removed or
    isolated behind the controller.

Implementation tasks:

- id: P2.1
  done: true
  task: Move viewport state and DOM-ref handlers into the controller with dependency injection for
    time and DOM operations where needed.
- id: P2.2
  done: true
  task: Keep message rendering JSX in `session.tsx` or the existing message components until scroll
    behavior is fully stable.
- id: P2.3
  done: true
  task: Replace brittle source assertions around scroll behavior with controller behavior assertions.

Completion criteria:

- New viewport tests pass before and after extraction.
- Existing scroll behavior tests pass.
- Typecheck passes.

Current status:

- done: true
- Test-first failure recorded: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm
  src/app/tests/pages/session-transcript-viewport.test.ts` failed with `ERR_MODULE_NOT_FOUND` before
  `session-transcript-viewport.ts` existed.
- Completed extraction: `session-transcript-viewport.ts` now owns rendered transcript windowing,
  optimistic-message inclusion, hidden/reveal decisions, server-history reveal handoff, initial
  bottom anchor scheduling, jump-to-latest scheduling, near-bottom sentinel detection, sticky
  bottom intent, scroll throttling, observer cleanup, timer cleanup, and the intentionally bypassed
  stream render batching policy.
- `session.tsx` now wires the transcript viewport controller, keeps JSX/layout in the page shell,
  and delegates viewport state, initial anchor behavior, reveal-earlier behavior, jump-to-latest,
  and scroll scheduling to the controller.
- `session-scroll-behavior.test.ts` now reads `session-transcript-viewport.ts` and verifies the
  moved source contracts against the controller instead of assuming the implementation lives in
  `session.tsx`.
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-transcript-viewport.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-view-modularization.test.ts`
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-transcript-viewport.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts src/app/tests/pages/session-admin-ai-access.test.ts`
- Verification passed: `pnpm --filter @neatech/veslo-ui typecheck`
- Verification passed: `git diff --check` with existing LF-to-CRLF warnings only.

## Phase 3: Shared Workspace Share Controller

done: true

Purpose:

Remove duplicated share/export orchestration from `session.tsx` and `dashboard.tsx` without changing
the user-facing share flows.

Target module:

- `packages/app/src/app/pages/workspace-share-controller.ts`

Affected files:

- `packages/app/src/app/pages/session.tsx`
- `packages/app/src/app/pages/dashboard.tsx`

Behavior to own:

- Local and remote Veslo share fields.
- Invite URL and invite token state.
- Disabled reasons and share availability.
- `resolveShareExportContext` style context resolution.
- Workspace profile link publishing.
- Skills set link publishing.
- Shared error and success status handling.

Test first:

- Add `packages/app/src/app/tests/pages/workspace-share-controller.test.ts`.
- Add or update wiring tests that confirm both session and dashboard use the shared controller.

Required test cases:

- id: P3.T1
  done: true
  task: Controller derives the same disabled reason for local, remote, and unavailable workspace
    states as the current session/dashboard flows.
- id: P3.T2
  done: true
  task: Publishing a workspace profile link uses the correct workspace context and preserves invite
    URL/token state.
- id: P3.T3
  done: true
  task: Publishing a skills set link uses the same context resolution in session and dashboard.
- id: P3.T4
  done: true
  task: Session and dashboard wiring call the shared controller instead of duplicating state blocks.

Implementation tasks:

- id: P3.1
  done: true
  task: Extract the shared controller with page-specific callbacks for notifications and modal
    presentation.
- id: P3.2
  done: true
  task: Replace session share state with controller outputs.
- id: P3.3
  done: true
  task: Replace dashboard share state with controller outputs.
- id: P3.4
  done: true
  task: Delete duplicated share helpers only after both pages pass the shared tests.

Completion criteria:

- Controller tests pass.
- Session and dashboard share wiring tests pass.
- Typecheck passes.

Current status:

- done: true
- Test-first failure recorded: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm
  src/app/tests/pages/workspace-share-controller.test.ts` failed with `ERR_MODULE_NOT_FOUND` before
  `workspace-share-controller.ts` existed.
- Completed extraction: `workspace-share-controller.ts` now owns workspace selection derivation,
  local/remote share fields, invite URL/token handling, direct-runtime note, share-service disabled
  reason, export disabled reason, local Veslo workspace id resolution, remote Veslo workspace id
  resolution, workspace profile publishing, skills-set publishing, clipboard best-effort handling,
  and busy/url/error modal state.
- `session.tsx` and `dashboard.tsx` now both instantiate `createWorkspaceShareController` and pass
  only page-specific dependencies such as workspace labels, translations, runtime availability,
  server settings, and the remote-token placeholder copy.
- Removed duplicated `WorkspaceProfileBundleV1`, `SkillsSetBundleV1`, local share field derivation,
  local workspace id lookup effects, export context resolution, publisher calls, and busy/error
  state blocks from both page files.
- Updated `workspace-switching-specific-bugs.test.ts` source windows for the current session source
  shape after earlier modularization moved/removed the old `soulModeEnabled`/`soulNavIconClass`
  markers.
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/workspace-share-controller.test.ts src/app/tests/pages/session-view-modularization.test.ts`
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/workspace-share-controller.test.ts src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/dashboard-menu-navigation.test.ts src/app/tests/pages/dashboard-sidebar-navigation-layout.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/components/session/workspace-session-list-prefetch.test.ts src/app/tests/pages/sidebar-directory-session-wiring.test.ts src/app/tests/pages/workspace-switching-specific-bugs.test.ts src/app/tests/app-feedback-flow.contract.test.ts`
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-transcript-viewport.test.ts src/app/tests/pages/workspace-share-controller.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts src/app/tests/pages/session-admin-ai-access.test.ts`
- Verification passed: `pnpm --filter @neatech/veslo-ui typecheck`
- Verification passed: `git diff --check` with existing LF-to-CRLF warnings only.

## Phase 4: Search And Command Controller

done: true

Purpose:

Extract message search and command palette orchestration after send/scroll behavior has stable
module boundaries. This lowers event-handler density in `session.tsx` without forcing a premature
visual split.

Target module:

- `packages/app/src/app/pages/session-search-command-controller.ts`

Behavior to own:

- Message text search query.
- Search hit collection and active hit navigation.
- Command palette open/close state.
- Command item derivation that depends on current session/workspace/UI state.
- Keyboard shortcut routing for search and palette commands where currently owned by `session.tsx`.

Test first:

- Add `packages/app/src/app/tests/pages/session-search-command-controller.test.ts`.
- Keep existing focused tests green:
  - `src/app/tests/pages/session-shortcuts.test.ts`
  - Any command/source contract test touched by this extraction.

Required test cases:

- id: P4.T1
  done: true
  task: Search hit derivation handles hidden/revealed transcript windows.
- id: P4.T2
  done: true
  task: Active search hit moves forward/backward and clamps safely when messages change.
- id: P4.T3
  done: true
  task: Command palette items respect disabled states from workspace, runtime, and session state.
- id: P4.T4
  done: true
  task: Shortcut handling opens and closes the expected controller state without stealing composer
    input.

Implementation tasks:

- id: P4.1
  done: true
  task: Extract search state and command state into one controller, not separate tiny modules.
- id: P4.2
  done: true
  task: Keep the visible palette JSX in `session.tsx` until the controller API is stable.
- id: P4.3
  done: true
  task: Convert source-contract tests to assert controller state transitions where useful.

Completion criteria:

- Search/command controller tests pass.
- Existing shortcut tests pass.
- Typecheck passes.

Current status:

- done: true
- Test-first failure recorded:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-search-command-controller.test.ts`
  failed with `ERR_MODULE_NOT_FOUND` before `session-search-command-controller.ts` existed.
- Completed extraction: `session-search-command-controller.ts` now owns search query state,
  debounced search scanning, active hit movement/clamping, match id derivation, command palette
  open/query/index state, root/session command item derivation, command title/placeholder
  derivation, and shortcut action routing.
- `session.tsx` now instantiates `createSessionSearchCommandController`, keeps search and command
  palette JSX local, delegates global search/palette shortcuts through
  `resolveSessionSearchCommandShortcut`, and keeps only DOM-specific effects such as scrolling the
  active hit and active command option into view.
- The controller exposes pure helpers for search scanning, active hit index movement/clamping,
  command item resolution with disabled metadata, and keyboard shortcut action resolution.
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-search-command-controller.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-view-modularization.test.ts`
- Verification passed: `pnpm --filter @neatech/veslo-ui typecheck`
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-transcript-viewport.test.ts src/app/tests/pages/session-search-command-controller.test.ts src/app/tests/pages/workspace-share-controller.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts src/app/tests/pages/session-admin-ai-access.test.ts`

## Phase 5: Shell Layout Split

done: true

Purpose:

Only after the main behavior controllers are extracted, split large JSX regions into page-local shell
components. This phase should make `session.tsx` readable without hiding business logic inside view
components.

Target modules:

- `packages/app/src/app/pages/session-left-sidebar.tsx`
- `packages/app/src/app/pages/session-right-sidebar.tsx`
- `packages/app/src/app/pages/session-center.tsx`

Existing related modules:

- `packages/app/src/app/pages/session-layout-width.ts`
- `packages/app/src/app/pages/session-titlebar-context.ts`
- `packages/app/src/app/pages/session-navigation.ts`
- `packages/app/src/app/components/session/sidebar-layout-model.ts`

Behavior to own:

- View composition only.
- Sidebar props grouping.
- Center transcript/composer layout props grouping.
- No send, queue, scroll, share, or command business logic.

Test first:

- Add or update source/wiring tests that assert the page composes the new shell components.
- Keep focused layout tests green:
  - `src/app/tests/pages/session-layout-width.test.ts`
  - `src/app/tests/components/session/session-center-width.test.ts`
  - `src/app/tests/components/session/session-typography.test.ts`

Required test cases:

- id: P5.T1
  done: true
  task: `SessionView` imports and renders the shell components.
- id: P5.T2
  done: true
  task: Left sidebar receives the same workspace/session navigation callbacks as before extraction.
- id: P5.T3
  done: true
  task: Right sidebar receives the same capability/share/settings callbacks as before extraction.
- id: P5.T4
  done: true
  task: Center layout keeps existing transcript, composer, disclaimer, and titlebar placement.

Implementation tasks:

- id: P5.1
  done: true
  task: Extract left sidebar JSX and prop grouping.
- id: P5.2
  done: true
  task: Extract right sidebar JSX and prop grouping.
- id: P5.3
  done: true
  task: Extract center transcript/composer JSX and prop grouping.
- id: P5.4
  done: true
  task: Remove dead local variables from `session.tsx` after each JSX move.

Completion criteria:

- Layout and typography tests pass.
- Typecheck passes.
- `session.tsx` is primarily an integration shell plus page-level wiring.

Current status:

- done: true
- Test-first failure recorded:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts`
  failed before `session-left-sidebar.tsx`, `session-right-sidebar.tsx`, and `session-center.tsx`
  existed or were imported by `session.tsx`.
- Completed extraction: `session-left-sidebar.tsx` now owns docked/overlay left sidebar framing,
  resize handle rendering, update-pill slot placement, `WorkspaceSessionList` composition,
  dashboard nav placement, and status controls placement.
- Completed extraction: `session-right-sidebar.tsx` now owns docked/overlay right sidebar framing,
  developer advanced nav placement, artifacts panel placement, and capabilities panel placement.
- Completed extraction: `session-center.tsx` now owns the main column wrapper and ordered center
  slots for search banner, reload banner, transcript, todo panel, composer/disclaimer area, and
  composer target conflict modal.
- Updated source-contract tests that previously asserted direct `WorkspaceSessionList` props or a
  direct `<main>` tag in `session.tsx` so they now assert the same wiring through shell props and
  `session-center.tsx`.
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-layout-width.test.ts src/app/tests/components/session/session-center-width.test.ts src/app/tests/components/session/session-typography.test.ts`
- Verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-transcript-viewport.test.ts src/app/tests/pages/session-search-command-controller.test.ts src/app/tests/pages/workspace-share-controller.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts src/app/tests/pages/session-admin-ai-access.test.ts src/app/tests/pages/session-layout-width.test.ts src/app/tests/components/session/session-center-width.test.ts src/app/tests/components/session/session-typography.test.ts src/app/tests/pages/sidebar-directory-session-wiring.test.ts`
- Verification passed: `pnpm --filter @neatech/veslo-ui typecheck`
- Verification passed: `git diff --check` with existing LF-to-CRLF warnings only.

## Phase 6: Cleanup And Documentation

done: true

Purpose:

Close the extraction safely and update docs/tests so future work starts at the right module instead
of re-growing `session.tsx`.

Target docs:

- `docs/dev/app-map.md`
- `docs/features/session-runtime.md`
- This plan file.

Tasks:

- id: P6.1
  done: true
  task: Update docs that tell engineers to start in `session.tsx` for send, scroll, share, search,
    command, or layout work.
- id: P6.2
  done: true
  task: Add a final progress log entry naming all modules created and final verification commands.
- id: P6.3
  done: true
  task: Set each completed phase to `done: true`.
- id: P6.4
  done: true
  task: Set the frontmatter `done: true` only after all phases are complete and verification passes.

Completion criteria:

- Relevant docs point to the new modules.
- No obsolete source-contract tests require business logic to live directly in `session.tsx`.
- Final focused checks and typecheck pass.

Current status:

- done: true
- Updated `docs/dev/app-map.md` so session work starts at the extracted controllers/shells for
  send, scroll, search, command palette, sharing, and layout issues.
- Updated `docs/features/session-runtime.md` so `session.tsx` is documented as the public page
  integration entry point, while behavior ownership points to the extracted modules.
- Final verification passed:
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-transcript-viewport.test.ts src/app/tests/pages/session-search-command-controller.test.ts src/app/tests/pages/workspace-share-controller.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts src/app/tests/pages/session-admin-ai-access.test.ts src/app/tests/pages/session-layout-width.test.ts src/app/tests/components/session/session-center-width.test.ts src/app/tests/components/session/session-typography.test.ts src/app/tests/pages/sidebar-directory-session-wiring.test.ts`
  passed with 263 tests.
- Final verification passed: `pnpm --filter @neatech/veslo-ui typecheck`
- Final verification passed: `git diff --check` with LF-to-CRLF warnings only.

## Expected Final Shape

Target structure after this plan:

```text
packages/app/src/app/pages/session.tsx
packages/app/src/app/pages/session-conversation-flow.ts
packages/app/src/app/pages/session-transcript-viewport.ts
packages/app/src/app/pages/session-search-command-controller.ts
packages/app/src/app/pages/session-left-sidebar.tsx
packages/app/src/app/pages/session-right-sidebar.tsx
packages/app/src/app/pages/session-center.tsx
packages/app/src/app/pages/workspace-share-controller.ts
```

Expected ownership:

- `session.tsx`: public `SessionView`, dependency wiring, controller composition, top-level page
  integration.
- `session-conversation-flow.ts`: send/queue/pending/run orchestration.
- `session-transcript-viewport.ts`: transcript windowing and scroll state.
- `workspace-share-controller.ts`: shared session/dashboard share/export orchestration.
- `session-search-command-controller.ts`: message search and command palette state.
- `session-*.tsx` shell components: large JSX regions only.

## Progress Log

Use this format for every implementation step:

```text
2026-06-27 - Phase N - test written/updated: `<path>` - module changed: `<path>` - verification: `<command>` passed/failed - done: false
```

2026-06-27 - Phase 6 complete - test written/updated: `docs/dev/app-map.md`, `docs/features/session-runtime.md`, `docs/plans/2026-06-27-session-view-modularization-plan.md` - module changed: `packages/app/src/app/pages/session-conversation-flow.ts`, `packages/app/src/app/pages/session-transcript-viewport.ts`, `packages/app/src/app/pages/session-search-command-controller.ts`, `packages/app/src/app/pages/workspace-share-controller.ts`, `packages/app/src/app/pages/session-left-sidebar.tsx`, `packages/app/src/app/pages/session-right-sidebar.tsx`, `packages/app/src/app/pages/session-center.tsx`, `packages/app/src/app/pages/session.tsx` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-transcript-viewport.test.ts src/app/tests/pages/session-search-command-controller.test.ts src/app/tests/pages/workspace-share-controller.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts src/app/tests/pages/session-admin-ai-access.test.ts src/app/tests/pages/session-layout-width.test.ts src/app/tests/components/session/session-center-width.test.ts src/app/tests/components/session/session-typography.test.ts src/app/tests/pages/sidebar-directory-session-wiring.test.ts` passed with 263 tests; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed with LF-to-CRLF warnings only - done: true

2026-06-27 - Phase 0 - test written/updated: `packages/app/src/app/tests/pages/session-view-modularization.test.ts`, `packages/app/src/app/pages/session-composer-entry.test.ts` - module changed: none - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-composer-entry.test.ts` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts` passed - done: true
2026-06-27 - Phase 1 partial - test written/updated: `packages/app/src/app/tests/pages/session-conversation-flow.test.ts`, `packages/app/src/app/pages/session-pending-instance.test.ts`, `packages/app/src/app/tests/pages/session-message-queue.test.ts` - module changed: `packages/app/src/app/pages/session-conversation-flow.ts`, `packages/app/src/app/pages/session.tsx` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-message-replacement.test.ts` passed; `pnpm --filter @neatech/veslo-ui typecheck` passed - done: false
2026-06-27 - Phase 1 partial - test written/updated: `packages/app/src/app/tests/pages/session-conversation-flow.test.ts`, `packages/app/src/app/tests/pages/session-message-queue.test.ts`, `packages/app/src/app/tests/pages/session-message-replacement.test.ts` - module changed: `packages/app/src/app/pages/session-conversation-flow.ts`, `packages/app/src/app/pages/session.tsx` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts` passed; `pnpm --filter @neatech/veslo-ui typecheck` passed - done: false
2026-06-27 - Phase 1 partial - test written/updated: `packages/app/src/app/tests/pages/session-conversation-flow.test.ts`, `packages/app/src/app/pages/session-pending-instance.test.ts`, `packages/app/src/app/tests/pages/session-message-queue.test.ts`, `packages/app/src/app/tests/pages/session-scroll-behavior.test.ts` - module changed: `packages/app/src/app/pages/session-conversation-flow.ts`, `packages/app/src/app/pages/session.tsx` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts` passed; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed with line-ending warnings only - done: false
2026-06-27 - Phase 1 partial - test written/updated: `packages/app/src/app/tests/pages/session-view-modularization.test.ts`, `packages/app/src/app/tests/pages/session-conversation-flow.test.ts`, `packages/app/src/app/pages/session-pending-instance.test.ts`, `packages/app/src/app/tests/pages/session-message-queue.test.ts`, `packages/app/src/app/tests/pages/session-scroll-behavior.test.ts`, `packages/app/src/app/tests/pages/session-message-replacement.test.ts`, `packages/app/src/app/tests/pages/session-admin-ai-access.test.ts` - module changed: `packages/app/src/app/pages/session-conversation-flow.ts`, `packages/app/src/app/pages/session.tsx` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts src/app/tests/pages/session-admin-ai-access.test.ts` passed; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed with line-ending warnings only - done: false
2026-06-27 - Phase 1 partial - test written/updated: `packages/app/src/app/tests/pages/session-conversation-flow.test.ts`, `packages/app/src/app/tests/pages/session-view-modularization.test.ts`, `packages/app/src/app/tests/pages/session-message-queue.test.ts` - module changed: `packages/app/src/app/pages/session-conversation-flow.ts`, `packages/app/src/app/pages/session.tsx` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts src/app/tests/pages/session-admin-ai-access.test.ts` passed; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed with line-ending warnings only - done: false
2026-06-27 - Phase 1 partial - test written/updated: `packages/app/src/app/tests/pages/session-conversation-flow.test.ts`, `packages/app/src/app/pages/session-pending-instance.test.ts`, `packages/app/src/app/tests/pages/session-message-queue.test.ts`, `packages/app/src/app/tests/pages/session-scroll-behavior.test.ts` - module changed: `packages/app/src/app/pages/session-conversation-flow.ts`, `packages/app/src/app/pages/session.tsx` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts` passed; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed with line-ending warnings only - done: false
2026-06-27 - Phase 1 partial - test written/updated: `packages/app/src/app/tests/pages/session-conversation-flow.test.ts` (new `controller.handleSendPrompt` remap-aware rejection test failed before implementation), `packages/app/src/app/tests/pages/session-message-queue.test.ts`, `packages/app/src/app/tests/pages/session-message-replacement.test.ts`, `packages/app/src/app/tests/pages/session-view-modularization.test.ts` - module changed: `packages/app/src/app/pages/session-conversation-flow.ts`, `packages/app/src/app/pages/session.tsx` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-view-modularization.test.ts` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts src/app/tests/pages/session-admin-ai-access.test.ts` passed; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed with line-ending warnings only - done: false
2026-06-27 - Phase 1 partial - test written/updated: `packages/app/src/app/tests/pages/session-conversation-flow.test.ts` (new queued draft edit action and transcript edit recovery controller tests failed before implementation), `packages/app/src/app/tests/pages/session-message-queue.test.ts`, `packages/app/src/app/tests/pages/session-message-replacement.test.ts`, `packages/app/src/app/tests/pages/session-scroll-behavior.test.ts` - module changed: `packages/app/src/app/pages/session-conversation-flow.ts`, `packages/app/src/app/pages/session.tsx` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-view-modularization.test.ts` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts src/app/tests/pages/session-admin-ai-access.test.ts` passed; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed with line-ending warnings only - done: false
2026-06-27 - Phase 1 partial - test written/updated: `packages/app/src/app/tests/pages/session-conversation-flow.test.ts` (new cancel/retry controller tests failed before implementation), `packages/app/src/app/tests/pages/session-message-queue.test.ts`, `packages/app/src/app/tests/pages/session-view-modularization.test.ts` - module changed: `packages/app/src/app/pages/session-conversation-flow.ts`, `packages/app/src/app/pages/session.tsx` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-view-modularization.test.ts` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts src/app/tests/pages/session-admin-ai-access.test.ts` passed; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed with line-ending warnings only - done: false
2026-06-27 - Phase 1 complete - test written/updated: `packages/app/src/app/tests/pages/session-conversation-flow.test.ts` (new session-switch edit cleanup controller test failed before implementation), `packages/app/src/app/tests/pages/session-message-queue.test.ts` - module changed: `packages/app/src/app/pages/session-conversation-flow.ts`, `packages/app/src/app/pages/session.tsx` - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-view-modularization.test.ts` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/pages/session-composer-entry.test.ts src/app/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-shortcuts.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-composer-drafts.test.ts src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/components/session/session-loading-state-model.test.ts src/app/tests/pages/session-admin-ai-access.test.ts` passed; `pnpm --filter @neatech/veslo-ui typecheck` passed; `git diff --check` passed with line-ending warnings only - done: true
