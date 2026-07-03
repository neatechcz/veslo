---
title: Session TSX Second-Pass Modularization Implementation Plan
date: 2026-07-02
target: packages/app/src/app/pages/session.tsx
status: planned
done: false
base_branch: main
base_commit: dffda49a
predecessor_plan: docs/plans/2026-06-27-session-view-modularization-plan.md
---

# Session TSX Second-Pass Modularization Implementation Plan

## Goal

Reduce `packages/app/src/app/pages/session.tsx` from a large page integration shell into a smaller
`SessionView` composition surface without re-opening the already completed session workflow
modularization.

The first pass already moved the highest-risk business workflows out of `session.tsx`: conversation
flow, transcript viewport, search/command palette, workspace sharing, sidebars, center layout,
attachment staging, send, creation, and mutation workflows now have durable owners. This plan is the
second pass. It targets the remaining shell-owned UI/runtime state, duplicated view models, local
desktop file actions, and the oversized `SessionViewProps` boundary.

The target shape is not "one helper per signal". Each new module must own a real boundary and must
be covered by focused behavior or source-contract tests.

## Current Audit Snapshot

Current checkout metrics from the review baseline:

- `packages/app/src/app/pages/session.tsx`: 3,949 physical lines.
- `SessionViewProps`: 190 lines and 165 top-level semicolon-terminated fields.
- `session.tsx` contains 58 imports, 17 `createSignal` declarations, 76 `createMemo`
  declarations, 29 `createEffect` declarations, and 420 `props.` references.
- SM00 must record the exact counting command/method before changing these metrics; raw substring
  counts are intentionally not used because they include imports and nested type members.
- The current source-contract guard passes and confirms the first-pass boundaries:
  `session-conversation-flow.ts`, `session-transcript-viewport.ts`,
  `session-search-command-controller.ts`, `workspace-share-controller.ts`,
  `session-left-sidebar.tsx`, `session-right-sidebar.tsx`, and `session-center.tsx`.
- `components/session/workspace-session-list.tsx` is also large, but it is out of scope for this
  plan. Treat it as the next hotspot after `session.tsx`.

## Non-Goals

- Do not rewrite `createSessionConversationFlow()` or move send orchestration back into the page.
- Do not change user-visible session behavior, route semantics, prompt send semantics, queue
  semantics, history resume behavior, or workspace activation policy as part of extraction.
- Do not split view fragments into tiny presentational files just to reduce line count.
- Do not redesign the session UI.
- Do not touch `components/session/workspace-session-list.tsx` except where a task explicitly needs
  a callback contract update.
- Do not create modules that import from `./session`; extracted modules must depend on typed inputs,
  not the page shell.

## Coordination Protocol

This plan is suitable for multiple agents.

Reservations happen in this file in the original worktree. Code changes happen only in a reserved
worktree.

Blocking precondition:

- This plan must be present in the baseline `HEAD` before parallel reservations start. Verify with
  `git ls-files --error-unmatch docs/plans/2026-07-02-session-tsx-second-pass-modularization-implementation-plan.md`.
  An untracked or merely staged plan is not enough because `git worktree add ... HEAD` will not
  include it for worker branches.

1. From the original worktree, run `git status --short`.
2. Pick one task with `status: available`, `reserved_by: null`, and all dependencies done.
3. Change only that task's reservation fields:
   - `status: reserved`
   - `reserved_by: <agent-name-or-session-id>`
   - `reserved_at: <ISO timestamp>`
   - `branch: sessiontsx/<task-id>-<slug>`
   - `worktree: ../veslo-sessiontsx-<task-id>-<slug>`
4. Create the worktree from the original checkout:

```bash
git worktree add ../veslo-sessiontsx-<task-id>-<slug> -b sessiontsx/<task-id>-<slug> HEAD
```

Rules:

- Do not edit product code in the original worktree.
- Do not reserve a task already reserved by another agent.
- Do not mark `done: true` from an agent worktree. Mark done only after merge and verification in
  the original worktree.
- Keep every task test-first: add/update the focused test, observe the expected failure if a new
  module or contract does not exist yet, implement, then run the same test green.
- Every new `session-*` page module must be added to
  `packages/app/src/app/tests/pages/session-view-modularization.test.ts`.

## Task Reservation Ledger

| id | task | status | reserved_by | done |
| --- | --- | --- | --- | --- |
| SM00 | second-pass baseline and source-contract triage | available | null | false |
| SM01 | sidebar layout controller | available | null | false |
| SM02A | run state lifecycle controller | available | null | false |
| SM02B | run indicator/progress controller | available | null | false |
| SM03 | empty-state and temporary runtime diagnostic boundary | available | null | false |
| SM04 | local file and artifact actions controller | available | null | false |
| SM05 | shared sidebar update pill model | available | null | false |
| SM06 | sidebar navigation and prefetch actions controller | available | null | false |
| SM07 | toast, reconnect, history-action, and flyout feedback controller | available | null | false |
| SM08 | grouped `SessionViewProps` boundary and final shell cleanup | available | null | false |
| SM09 | final docs and verification checkpoint | available | null | false |

## Shared Rules

### Module Boundary Rule

Use these locations:

- `packages/app/src/app/pages/` for page-local Solid controllers and page-owned view models.
- `packages/app/src/app/components/session/` for reusable session UI components or pure view models.
- `packages/app/src/app/lib/` only for runtime/client adapters that are not page-specific.

Do not put Solid signal/effect code under `controllers/`; that directory is for UI-framework
independent policy.

### Source-Contract Rule

Before each extraction, search for source readers:

```bash
rg -n "session\\.tsx|sessionSource|sessionPageSource" packages/app/src/app -g "*.test.ts"
```

Retarget brittle placement assertions to the new module. Keep wiring assertions in `session.tsx`
when the page must still compose the module explicitly.

Current direct source-reader seed inventory:

- Baseline/modularization contract:
  `src/app/tests/pages/session-view-modularization.test.ts`.
- Session queue/send/run source contracts:
  `src/app/pages/session-pending-instance.test.ts`,
  `src/app/tests/pages/session-message-queue.test.ts`,
  `src/app/tests/pages/session-inline-loading.test.ts`,
  `src/app/tests/pages/session-scroll-behavior.test.ts`,
  `src/app/tests/pages/session-message-replacement.test.ts`,
  `src/app/tests/pages/session-admin-ai-access.test.ts`.
- Empty/composer/titlebar/layout source contracts:
  `src/app/pages/session-composer-entry.test.ts`,
  `src/app/pages/session-escape-stop-confirmation.test.ts`,
  `src/app/tests/pages/session-titlebar-layout.test.ts`,
  `src/app/tests/pages/session-todo-panel-layout.test.ts`,
  `src/app/tests/pages/session-permission-path-layout.test.ts`,
  `src/app/tests/components/session/session-center-width.test.ts`,
  `src/app/tests/components/session/session-typography.test.ts`,
  `src/app/tests/components/session/composer-screenshot-staging-regression.test.ts`.
- Sidebar/navigation/prefetch/source contracts:
  `src/app/tests/pages/session-navigation.test.ts`,
  `src/app/tests/pages/sidebar-directory-session-wiring.test.ts`,
  `src/app/tests/pages/session-sidebar-navigation-context.test.ts`,
  `src/app/tests/pages/session-sidebar-navigation-layout.test.ts`,
  `src/app/tests/pages/sidebar-archived-settings-navigation.test.ts`,
  `src/app/tests/components/layout/global-sidebar-prefs.test.ts`,
  `src/app/tests/components/sidebar-status-controls-account-menu.test.ts`,
  `src/app/tests/components/session/workspace-session-list-prefetch.test.ts`,
  `src/app/tests/pages/workspace-switching-specific-bugs.test.ts`.
- Shared UI/update/reload/share source contracts:
  `src/app/tests/pages/sidebar-update-prompt-actions.test.ts`,
  `src/app/tests/reload-banner-i18n.test.ts`,
  `src/app/tests/app-feedback-flow.contract.test.ts`,
  `src/app/tests/pages/workspace-share-controller.test.ts`.
- Path fixture only, not a source-placement guard:
  `src/app/tests/components/session/artifact-family-model.test.ts`.

SM00 must replace this seed list with a complete inventory generated from the `rg` command above,
classify every entry by owning task, and explicitly mark path fixtures separately from real source
readers.

### Final Shell Shape

At the end of this plan, `session.tsx` should keep:

- `export type SessionViewProps` and `export default function SessionView(...)`.
- controller composition and dependency injection.
- top-level JSX slot composition for `SessionLeftSidebar`, `SessionRightSidebar`, and
  `SessionCenter`.
- minimal glue callbacks that connect page slots to controllers.

It should not keep:

- sidebar resize and overlay measurement internals.
- run-indicator tick/progress/stall machinery.
- local desktop file-open/reveal candidate resolution.
- duplicated update-pill label/tone/title logic.
- sidebar session-open/prefetch policy blocks.
- temporary diagnostics mixed into the main page body.
- large toast/flyout/history-action state clusters.

## Tasks

### SM00: Second-Pass Baseline And Source-Contract Triage

```yaml
id: SM00
status: available
reserved_by: null
reserved_at: null
branch: sessiontsx/sm00-baseline-source-contract-triage
worktree: ../veslo-sessiontsx-sm00-baseline-source-contract-triage
done: false
depends_on: []
target_files:
  - packages/app/src/app/tests/pages/session-view-modularization.test.ts
  - packages/app/src/app/pages/session.tsx
```

Purpose:

- Freeze the second-pass target before code movement.
- Update the modularization contract so planned second-pass modules are allowed and must be
  substantial.
- Record current metrics and source-reader inventory.

Implementation:

- Add planned module names from this plan to `allowedSessionPageModules` and
  `plannedExtractedModules`.
- Add or update assertions that prevent `session.tsx` from importing back from extracted modules that
  import `./session`.
- Add metric assertions only if they are stable enough to be useful. Prefer boundary assertions over
  brittle line-count caps.

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/pages/session-view-modularization.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

### SM01: Sidebar Layout Controller

```yaml
id: SM01
status: available
reserved_by: null
reserved_at: null
branch: sessiontsx/sm01-sidebar-layout-controller
worktree: ../veslo-sessiontsx-sm01-sidebar-layout-controller
done: false
depends_on: [SM00]
target_files:
  - packages/app/src/app/pages/session.tsx
  - packages/app/src/app/pages/session-sidebar-layout-controller.ts
  - packages/app/src/app/tests/pages/session-sidebar-layout-controller.test.ts
  - packages/app/src/app/tests/components/layout/global-sidebar-prefs.test.ts
  - packages/app/src/app/tests/pages/session-view-modularization.test.ts
```

Extract:

- `layoutRootWidth`
- left sidebar width and resize state
- docked/overlay state
- root-width measurement and `ResizeObserver` wiring
- Escape-to-close overlay behavior
- global docked/width preference persistence

Keep in `session.tsx`:

- refs for the root element if needed by JSX.
- passing `leftSidebar*` values into `SessionLeftSidebar`.
- one explicit composition call such as `const sidebarLayout = createSessionSidebarLayoutController(...)`.

Tests:

- Width changes reconcile docked/overlay mode through the existing pure layout model.
- Resizing persists only on pointer-up/cancel completion.
- Escape closes only the active overlay.
- Existing global sidebar prefs tests remain green.

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/pages/session-sidebar-layout-controller.test.ts \
  src/app/tests/components/layout/global-sidebar-prefs.test.ts \
  src/app/tests/pages/session-view-modularization.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

### SM02A: Run State Lifecycle Controller

```yaml
id: SM02A
status: available
reserved_by: null
reserved_at: null
branch: sessiontsx/sm02a-run-state-lifecycle-controller
worktree: ../veslo-sessiontsx-sm02a-run-state-lifecycle-controller
done: false
depends_on: [SM00]
target_files:
  - packages/app/src/app/pages/session.tsx
  - packages/app/src/app/pages/session-run-lifecycle-controller.ts
  - packages/app/src/app/tests/pages/session-run-lifecycle-controller.test.ts
  - packages/app/src/app/tests/pages/session-message-queue.test.ts
  - packages/app/src/app/tests/pages/session-view-modularization.test.ts
```

Extract:

- `runStateBySessionKey`
- run start/reset/preserve/remap helpers
- status effects that reset/preserve visible run UI when scoped session status changes

Do not extract or rewrite:

- actual send/queue orchestration in `createSessionConversationFlow()`
- transcript viewport ownership in `createSessionTranscriptViewport()`
- run labels, progress signatures, stall UI, or auto-scroll triggers; those belong to SM02B

Boundary:

- The new controller should accept typed dependencies for session status, scoped status maps,
  current queue key, pending optimistic draft state, session-key remapping, and trace/perf sinks.
- `createSessionConversationFlow()` should receive only the run-control hooks it already needs, now
  sourced from `sessionRunLifecycle`.

Tests:

- Status transitions to idle reset only the affected session key.
- Pending-to-real materialization remaps visible run state.
- Session switching preserves visible run state until runtime status actually becomes idle.
- Conversation-flow dependencies use the lifecycle controller hooks instead of local page functions.

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/pages/session-run-lifecycle-controller.test.ts \
  src/app/tests/pages/session-message-queue.test.ts \
  src/app/tests/pages/session-view-modularization.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

### SM02B: Run Indicator, Progress, Stall, And Autoscroll Controller

```yaml
id: SM02B
status: available
reserved_by: null
reserved_at: null
branch: sessiontsx/sm02b-run-indicator-progress-controller
worktree: ../veslo-sessiontsx-sm02b-run-indicator-progress-controller
done: false
depends_on: [SM02A]
target_files:
  - packages/app/src/app/pages/session.tsx
  - packages/app/src/app/pages/session-run-indicator-controller.ts
  - packages/app/src/app/tests/pages/session-run-indicator-controller.test.ts
  - packages/app/src/app/tests/pages/session-inline-loading.test.ts
  - packages/app/src/app/tests/pages/session-scroll-behavior.test.ts
  - packages/app/src/app/tests/pages/session-message-queue.test.ts
  - packages/app/src/app/tests/pages/session-view-modularization.test.ts
```

Extract:

- `responseStarted`
- `runPhase`
- `workspaceSendWarmupActive`
- run label and elapsed label
- tick interval used while the run indicator is visible
- latest visible assistant part detection
- thinking/status copy derivation
- progress signature, progress autoscroll trigger, and transcript-growth progress tracking
- stall thresholds and developer perf logging for soft/hard stall stages

Boundary:

- Use the lifecycle controller from SM02A for keyed run state reads/writes.
- Accept transcript viewport hooks for scroll scheduling and bottom-pin state; do not import the
  transcript viewport module back into this controller.
- Keep actual footer JSX composition in `session.tsx`.

Tests:

- Optimistic pending submit enters `responding` before assistant parts arrive.
- Cold workspace pending sends show `Loading` until backend progress starts.
- Run progress auto-scroll still uses the transcript viewport controller.
- Assistant part growth updates last-progress time and can recover a stall.
- Developer-only stall perf logging fires on stage changes, not every tick.

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/pages/session-run-indicator-controller.test.ts \
  src/app/tests/pages/session-inline-loading.test.ts \
  src/app/tests/pages/session-scroll-behavior.test.ts \
  src/app/tests/pages/session-message-queue.test.ts \
  src/app/tests/pages/session-view-modularization.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

### SM03: Empty-State And Temporary Runtime Diagnostic Boundary

```yaml
id: SM03
status: available
reserved_by: null
reserved_at: null
branch: sessiontsx/sm03-empty-state-diagnostic-boundary
worktree: ../veslo-sessiontsx-sm03-empty-state-diagnostic-boundary
done: false
depends_on: [SM00, SM02B]
target_files:
  - packages/app/src/app/pages/session.tsx
  - packages/app/src/app/pages/session-surface-state-controller.ts
  - packages/app/src/app/pages/session-runtime-ui-diagnostic.tsx
  - packages/app/src/app/tests/pages/session-inline-loading.test.ts
  - packages/app/src/app/pages/session-composer-entry.test.ts
  - packages/app/src/app/tests/pages/session-view-modularization.test.ts
```

Extract:

- workspace setup empty-state derivation
- composer entry target heading/state/dismissal
- footer composer target context state
- temporary runtime UI diagnostic snapshot and badge, if the diagnostic is still needed

Decision point:

- If the temporary diagnostic is obsolete, remove it with an explicit test update.
- If it is still needed, isolate it in `session-runtime-ui-diagnostic.tsx` so the main page does not
  carry the snapshot formatting and developer-only badge body.

Tests:

- Empty workspace setup waits for hydrated workspace metadata.
- First submit dismisses the centered composer entry and footer target context before backend
  handoff resolves.
- Developer-only runtime diagnostic remains hidden outside developer mode, or the obsolete diagnostic
  is removed intentionally with the source-contract test changed to match.

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/pages/session-composer-entry.test.ts \
  src/app/tests/pages/session-inline-loading.test.ts \
  src/app/tests/pages/session-view-modularization.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

### SM04: Local File And Artifact Actions Controller

```yaml
id: SM04
status: available
reserved_by: null
reserved_at: null
branch: sessiontsx/sm04-local-file-actions-controller
worktree: ../veslo-sessiontsx-sm04-local-file-actions-controller
done: false
depends_on: [SM00]
target_files:
  - packages/app/src/app/pages/session.tsx
  - packages/app/src/app/pages/session-local-file-actions.ts
  - packages/app/src/app/tests/pages/session-local-file-actions.test.ts
  - packages/app/src/app/tests/components/session/workspace-session-list-prefetch.test.ts
  - packages/app/src/app/tests/pages/workspace-switching-specific-bugs.test.ts
  - packages/app/src/app/tests/pages/session-view-modularization.test.ts
```

Extract:

- local file candidate resolution for workspace/outbox-relative paths
- open/reveal action retry across candidate paths
- remote/web/desktop guard messages
- `revealArtifact`
- `handleWorkingFileClick`
- `revealWorkspaceInFinder`

Boundary:

- Inject `join`, `isTauriRuntime`, `isWindowsPlatform`, opener functions, perf sinks, and
  `setToastMessage`.
- Keep UI callbacks in `session.tsx` as a small call-through object passed to sidebars/panels.

Tests:

- `outbox/`, `veslo/outbox/`, `.opencode/veslo/outbox/`, absolute, and normal relative paths
  resolve to the expected candidate list.
- Remote workspace and non-Tauri runtime produce localized toast reasons without importing the
  Tauri opener.
- Windows reveal uses `openPath`; other platforms use `revealItemInDir`.
- Candidate failures continue to the next path and report attempted-path count.

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/pages/session-local-file-actions.test.ts \
  src/app/tests/components/session/workspace-session-list-prefetch.test.ts \
  src/app/tests/pages/workspace-switching-specific-bugs.test.ts \
  src/app/tests/pages/session-view-modularization.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

### SM05: Shared Sidebar Update Pill Model

```yaml
id: SM05
status: available
reserved_by: null
reserved_at: null
branch: sessiontsx/sm05-shared-update-pill-model
worktree: ../veslo-sessiontsx-sm05-shared-update-pill-model
done: false
depends_on: [SM00]
target_files:
  - packages/app/src/app/pages/session.tsx
  - packages/app/src/app/pages/dashboard.tsx
  - packages/app/src/app/pages/dashboard-update-pill-model.ts
  - packages/app/src/app/components/sidebar-update-pill-model.ts
  - packages/app/src/app/tests/pages/dashboard-update-pill-model.test.ts
  - packages/app/src/app/tests/pages/sidebar-update-prompt-actions.test.ts
  - packages/app/src/app/tests/pages/session-view-modularization.test.ts
```

Extract/generalize:

- Reuse the existing `resolveDashboardUpdatePillModel()` behavior instead of duplicating label,
  percent, tone, title, and click-action logic in `session.tsx`.
- Move the model to a neutral shared path such as
  `packages/app/src/app/components/sidebar-update-pill-model.ts`, rename the exported symbols to a
  neutral `SidebarUpdatePill*` name, and update dashboard/session imports in the same task.

Do not duplicate the dashboard model under a second session-specific model.
Do not keep the shared model under the dashboard-specific filename as a temporary state.

Tests:

- Existing dashboard update-pill model tests still pass.
- Session source-contract tests no longer require inline `updatePillActionLabel()` logic in
  `session.tsx`; they should assert shared model usage and action wiring.
- Manual download, install, exhausted retry, and auto-download preparing copy remain localized.

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/pages/dashboard-update-pill-model.test.ts \
  src/app/tests/pages/sidebar-update-prompt-actions.test.ts \
  src/app/tests/pages/session-view-modularization.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

### SM06: Sidebar Navigation And Prefetch Actions Controller

```yaml
id: SM06
status: available
reserved_by: null
reserved_at: null
branch: sessiontsx/sm06-sidebar-navigation-prefetch-controller
worktree: ../veslo-sessiontsx-sm06-sidebar-navigation-prefetch-controller
done: false
depends_on: [SM00]
target_files:
  - packages/app/src/app/pages/session.tsx
  - packages/app/src/app/pages/session-sidebar-actions-controller.ts
  - packages/app/src/app/tests/pages/session-sidebar-actions-controller.test.ts
  - packages/app/src/app/tests/pages/session-navigation.test.ts
  - packages/app/src/app/tests/pages/sidebar-directory-session-wiring.test.ts
  - packages/app/src/app/tests/components/session/workspace-session-list-prefetch.test.ts
  - packages/app/src/app/tests/pages/workspace-switching-specific-bugs.test.ts
  - packages/app/src/app/tests/pages/session-view-modularization.test.ts
```

Extract:

- `openSessionFromList`
- pending sidebar session activation-before-open behavior
- scoped browse-scope construction
- `openPendingDirectoryDraftFromList`
- `resolveVesloWorkspaceId`
- `reportLoadedSessionPrefetchInterest`
- `openSoul`

Boundary:

- Controller inputs should be typed accessors for active workspace id/root, workspace groups, server
  client/status, and routing callbacks.
- Keep direct JSX prop wiring in `session.tsx`, but pass controller functions into
  `WorkspaceSessionList`, status controls, and advanced nav.

Tests:

- Real session click records browse scope before routing and preserves conversation/opencode ids.
- Pending sidebar sessions wait for workspace activation before changing visible session scope.
- Prefetch reports only when server workspace id can be resolved.
- Soul navigation switches dashboard tabs only after activation succeeds.
- Runtime availability is not inferred from local connected browse state.

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/pages/session-sidebar-actions-controller.test.ts \
  src/app/tests/pages/session-navigation.test.ts \
  src/app/tests/pages/sidebar-directory-session-wiring.test.ts \
  src/app/tests/components/session/workspace-session-list-prefetch.test.ts \
  src/app/tests/pages/workspace-switching-specific-bugs.test.ts \
  src/app/tests/pages/session-view-modularization.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

### SM07: Toast, Reconnect, History-Action, And Flyout Feedback Controller

```yaml
id: SM07
status: available
reserved_by: null
reserved_at: null
branch: sessiontsx/sm07-feedback-controller
worktree: ../veslo-sessiontsx-sm07-feedback-controller
done: false
depends_on: [SM00, SM02B]
target_files:
  - packages/app/src/app/pages/session.tsx
  - packages/app/src/app/pages/session-feedback-controller.ts
  - packages/app/src/app/tests/pages/session-feedback-controller.test.ts
  - packages/app/src/app/tests/pages/session-scroll-behavior.test.ts
  - packages/app/src/app/tests/reload-banner-i18n.test.ts
  - packages/app/src/app/tests/pages/session-view-modularization.test.ts
```

Extract:

- `toastMessage` lifecycle and auto-dismiss timer
- reconnect notice toasts and clear callback
- undo/redo/compact busy state and toast reporting
- flyout state, previous todo/file counts, initial-load grace period, and flyout trigger cleanup

Boundary:

- Keep `setToastMessage` or a named feedback API available to other extracted controllers.
- The controller should not know the entire `SessionViewProps` object.

Tests:

- Reconnect and reconnected notices localize and clear exactly once.
- Toast auto-dismiss uses the configured delay and cleans up timers.
- Undo/redo/compact report success/failure while preserving busy-state guards.
- Todo/file flyouts do not fire during initial load and do fire on later count increases.

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/pages/session-feedback-controller.test.ts \
  src/app/tests/pages/session-scroll-behavior.test.ts \
  src/app/tests/reload-banner-i18n.test.ts \
  src/app/tests/pages/session-view-modularization.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

### SM08: Grouped `SessionViewProps` Boundary And Final Shell Cleanup

```yaml
id: SM08
status: available
reserved_by: null
reserved_at: null
branch: sessiontsx/sm08-session-view-props-boundary
worktree: ../veslo-sessiontsx-sm08-session-view-props-boundary
done: false
depends_on: [SM01, SM02A, SM02B, SM03, SM04, SM05, SM06, SM07]
target_files:
  - packages/app/src/app/pages/session.tsx
  - packages/app/src/app/pages/session-view-props.ts
  - packages/app/src/app/app-view-props.ts
  - packages/app/src/app/tests/app-view-props.test.ts
  - packages/app/src/app/tests/pages/session-view-modularization.test.ts
```

Purpose:

- Shrink the effective prop surface consumed directly by `session.tsx`.
- Move `SessionViewProps` type clusters into a dedicated file without making the app shell know page
  internals.
- Group only stable domains that the previous tasks made clear.

Candidate prop groups:

- navigation/workspace actions
- runtime/update status
- session transcript data
- composer/draft data
- sidebar/session list data
- permission/question prompts
- artifacts/capabilities
- extension/reload state
- feedback/history actions

Rules:

- Do not do this task before controller extraction. Grouping a 165-field object before reducing
  consumers only hides the problem.
- Keep `SessionView` as the public default export.
- Avoid `Record<string, any>` as the long-term boundary.
- Add source-contract coverage for unused pass-through keys if practical.

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/app-view-props.test.ts \
  src/app/tests/pages/session-view-modularization.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

### SM09: Final Docs And Verification Checkpoint

```yaml
id: SM09
status: available
reserved_by: null
reserved_at: null
branch: sessiontsx/sm09-docs-verification
worktree: ../veslo-sessiontsx-sm09-docs-verification
done: false
depends_on: [SM08]
target_files:
  - docs/dev/app-map.md
  - docs/features/session-runtime.md
  - docs/plans/2026-07-02-session-tsx-second-pass-modularization-implementation-plan.md
  - packages/app/src/app/tests/pages/session-view-modularization.test.ts
```

Purpose:

- Update canonical docs after the new ownership boundaries are merged.
- Mark this plan complete only after verification passes in the original worktree.

Required final verification:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/pages/session-view-modularization.test.ts \
  src/app/tests/pages/session-run-lifecycle-controller.test.ts \
  src/app/tests/pages/session-run-indicator-controller.test.ts \
  src/app/tests/pages/session-sidebar-layout-controller.test.ts \
  src/app/tests/pages/session-local-file-actions.test.ts \
  src/app/tests/pages/session-sidebar-actions-controller.test.ts \
  src/app/tests/pages/session-feedback-controller.test.ts \
  src/app/tests/pages/session-inline-loading.test.ts \
  src/app/tests/pages/session-scroll-behavior.test.ts \
  src/app/tests/pages/session-message-queue.test.ts \
  src/app/tests/pages/session-navigation.test.ts \
  src/app/tests/pages/sidebar-directory-session-wiring.test.ts \
  src/app/tests/pages/sidebar-update-prompt-actions.test.ts \
  src/app/tests/components/layout/global-sidebar-prefs.test.ts \
  src/app/tests/components/session/workspace-session-list-prefetch.test.ts
pnpm --filter @neatech/veslo-ui test:unit
git diff --check
```

Completion criteria:

- `session.tsx` remains the stable page entry point.
- New owner modules are documented in `docs/dev/app-map.md` and `docs/features/session-runtime.md`.
- `session-view-modularization.test.ts` lists every planned second-pass module and still rejects
  ad hoc tiny modules.
- The final progress log records current `session.tsx` metrics after extraction.

## Suggested Merge Order

1. SM00 baseline.
2. SM05 shared update pill model, because it is mostly pure and low conflict.
3. SM04 local file actions, because it is isolated and easy to test.
4. SM01 sidebar layout controller.
5. SM06 sidebar navigation/prefetch controller.
6. SM02A run state lifecycle controller.
7. SM02B run indicator/progress controller.
8. SM03 empty-state/diagnostic boundary.
9. SM07 feedback controller.
10. SM08 props boundary cleanup.
11. SM09 docs and final verification.

## Progress Log

- 2026-07-02 - Plan created from read-only audit. No product code changed. Baseline source-contract
  command from the audit passed: `session-view-modularization.test.ts` plus
  `app-modularization-contract.test.ts` reported 15 pass / 0 fail.
