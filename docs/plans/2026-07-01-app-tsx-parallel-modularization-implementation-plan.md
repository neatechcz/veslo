---
title: App TSX Parallel Modularization Implementation Plan
date: 2026-07-01
target: packages/app/src/app/app.tsx
status: complete
done: true
base_branch: local/sandbox-merge
base_commit: 96cc1b69
---

# App TSX Parallel Modularization Implementation Plan

## Goal

Reduce `packages/app/src/app/app.tsx` from a 12k+ line application shell into a
small composition root plus durable business modules that can be implemented by
multiple agents in separate worktrees.

The target shape is not "one helper per concern". Each extracted file should own
a real product boundary: server connection, account access, managed-AI runtime
config, conversation service, session send workflow, session archive, sidebar
decorations, session capabilities, scheduled automations, Soul data, app startup,
or app props adaptation.

Every extraction must be test-first:

1. Add or update a behavior test for the module contract.
2. Run the focused test and record the expected failure when the module does not
   exist or the app still owns the behavior inline.
3. Extract the module.
4. Run the same focused test again.
5. Run the task verification set.
6. Only after the branch is merged back into the original worktree, update the
   task to `done: true`.

## Current Audit Snapshot

- `packages/app/src/app/app.tsx` is roughly 12,594 lines.
- It contains about 113 imports, 150 `createSignal` calls, 91 `createMemo`
  calls, 80 `createEffect` calls, and several large async workflows.
- Many tests still read `app.tsx` as text. Those tests are useful guardrails,
  but each extraction must retarget brittle source-placement assertions to the
  new module or to behavior.
- Existing repo architecture already supports this split:
  - `controllers/` for UI-framework-independent policy decisions.
  - `context/` for stateful Solid stores and runtime controllers.
  - `pages/` for page-specific state/workflows near their UI surfaces.
  - `lib/` for pure helpers and runtime/client adapters.
- `docs/dev/app-map.md` currently says `app.tsx` owns main composition,
  top-level signals, persistence wiring, workspace activation, share-link
  handling, feedback submission, and cross-surface coordination. This plan
  narrows that further: `app.tsx` should compose modules and route props, not
  own business workflows.

## Coordination Protocol For Multiple Agents

### Reservation Rule

Agents reserve work in the original worktree only. Code changes happen only in
the agent's own worktree.

From the original worktree:

```bash
git status --short
```

Reservation steps:

1. Open this plan in the original worktree.
2. Pick one task with `status: available` and `reserved_by: null`.
3. Change only that task's reservation fields:
   - `status: reserved`
   - `reserved_by: <agent-name-or-session-id>`
   - `reserved_at: <ISO timestamp>`
   - `branch: appmod/<task-id>-<slug>`
   - `worktree: ../veslo-appmod-<task-id>-<slug>`
4. Save the file in the original worktree.
5. Create the agent worktree from the original checkout:

```bash
git worktree add ../veslo-appmod-<task-id>-<slug> -b appmod/<task-id>-<slug> HEAD
```

Rules:

- Do not edit product code in the original worktree.
- Do not reserve a task that already has a non-null `reserved_by`.
- Do not change another agent's reservation.
- Do not mark `done: true` from an agent worktree. Mark done only in the
  original worktree after the branch has been merged and verification has
  passed there.
- If a task becomes blocked, set `status: blocked` and add one short blocker
  note. Do not keep the task reserved silently.

### Branch Hygiene

Each branch should contain:

- The new or updated tests.
- The new module(s).
- The minimal `app.tsx` wiring needed to use the module.
- Any retargeted source-contract tests.
- No unrelated formatting churn.
- No unrelated `docs/fixes` note unless separately requested.

Each branch should avoid broad import sorting in `app.tsx`; import conflicts are
the most likely merge pain. Add imports in the existing import area and leave
unrelated imports alone.

### Merge Order

The coordinator should merge in this order:

1. Phase 0 baseline/contract task.
2. Low-conflict shell and server connection modules.
3. Independent dashboard/sidebar data stores.
4. Conversation service.
5. Session creation and session send workflows.
6. Managed-AI config sync.
7. App startup/persistence and final props/shell cleanup.

After each merge into the original worktree:

```bash
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

Run the task-specific verification too. Use `pnpm --filter @neatech/veslo-ui
test:unit` before marking the whole plan done.

## Shared Rules

### Module Size Rule

Create a module only when it owns a durable boundary.

- Stateful controller/store modules should usually be at least 150 lines after
  extraction.
- Pure model modules may be smaller when they replace brittle source-contract
  tests with focused behavior tests.
- Do not create one-file wrappers around a single signal, setter, regex, or
  event handler.

### Controller Boundary Rule

Files under `packages/app/src/app/controllers/` must stay UI-framework
independent. Existing tests enforce that controllers do not import `solid-js`,
`@solidjs/router`, `pages/`, or `components/`.

If a task needs Solid signals/effects, put it under `context/` or `pages/`, not
under `controllers/`.

### Source-Contract Test Rule

Before moving code out of `app.tsx`, search for tests that read `app.tsx`:

```bash
rg -n "app\\.tsx" packages/app/src/app/tests -g "*.test.ts"
```

If the test asserts behavior placement rather than product behavior, retarget it
to the new module. If it asserts real wiring, keep it but change the assertion
to verify the new composition call instead of the old inline implementation.

### App Shell Final Shape

At the end, `app.tsx` should keep:

- route/view state
- module composition
- top-level providers and modals
- lightweight prop adapters
- global error/busy signals only where no narrower module owns them

It should not keep:

- Veslo server polling loops
- Den browser auth polling
- managed-AI config patch loops
- conversation read/write API wrappers
- attachment staging
- full `sendPrompt`
- full `createSessionAndOpen`
- session archive migration
- subagent decoration persistence
- session capabilities loading
- scheduled automation loading/mutations
- Soul dashboard data loading
- large startup hydration blocks

## Task Reservation Ledger

Use this ledger for quick discovery. The authoritative task details are below.

| id | module | status | reserved_by | done |
| --- | --- | --- | --- | --- |
| AM00 | baseline/source-contract triage | merged | codex-20260701-120436 | true |
| AM01 | app shell environment effects | merged | codex-20260701-123848 | true |
| AM02 | route and hash sync shell | merged | codex-20260701-am02-route-sync | true |
| AM03 | feedback workflow | merged | codex-20260701-140710 | true |
| AM04 | Veslo server connection store | merged | codex-20260701-am04-veslo-server-connection | true |
| AM05 | workspace runtime debug probes | merged | codex-20260701-150643 | true |
| AM06 | Den desktop auth workflow | merged | codex-20260701-173304-am06-takeover | true |
| AM07 | managed-AI access profile store | merged | codex-20260701-174058-am07 | true |
| AM08 | managed-AI runtime config sync | merged | codex-20260701-175830-am08 | true |
| AM09 | conversation service adapter | merged | codex-20260701-am09-conversation-service | true |
| AM10 | session attachment staging | merged | codex-20260701-am10-session-attachment-staging | true |
| AM11 | session send workflow | merged | codex-20260701-221919-am11 | true |
| AM12 | session creation workflow | merged | codex-20260701-221528-am12 | true |
| AM13 | session mutation commands | merged | codex-20260701-152410 | true |
| AM14 | session archive store | merged | codex-20260701-am14 | true |
| AM15 | session sidebar decorations | merged | codex-20260701-am15 | true |
| AM16 | session route resume sync | merged | codex-20260701-170326 | true |
| AM17 | session capabilities store | merged | codex-20260701-220025-am17-finish | true |
| AM18 | shared bundle and remote-connect workflow | merged | codex-20260701-am18-app-deep-link-workflow | true |
| AM19 | skill registry event orchestrator | merged | codex-20260701-am19-skill-registry-orchestrator | true |
| AM20 | MCP and Notion connection workflow | merged | codex-20260701-171525 | true |
| AM21 | scheduled automation store | merged | codex-20260701-am21-scheduled-automation-store | true |
| AM22 | Soul dashboard data store | merged | codex-20260701-am22 | true |
| AM23 | startup hydration and preference persistence | merged | codex-20260701-am23-app-startup-hydration | true |
| AM24 | app view prop adapters | merged | codex-20260701-230333-am24 | true |
| AM25 | final app shell cleanup | merged | codex-20260701-232727-am25 | true |

## Phase 0: Baseline And Parallel Safety

### Task AM00: Baseline Source-Contract Triage

```yaml
id: AM00
status: merged
reserved_by: codex-20260701-120436
reserved_at: 2026-07-01T12:04:36.8028097+02:00
branch: appmod/am00-baseline-source-contract-triage
worktree: ../veslo-appmod-am00-baseline-source-contract-triage
done: true
depends_on: []
target_module: none
source_ranges:
  - packages/app/src/app/app.tsx
```

Purpose:

- Freeze the app modularization target before parallel extraction starts.
- Classify tests that read `app.tsx` as behavior, wiring, or brittle placement
  coverage.
- Add a modularization contract test that prevents replacing one monolith with
  dozens of tiny files.

Target files:

- Add or modify:
  `packages/app/src/app/tests/app-modularization-contract.test.ts`
- Modify only if needed:
  `packages/app/src/app/tests/app-refactor-contracts.test.ts`

Test-first contract:

- New contract test should fail if new app modules are tiny wrappers.
- New contract test should allow coherent stateful modules under `context/` and
  page workflow modules under `pages/`.
- Source-contract test inventory should be documented in this plan's progress
  log before extraction work proceeds.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-modularization-contract.test.ts src/app/tests/app-refactor-contracts.test.ts
```

Acceptance:

- The baseline test suite passes.
- The progress log lists the main `app.tsx` source-contract tests that later
  tasks must retarget.
- No product behavior is changed.

## Phase 1: Low-Conflict App Shell Modules

### Task AM01: App Shell Environment Effects

```yaml
id: AM01
status: merged
reserved_by: codex-20260701-123848
reserved_at: 2026-07-01T12:38:48.3279621+02:00
branch: appmod/am01-app-shell-environment-effects
worktree: ../veslo-appmod-am01-app-shell-environment-effects
done: true
depends_on: [AM00]
target_module: packages/app/src/app/context/app-shell-environment.ts
source_ranges:
  - packages/app/src/app/app.tsx:1355-1443
  - packages/app/src/app/app.tsx:11713-11732
  - packages/app/src/app/app.tsx:12316-12596
```

Move:

- document visibility signal wiring
- app focus signal wiring
- global file drag/drop guard
- font zoom shortcut and persistence effect
- small browser/Tauri shell lifecycle effects that do not own business data

Do not move:

- startup hydration
- Den auth
- route sync
- update installation state

Test-first contract:

- Add `tests/context/app-shell-environment.test.ts`.
- Test document visibility and focus listener lifecycle through dependency
  injection.
- Test file-drop guard prevents default only for file transfers.
- Test font zoom shortcut applies, persists, and cleans up the listener.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/app-shell-environment.test.ts src/app/tests/app-overlay-i18n.test.ts
```

Acceptance:

- `app.tsx` only calls a `createAppShellEnvironment(...)` style module.
- The module owns cleanup.
- Existing overlay/i18n source-contract tests still pass or are retargeted.

### Task AM02: Route And Hash Sync Shell

```yaml
id: AM02
status: merged
reserved_by: codex-20260701-am02-route-sync
reserved_at: 2026-07-01T12:39:29.8917561+02:00
branch: appmod/am02-app-route-sync
worktree: ../veslo-appmod-am02-app-route-sync
done: true
depends_on: [AM00]
target_module: packages/app/src/app/context/app-route-sync.ts
source_ranges:
  - packages/app/src/app/app.tsx:958-1018
  - packages/app/src/app/app.tsx:13352-13481
```

Move:

- `currentView`
- `setView`
- dashboard tab navigation helpers
- session route navigation helper
- Tauri hash route sync
- startup route effect that delegates to `app-startup-controller`

Do not move:

- session route selection internals handled by AM16
- `SessionView`/`DashboardView` JSX

Test-first contract:

- Add `tests/context/app-route-sync.test.ts`.
- Cover dashboard route canonicalization.
- Cover Tauri hash route tab sync.
- Cover `/session/:id` startup decision delegating to session route selection
  dependencies instead of clearing state inline.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/app-route-sync.test.ts src/app/tests/controllers/app-startup-controller.test.ts src/app/tests/app-startup-route-controller-contract.test.ts src/app/tests/app-refactor-contracts.test.ts
```

Acceptance:

- `app.tsx` keeps only route module construction and returned accessors.
- Route policy remains in `controllers/app-startup-controller.ts`.

### Task AM03: Feedback Workflow

```yaml
id: AM03
status: merged
reserved_by: codex-20260701-140710
reserved_at: 2026-07-01T14:07:10.2743041+02:00
branch: appmod/am03-feedback-workflow
worktree: ../veslo-appmod-am03-feedback-workflow
done: true
depends_on: [AM00]
target_module: packages/app/src/app/context/feedback-workflow.ts
source_ranges:
  - packages/app/src/app/app.tsx:1034-1085
  - packages/app/src/app/app.tsx:13327-13350
  - packages/app/src/app/app.tsx:13516-13527
```

Move:

- feedback modal state
- runtime context building
- submit flow
- success/error/busy handling

Do not move:

- actual `FeedbackModal` JSX can stay in `app.tsx` until AM25.

Test-first contract:

- Retarget or extend `app-feedback-flow.contract.test.ts`.
- Add a focused module test that verifies submitted context contains platform,
  route, app version, workspace, runtime, and user state.
- Verify duplicate submit is ignored while busy.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/feedback-workflow.test.ts src/app/tests/app-feedback-flow.contract.test.ts
```

Acceptance:

- `app.tsx` passes feedback dependencies into a module and renders modal from
  returned state.
- User-facing feedback behavior does not change.

## Phase 2: Server And Runtime Infrastructure

### Task AM04: Veslo Server Connection Store

```yaml
id: AM04
status: merged
reserved_by: codex-20260701-am04-veslo-server-connection
reserved_at: 2026-07-01T14:09:11.9516538+02:00
branch: appmod/am04-veslo-server-connection
worktree: ../veslo-appmod-am04-veslo-server-connection
done: true
depends_on: [AM00]
target_module: packages/app/src/app/context/veslo-server-connection.ts
source_ranges:
  - packages/app/src/app/app.tsx:1108-1307
  - packages/app/src/app/app.tsx:1309-1353
  - packages/app/src/app/app.tsx:1443-1752
  - packages/app/src/app/app.tsx:8046-8053
  - packages/app/src/app/app.tsx:8845-8923
  - packages/app/src/app/app.tsx:8925-9011
```

Move:

- Veslo server settings signal and persistence update/reset functions
- host info state and stable setters
- URL/auth/client/archive client/gateway client memos
- status/capabilities polling and stability state
- local server ensure/reconnect/test connection workflows
- developer diagnostics signals that belong to server connection only

Do not move:

- full workspace store
- managed-AI config sync
- devtools runtime snapshot from AM05
- session archive data from AM14

Test-first contract:

- Add `tests/context/veslo-server-connection.test.ts`.
- Preserve existing source-contract coverage in:
  - `app-veslo-server-state-stability.test.ts`
  - `app-local-veslo-server-ensure.test.ts`
  - `app-create-session-health-fallback.test.ts`
- Tests should use injected timers/client factories where possible.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/veslo-server-connection.test.ts src/app/tests/app-veslo-server-state-stability.test.ts src/app/tests/app-local-veslo-server-ensure.test.ts src/app/tests/app-create-session-health-fallback.test.ts src/app/tests/lib/veslo-server-status-stability.test.ts
```

Acceptance:

- `app.tsx` constructs `createVesloServerConnection(...)`.
- Existing consumers still receive `vesloServerClient`, status, capabilities,
  settings, auth, host info, archive client, gateway client, and reconnect
  actions.
- No route, session, or managed-AI behavior moves into this module.

### Task AM05: Workspace Runtime Debug Probes

```yaml
id: AM05
status: merged
reserved_by: codex-20260701-150643
reserved_at: 2026-07-01T15:06:43.3480530+02:00
branch: appmod/am05-workspace-runtime-debug-probes
worktree: ../veslo-appmod-am05-workspace-runtime-debug-probes
done: true
depends_on: [AM00, AM04]
target_module: packages/app/src/app/context/workspace-runtime-debug-probe.ts
source_ranges:
  - packages/app/src/app/app.tsx:6066-6469
  - packages/app/src/app/app.tsx:7589-7692
```

Move:

- workspace runtime diagnosis builder
- runtime snapshot/diff readers
- `window.__vesloWorkspaceRuntimeSnapshot`
- `window.__vesloWorkspaceRuntimeDiff`
- request broker debug bridge
- developer-mode audit polling that is purely diagnostic

Do not move:

- regular app state
- server connection polling from AM04
- dashboard props

Test-first contract:

- Add `tests/context/workspace-runtime-debug-probe.test.ts`.
- Cover mismatch diagnosis for app/Tauri/server/orchestrator active workspace.
- Cover install and cleanup of window debug functions.
- Cover snapshot summary diff shape.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-runtime-debug-probe.test.ts src/app/tests/context/session-workspace-busy-source.test.ts
```

Acceptance:

- `app.tsx` calls a debug probe module only when composing runtime diagnostics.
- Debug global names and help text stay compatible.

## Phase 3: Account And Managed AI

### Task AM06: Den Desktop Auth Workflow

```yaml
id: AM06
status: merged
reserved_by: codex-20260701-173304-am06-takeover
reserved_at: 2026-07-01T17:33:04.3150753+02:00
branch: appmod/am06-den-desktop-auth-workflow
worktree: ../veslo-appmod-am06-den-desktop-auth-workflow
done: true
depends_on: [AM00]
target_module: packages/app/src/app/context/den-desktop-auth-workflow.ts
source_ranges:
  - packages/app/src/app/app.tsx:8088-8464
  - packages/app/src/app/app.tsx:11590-11656
  - packages/app/src/app/app.tsx:11657-11672
```

Move:

- desktop browser auth exchange
- auth status polling
- pending browser auth resume
- auth-complete deep-link queue function
- Den auth revision subscription
- bootstrap diagnostics cloud-context sync
- authenticated user/account label hydration

Do not move:

- managed-AI access profile loading from AM07
- startup hydration shell from AM23

Test-first contract:

- Add `tests/context/den-desktop-auth-workflow.test.ts`.
- Cover deep-link exchange dedupe.
- Cover polling stop on authorized/expired/cancelled/exchanged.
- Cover post-auth bootstrap timeout cleanup.
- Cover cloud diagnostics context set/clear.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/den-desktop-auth-workflow.test.ts src/app/tests/app-refactor-contracts.test.ts src/app/tests/lib/den-auth.test.ts
```

Acceptance:

- `app.tsx` receives `startDesktopBrowserSignIn`,
  `resumeDesktopBrowserSignIn`, `queueAuthCompleteDeepLink`, `logout`, user
  label, account id, auth revision, and exchange busy state from the module.
- Browser sign-in UI behavior is unchanged.

### Task AM07: Managed-AI Access Profile Store

```yaml
id: AM07
status: merged
reserved_by: codex-20260701-174058-am07
reserved_at: 2026-07-01T17:40:58.4211299+02:00
branch: appmod/am07-managed-ai-access-profile-store
worktree: ../veslo-appmod-am07-managed-ai-access-profile-store
done: true
depends_on: [AM04, AM06]
target_module: packages/app/src/app/context/managed-ai-access-store.ts
source_ranges:
  - packages/app/src/app/app.tsx:575-829
  - packages/app/src/app/app.tsx:5236-5434
  - packages/app/src/app/app.tsx:8466-8724
```

Move:

- managed-AI access localStorage/proof cache helpers
- access refresh nonce/retry state
- access profile/gateway token state
- access message/provider/default model labels
- local gateway ensure trigger
- focus/visibility refresh trigger

Do not move:

- config write/sync from AM08
- runtime send authorization from AM08

Test-first contract:

- Add `tests/context/managed-ai-access-store.test.ts`.
- Preserve/retarget existing contracts:
  - `app-managed-ai-runtime-controller-contract.test.ts`
  - `app-managed-ai-bootstrap-gate.test.ts`
  - `app-managed-ai-access-retry-gate.test.ts`
- Cover cache-hit, cache-reset, gateway failure with retry, and local gateway
  defer behavior.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/managed-ai-access-store.test.ts src/app/tests/app-managed-ai-bootstrap-gate.test.ts src/app/app-managed-ai-access-retry-gate.test.ts src/app/tests/controllers/managed-ai-runtime-controller.test.ts src/app/tests/lib/managed-ai-access-retry.test.ts
```

Acceptance:

- `app.tsx` gets a managed-AI access object from a store module.
- No managed-AI access token is persisted beyond the existing intended cache
  behavior.

### Task AM08: Managed-AI Runtime Config Sync

```yaml
id: AM08
status: merged
reserved_by: codex-20260701-175830-am08
reserved_at: 2026-07-01T17:58:30.4088337+02:00
branch: appmod/am08-managed-ai-runtime-config-sync
worktree: ../veslo-appmod-am08-managed-ai-runtime-config-sync
done: true
depends_on: [AM04, AM07]
target_module: packages/app/src/app/context/managed-ai-runtime-config.ts
source_ranges:
  - packages/app/src/app/app.tsx:5407-5826
  - packages/app/src/app/app.tsx:11734-12314
```

Move:

- runtime sandbox state resolver for managed-AI send/config
- send-time managed-AI runtime config read/check
- send-time authorization prime
- active workspace config write effect
- inactive workspace baseURL heal effect
- managed config applied/reload key tracking

Do not move:

- managed-AI profile loading from AM07
- generic Veslo server connection from AM04

Test-first contract:

- Add `tests/context/managed-ai-runtime-config.test.ts`.
- Retarget existing `app-managed-ai-config-sync-contract.test.ts`.
- Cover local file config path and Veslo server config path.
- Cover no destructive reload during boot/send config patch.
- Cover inactive workspace heal skips unauthorized workspaces after reporting.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/managed-ai-runtime-config.test.ts src/app/tests/app-managed-ai-config-sync-contract.test.ts src/app/tests/controllers/managed-ai-config-sync.test.ts src/app/tests/lib/managed-ai-config-reload.test.ts
```

Acceptance:

- `app.tsx` delegates managed-AI config side effects to a module.
- Send preflight still observes `managedAiReady` and effective sandbox state.

## Phase 4: Conversation And Session Send

### Task AM09: Conversation Service Adapter

```yaml
id: AM09
status: merged
reserved_by: codex-20260701-am09-conversation-service
reserved_at: 2026-07-01T15:06:57.2618563+02:00
branch: appmod/am09-conversation-service
worktree: ../veslo-appmod-am09-conversation-service
done: true
depends_on: [AM04]
target_module: packages/app/src/app/context/conversation-service.ts
source_ranges:
  - packages/app/src/app/app.tsx:2073-2689
```

Move:

- passive conversation read client resolution
- workspace registration cache
- conversation workspace resolution for send/read
- list/backfill/get transcript wrappers
- create conversation wrapper
- run conversation wrapper
- abort conversation wrapper
- conversation abort scope resolver

Do not move:

- session store creation
- `sendPrompt`
- `createSessionAndOpen`
- attachment staging

Test-first contract:

- Add `tests/context/conversation-service.test.ts`.
- Retarget `app-conversation-abort.test.ts` source checks to this module where
  they assert service behavior.
- Cover scoped run id recording, scoped abort run-id requirement, and workspace
  registration caching.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/app-conversation-abort.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts
```

Acceptance:

- `createSessionStore` receives conversation service functions.
- `sendPrompt` and `createSessionAndOpen` call the service instead of owning
  server workspace resolution.

### Task AM10: Session Attachment Staging

```yaml
id: AM10
status: merged
reserved_by: codex-20260701-am10-session-attachment-staging
reserved_at: 2026-07-01T15:23:15.8757175+02:00
branch: appmod/am10-session-attachment-staging
worktree: ../veslo-appmod-am10-session-attachment-staging
done: true
depends_on: [AM04, AM09]
target_module: packages/app/src/app/pages/session-attachment-staging.ts
source_ranges:
  - packages/app/src/app/app.tsx:3244-3665
```

Move:

- composer attachment to `File`
- arrayBuffer to base64
- session directory relative path resolution
- collision-safe attachment path resolution
- workspace id resolution for attachment staging
- one-shot local server workspace recovery
- staged attachment routing into prompt/command file parts

Do not move:

- full `sendPrompt`
- skill command resolution

Test-first contract:

- Add `tests/pages/session-attachment-staging.test.ts`.
- Retarget `app-attachment-workspace-readiness.test.ts`.
- Cover cached workspace id validation against server list.
- Cover one-shot recovery when file session creation reports missing workspace.
- Cover prompt parts and command file parts for workspace-relative, absolute,
  and empty-root paths.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-attachment-staging.test.ts src/app/tests/app-attachment-workspace-readiness.test.ts src/app/tests/lib/attachment-prompt-routing.test.ts
```

Acceptance:

- `sendPrompt` calls a staging module.
- Attachment behavior is unchanged for local and Veslo server workspaces.

### Task AM11: Session Send Workflow

```yaml
id: AM11
status: merged
reserved_by: codex-20260701-221919-am11
reserved_at: 2026-07-01T22:19:19.3022433+02:00
branch: appmod/am11-session-send-workflow
worktree: ../veslo-appmod-am11-session-send-workflow
done: true
depends_on: [AM09, AM10, AM12, AM08]
target_module: packages/app/src/app/pages/session-send-workflow.ts
source_ranges:
  - packages/app/src/app/app.tsx:3217-4460
  - packages/app/src/app/app.tsx:4560-4666
```

Move:

- composer draft storage bridge for send
- skill-command auto-resolution
- full `sendPrompt`
- send busy ownership and in-flight release
- pending sidebar cleanup/materialization calls
- pending global draft consume/restore after send
- prompt/command/shell dispatch
- send error reporting to displayed target
- visible runtime activity hold integration
- `abortSession`

Do not move:

- session creation internals from AM12
- replacement/undo/redo from AM13 unless needed as callbacks
- pure queue model already in `pages/session-conversation-flow.ts`

Test-first contract:

- Add `tests/pages/session-send-workflow.test.ts`.
- Retarget:
  - `app-send-orchestration-controller-contract.test.ts`
  - `app-send-prompt-session-creation.test.ts`
  - `app-send-preflight-context.test.ts`
  - `app-send-workspace-scope.test.ts`
  - `app-send-latency-trace.test.ts`
  - `pending-session-send-flow.test.ts`
- Cover no-send without client message id.
- Cover selected session ignored for a foreign workspace.
- Cover create-session handoff when no session exists.
- Cover attachment staging failure restores pending draft.
- Cover stale workspace client is silent abort.
- Cover scoped abort fallback order.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/app-send-orchestration-controller-contract.test.ts src/app/tests/app-send-prompt-session-creation.test.ts src/app/tests/app-send-preflight-context.test.ts src/app/tests/app-send-workspace-scope.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/pending-session-send-flow.test.ts
```

Acceptance:

- `app.tsx` receives `sendPromptAsync`, `abortSession`, send busy state, and
  last prompt state from the workflow module.
- Behavior of the existing SessionView props is unchanged.

### Task AM12: Session Creation Workflow

```yaml
id: AM12
status: merged
reserved_by: codex-20260701-221528-am12
reserved_at: 2026-07-01T22:15:28.9151026+02:00
branch: appmod/am12-session-creation-workflow
worktree: ../veslo-appmod-am12-session-creation-workflow
done: true
depends_on: [AM09, AM04, AM08]
target_module: packages/app/src/app/pages/session-creation-workflow.ts
source_ranges:
  - packages/app/src/app/app.tsx:10675-11070
```

Move:

- full `createSessionAndOpen`
- create-session runtime readiness gates
- pending sidebar materialization
- selected session injection before route selection
- own-navigation handoff marker callback

Do not move:

- directory/session folder move workflow
- `sendPrompt`
- pure helpers in `controllers/session-creation-flow.ts`

Test-first contract:

- Add `tests/pages/session-creation-workflow.test.ts`.
- Retarget `app-session-creation-flow-contract.test.ts`.
- Cover connecting workspace gate.
- Cover managed-AI/runtime preflight skip with existing preflight context.
- Cover created sidebar item materialization before select.
- Cover own navigation marker before route selection.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-creation-workflow.test.ts src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/controllers/session-creation-flow.test.ts src/app/tests/controllers/send-orchestration-controller.test.ts
```

Acceptance:

- `app.tsx` calls a `createSessionCreationWorkflow(...)` style module.
- `createSessionAndOpen` remains available to dashboard/session props.

### Task AM13: Session Mutation Commands

```yaml
id: AM13
status: merged
reserved_by: codex-20260701-152410
reserved_at: 2026-07-01T15:24:10.5807867+02:00
branch: appmod/am13-session-mutation-commands
worktree: ../veslo-appmod-am13-session-mutation-commands
done: true
depends_on: [AM09]
target_module: packages/app/src/app/pages/session-mutation-workflow.ts
source_ranges:
  - packages/app/src/app/app.tsx:4462-5094
  - packages/app/src/app/app.tsx:4995-5030
```

Move:

- retry last prompt wrapper
- compact current session
- synthetic session error helpers if still app-owned
- replace user message
- undo/redo
- rename/delete session
- save/export session
- list agents/commands if they remain session workflow concerns

Do not move:

- full send prompt from AM11
- model/provider persistence from AM23

Test-first contract:

- Add `tests/pages/session-mutation-workflow.test.ts`.
- Retarget:
  - `session-message-replacement.test.ts`
  - `app-session-prompt-error.test.ts`
  - `app-unread-session-indicator.test.ts`
- Cover replace creates editable draft from previous user message.
- Cover undo/redo calls scoped revert/unrevert.
- Cover delete clears selected state and sidebar entry.
- Cover compact command preserves selected session.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-mutation-workflow.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/app-session-prompt-error.test.ts src/app/tests/app-unread-session-indicator.test.ts
```

Acceptance:

- Session mutation callbacks in `sessionProps` come from a workflow module.
- No send/create behavior moves into this module.

## Phase 5: Session Sidebar And Capabilities

### Task AM14: Session Archive Store

```yaml
id: AM14
status: merged
reserved_by: codex-20260701-am14
reserved_at: 2026-07-01T15:07:20.6898468+02:00
branch: appmod/am14-session-archive-store
worktree: ../veslo-appmod-am14-session-archive-store
done: true
depends_on: [AM04]
target_module: packages/app/src/app/context/session-archive-store.ts
source_ranges:
  - packages/app/src/app/app.tsx:6765-7027
```

Move:

- legacy archive migration key helpers
- archive record state
- pending archive id state
- load archives
- migration from legacy sidebar ids
- archive/unarchive actions
- archived sidebar id projection
- settings archive projection

Test-first contract:

- Add `tests/context/session-archive-store.test.ts`.
- Retarget `app-session-archives.test.ts`.
- Cover missing client/account behavior.
- Cover legacy migration only after sidebar groups are settled.
- Cover archive/unarchive writes owner key and updates records.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-archive-store.test.ts src/app/tests/app-session-archives.test.ts src/app/tests/lib/session-archive-model.test.ts src/app/tests/pages/settings-archived-sessions.test.ts
```

Acceptance:

- `app.tsx` consumes `archivedSessionIds`, `sessionArchives`,
  `archiveSession`, and `unarchiveSession` from the store.

### Task AM15: Session Sidebar Decorations

```yaml
id: AM15
status: merged
reserved_by: codex-20260701-am15
reserved_at: 2026-07-01T13:46:21.6221811+02:00
branch: appmod/am15-session-sidebar-decorations
worktree: ../veslo-appmod-am15-session-sidebar-decorations
done: true
depends_on: [AM00]
target_module: packages/app/src/app/context/session-sidebar-decorations.ts
source_ranges:
  - packages/app/src/app/app.tsx:1942-1985
  - packages/app/src/app/app.tsx:7037-7244
  - packages/app/src/app/app.tsx:11729-11734
```

Move:

- subagent decorations localStorage read/write
- subagent candidate derivation from sidebar groups
- deterministic role entry building
- color/occurrence selection
- queued decoration creation
- decoration projection by session id

Test-first contract:

- Add `tests/context/session-sidebar-decorations.test.ts`.
- Retarget `subagent-role-classifier-session-regression.test.ts`.
- Cover deterministic role fallback, sibling occurrence increment, color
  selection, persistence, and ignoring already-decorated sessions.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-sidebar-decorations.test.ts src/app/tests/subagent-role-classifier-session-regression.test.ts src/app/tests/lib/subagent-decoration-model.test.ts src/app/tests/lib/subagent-decorations-persistence.test.ts
```

Acceptance:

- `app.tsx` consumes `subagentDecorationsBySessionId` from the module.

### Task AM16: Session Route Resume Sync

```yaml
id: AM16
status: merged
reserved_by: codex-20260701-170326
reserved_at: 2026-07-01T17:03:26.0404609+02:00
branch: appmod/am16-session-route-sync
worktree: ../veslo-appmod-am16-session-route-sync
done: true
depends_on: [AM02, AM09]
target_module: packages/app/src/app/context/session-route-sync.ts
source_ranges:
  - packages/app/src/app/app.tsx:7258-7437
  - packages/app/src/app/app.tsx:13381-13481
```

Move:

- route session known checks
- route conversation identity key
- bare `/session` clear display behavior
- route resume selection dedupe
- route-driven `selectSession` orchestration

Do not move:

- pure policy from `controllers/session-route-controller.ts`
- top-level dashboard/startup route sync from AM02

Test-first contract:

- Add `tests/context/session-route-sync.test.ts`.
- Retarget:
  - `app-session-route-controller-contract.test.ts`
  - `session-route-client-resume.test.ts`
  - `session-route-selection-guard.test.ts` source references
- Cover own-navigation consume, stale fallback, pending route selection, and
  known session detection across store/sidebar/scoped ids.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-route-sync.test.ts src/app/tests/app-session-route-controller-contract.test.ts src/app/tests/session-route-client-resume.test.ts src/app/tests/lib/session-route-selection-guard.test.ts src/app/tests/controllers/session-route-controller.test.ts
```

Acceptance:

- `app.tsx` delegates session route effect to a route sync module.
- Stores still own mutations; route sync executes decisions.

### Task AM17: Session Capabilities Store

```yaml
id: AM17
status: merged
reserved_by: codex-20260701-220025-am17-finish
reserved_at: 2026-07-01T22:00:25.6865373+02:00
branch: appmod/am17-session-capabilities-store
worktree: ../veslo-appmod-am17-session-capabilities-store
done: true
depends_on: [AM04]
target_module: packages/app/src/app/context/session-capabilities-store.ts
source_ranges:
  - packages/app/src/app/app.tsx:7694-8044
```

Move:

- selected session capability source/scope
- workspace lookup by session directory
- local MCP status loading for selected session
- remote workspace skills/MCP capability loading
- session capabilities cache integration
- skill inventory context for reload

Test-first contract:

- Add `tests/context/session-capabilities-store.test.ts`.
- Retarget `tests/lib/session-capabilities.test.ts` app source assertion.
- Cover local workspace capabilities and remote Veslo workspace capabilities.
- Cover runtime MCP status skip during active send.
- Cover cache force when skill inventory or remote status context changes.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-capabilities-store.test.ts src/app/tests/lib/session-capabilities.test.ts src/app/tests/pages/session-admin-ai-access.test.ts
```

Acceptance:

- `SessionView` props receive capabilities state from this store.

## Phase 6: Deep Links, Skills, MCP, Dashboard Data

### Task AM18: Shared Bundle And Remote-Connect Workflow

```yaml
id: AM18
status: merged
reserved_by: codex-20260701-am18-app-deep-link-workflow
reserved_at: 2026-07-01T17:38:29.3666636+02:00
branch: appmod/am18-app-deep-link-workflow
worktree: ../veslo-appmod-am18-app-deep-link-workflow
done: true
depends_on: [AM04, AM06]
target_module: packages/app/src/app/context/app-deep-link-workflow.ts
source_ranges:
  - packages/app/src/app/app.tsx:8060-8087
  - packages/app/src/app/app.tsx:7439-7587
  - packages/app/src/app/app.tsx:11294-11672
```

Move:

- remote connect deep-link queue
- shared bundle deep-link queue
- shared bundle worker target resolution
- wait for import target
- create worker from shared bundle
- shared bundle import effect
- desktop/web deep-link fan-in that invokes auth/remote/bundle handlers

Do not move:

- pure deep-link parsers already in `lib/deep-links.ts`
- Den auth exchange internals from AM06

Test-first contract:

- Add `tests/context/app-deep-link-workflow.test.ts`.
- Retarget deep-link portions of `app-refactor-contracts.test.ts`.
- Cover desktop URL dedupe and stop-after-first-consumed behavior.
- Cover web strips only remote/bundle query params, not auth params.
- Cover bundle import waits for connected writable worker.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/app-deep-link-workflow.test.ts src/app/tests/app-refactor-contracts.test.ts src/app/tests/lib/shared-bundles.test.ts
```

Acceptance:

- Startup code calls the workflow with injected queue handlers.
- Deep-link behavior remains unchanged for Tauri and web.

### Task AM19: Skill Registry Event Orchestrator

```yaml
id: AM19
status: merged
reserved_by: codex-20260701-am19-skill-registry-orchestrator
reserved_at: 2026-07-01T17:04:06.4408095+02:00
branch: appmod/am19-skill-registry-orchestrator
worktree: ../veslo-appmod-am19-skill-registry-orchestrator
done: true
depends_on: [AM04]
target_module: packages/app/src/app/context/skill-registry-orchestrator.ts
source_ranges:
  - packages/app/src/app/app.tsx:6473-6661
```

Move:

- skill registry reload trigger mapping
- pending workspace/global replay state
- busy-run deferral
- registry materialization auth context integration
- event listener setup/cleanup
- inventory invalidation/refresh after sync

Do not move:

- `createExtensionsStore`
- Skills page UI
- general MCP workflows

Test-first contract:

- Add `tests/context/skill-registry-orchestrator.test.ts`.
- Retarget `app-skill-registry-events.test.ts`.
- Cover workspace update during active run queues replay and marks reload.
- Cover idle update syncs immediately.
- Cover global update during active run queues global replay.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/skill-registry-orchestrator.test.ts src/app/tests/app-skill-registry-events.test.ts src/app/tests/lib/skill-registry-events.test.ts
```

Acceptance:

- `app.tsx` starts a skill registry orchestrator after extension store and
  Veslo server connection are composed.

### Task AM20: MCP And Notion Connection Workflow

```yaml
id: AM20
status: merged
reserved_by: codex-20260701-171525
reserved_at: 2026-07-01T17:15:25.3814353+02:00
branch: appmod/am20-mcp-connection-workflow
worktree: ../veslo-appmod-am20-mcp-connection-workflow
done: true
depends_on: [AM04]
target_module: packages/app/src/app/context/mcp-connection-workflow.ts
source_ranges:
  - packages/app/src/app/app.tsx:10036-10673
  - packages/app/src/app/app.tsx:9055-9071
```

Move:

- Notion connect flow
- MCP runtime status refresher setup and schedule helper
- MCP runtime context ensure
- MCP add config builder
- server-managed MCP OAuth start
- activate installed MCP
- connect/authorize/logout/remove MCP actions
- hub MCP install-and-activate workflow

Do not move:

- `createExtensionsStore`
- MCP page rendering

Test-first contract:

- Add `tests/context/mcp-connection-workflow.test.ts`.
- Retarget:
  - `mcp-hub-contract.test.ts`
  - `mcp-runtime-install-contract.test.ts`
- Cover local config path and Veslo server MCP facade path.
- Cover OAuth auth modal path.
- Cover hub install activates server or local config as appropriate.
- Cover remove refreshes server list and clears selected MCP.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/mcp-connection-workflow.test.ts src/app/tests/mcp-hub-contract.test.ts src/app/tests/mcp-runtime-install-contract.test.ts src/app/tests/lib/mcp-runtime-status-refresh.test.ts
```

Acceptance:

- Dashboard props receive MCP actions from the workflow module.
- Napojeni/MCP and Pluginy ownership stays separate.

### Task AM21: Scheduled Automation Store

```yaml
id: AM21
status: merged
reserved_by: codex-20260701-am21-scheduled-automation-store
reserved_at: 2026-07-01T17:20:52+02:00
branch: appmod/am21-scheduled-automation-store
worktree: ../veslo-appmod-am21-scheduled-automation-store
done: true
depends_on: [AM04]
target_module: packages/app/src/app/pages/scheduled-automation-store.ts
source_ranges:
  - packages/app/src/app/app.tsx:5134-5154
  - packages/app/src/app/app.tsx:9402-9679
```

Move:

- automation workspace summaries
- scheduled jobs source and readiness
- ensure scheduled jobs client
- refresh scheduled jobs
- create/update/delete/run automation actions
- automation item upsert and run list refresh

Test-first contract:

- Add `tests/pages/scheduled-automation-store.test.ts`.
- Extend or retarget existing scheduled page tests.
- Cover local source bootstrapping when server is not connected.
- Cover partial workspace failure.
- Cover create/update/delete/run item state changes.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/scheduled-automation-store.test.ts src/app/tests/pages/scheduled-automation-schedule.test.ts src/app/tests/pages/scheduled-layout-contract.test.ts
```

Acceptance:

- Dashboard props consume scheduled state/actions from a store module.
- `pages/scheduled.tsx` public props stay stable.

### Task AM22: Soul Dashboard Data Store

```yaml
id: AM22
status: merged
reserved_by: codex-20260701-am22
reserved_at: 2026-07-01T17:20:18.1205505+02:00
branch: appmod/am22-soul-data-store
worktree: ../veslo-appmod-am22-soul-data-store
done: true
depends_on: [AM04]
target_module: packages/app/src/app/pages/soul-data-store.ts
source_ranges:
  - packages/app/src/app/app.tsx:9681-9870
  - packages/app/src/app/app.tsx:11269-11291
```

Move:

- app workspace to Veslo workspace id mapping for Soul
- Soul overview refresh
- Soul status/heartbeat refresh
- active Soul status memo
- Soul prompt runner
- refresh effect keyed by server/workspace/auth state

Test-first contract:

- Add `tests/pages/soul-data-store.test.ts`.
- Reuse existing `pages/soul-controller.test.ts` and `soul-layout-contract`.
- Cover local path mapping, remote explicit id mapping, partial status failure,
  active workspace heartbeats, and prompt dispatch.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/soul-data-store.test.ts src/app/pages/soul-controller.test.ts src/app/pages/soul-layout-contract.test.ts
```

Acceptance:

- Dashboard props consume Soul state/actions from the store.

## Phase 7: Startup, Props, And Final Shell

### Task AM23: Startup Hydration And Preference Persistence

```yaml
id: AM23
status: merged
reserved_by: codex-20260701-am23-app-startup-hydration
reserved_at: 2026-07-01T17:59:00+02:00
branch: appmod/am23-app-startup-hydration
worktree: C:\Users\jajse\Desktop\projekty\veslo-appmod-am23-app-startup-hydration
done: true
depends_on: [AM01, AM04, AM06, AM18]
target_module: packages/app/src/app/context/app-startup-hydration.ts
source_ranges:
  - packages/app/src/app/app.tsx:11294-11711
  - packages/app/src/app/app.tsx:12316-12596
```

Move:

- startup preference restore
- cloud-only storage clearing
- update preference restore
- pending draft hydration call
- theme subscription bootstrap
- localStorage restore for baseUrl/client dir/engine/default model/thinking/
  titlebar/variant/update/notion/subagent decorations
- app version/update startup recovery
- desktop auth snapshot hydration trigger
- bootstrap onboarding guard
- preference persistence effects for baseUrl, clientDirectory, projectDir,
  engine source, engine runtime, model, thinking, max engines, idle suspend,
  titlebar, compaction, variant, update auto-check/download

Do not move:

- deep-link fan-in after AM18 owns it
- app shell environment after AM01 owns it

Test-first contract:

- Add `tests/context/app-startup-hydration.test.ts`.
- Retarget startup sections of `app-refactor-contracts.test.ts` and
  `app-startup-signal-order.test.ts`.
- Cover Tauri baseUrl is not restored or persisted.
- Cover update auto-download migration.
- Cover model variant startup migration.
- Cover startup guard completes after bootstrap.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/app-startup-hydration.test.ts src/app/tests/app-refactor-contracts.test.ts src/app/tests/app-startup-signal-order.test.ts src/app/tests/app-updater-retry-scheduling.test.ts
```

Acceptance:

- `app.tsx` calls one startup hydration module after all required stores exist.
- Boot behavior is unchanged for desktop and web.

### Task AM24: App View Prop Adapters

```yaml
id: AM24
status: merged
reserved_by: codex-20260701-230333-am24
reserved_at: 2026-07-01T23:03:33.9033528+02:00
branch: appmod/am24-app-view-props
worktree: ../veslo-appmod-am24-app-view-props
done: true
depends_on: [AM03, AM04, AM06, AM11, AM12, AM13, AM14, AM15, AM17, AM20, AM21, AM22]
target_module: packages/app/src/app/app-view-props.ts
source_ranges:
  - packages/app/src/app/app.tsx:12617-13325
```

Move:

- `headerConnectedVersion`
- `headerStatus`
- `busyHint`
- `localHostLabel`
- `onboardingProps`
- `dashboardProps`
- `sessionProps`
- `searchWorkspaceFiles` if it remains only a prop adapter callback

Do not move:

- real business workflows. They should already be in earlier modules.
- JSX rendering.

Test-first contract:

- Add `tests/app-view-props.test.ts`.
- Keep page-level layout tests passing.
- Cover dashboard props preserve remote/local skill/plugin permissions.
- Cover session props preserve reload banner blocked state, capabilities state,
  archive actions, send actions, and update actions.
- Cover onboarding props preserve auth/sign-in and workspace onboarding actions.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-view-props.test.ts src/app/tests/pages/dashboard-menu-navigation.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/settings-tabs-layout.test.ts src/app/tests/pages/skills-layout-contract.test.ts
```

Acceptance:

- `app.tsx` builds a single prop adapter object or calls focused prop builder
  functions.
- Prop types for `OnboardingView`, `DashboardView`, and `SessionView` remain
  stable unless a separate page plan approves changes.

### Task AM25: Final App Shell Cleanup

```yaml
id: AM25
status: merged
reserved_by: codex-20260701-232727-am25
reserved_at: 2026-07-01T23:27:27.3354699+02:00
branch: appmod/am25-final-app-shell-cleanup
worktree: ../veslo-appmod-am25-final-app-shell-cleanup
done: true
depends_on: [AM01, AM02, AM03, AM04, AM05, AM06, AM07, AM08, AM09, AM10, AM11, AM12, AM13, AM14, AM15, AM16, AM17, AM18, AM19, AM20, AM21, AM22, AM23, AM24]
target_module: packages/app/src/app/app.tsx
source_ranges:
  - packages/app/src/app/app.tsx
```

Purpose:

- Make `app.tsx` a readable composition root after all feature branches are
  merged.
- Remove dead imports, duplicate helper types, and stale source-contract
  comments.
- Update app map docs with final ownership.

Target files:

- `packages/app/src/app/app.tsx`
- `docs/dev/app-map.md`
- Any source-contract tests that still refer to moved inline blocks.

Test-first contract:

- Update `app-modularization-contract.test.ts` to assert final shell shape:
  - `app.tsx` remains the default exported `App`.
  - `app.tsx` composes the expected modules.
  - `app.tsx` does not contain large inlined blocks that should now be owned by
    extracted modules.
- The test should fail before final cleanup and pass after cleanup.

Focused verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-modularization-contract.test.ts src/app/tests/app-refactor-contracts.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

Final verification:

```bash
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

Acceptance:

- Every task above has `done: true`.
- `app.tsx` is primarily composition and JSX shell.
- `docs/dev/app-map.md` points future work to the new owning modules.
- No app source-contract test is weakened without behavior coverage replacing
  it.

## Progress Log

Append entries here. Keep each entry short and factual.

Format:

```text
YYYY-MM-DD HH:mm TZ - <task-id> - <agent> - <event> - <verification/result>
```

Entries:

2026-07-01 12:09 +02:00 - AM00 - codex-20260701-120436 - source-contract inventory/behavior - main retargets: app-feedback-flow, app-conversation-abort, app-send-*, app-session-*, pending-session-send-flow, app-skill-registry-events.
2026-07-01 12:09 +02:00 - AM00 - codex-20260701-120436 - source-contract inventory/wiring-placement - main retargets: app-refactor-contracts, app-managed-ai-*, app-startup/session-route-controller, app-veslo-server*, mcp-*, app-startup-signal-order, session-view-modularization.
2026-07-01 12:09 +02:00 - AM00 - codex-20260701-120436 - focused verification - first run failed before tests because new worktree lacked node_modules/tsx; after pnpm install, focused command passed 10/10.
2026-07-01 12:11 +02:00 - AM00 - codex-20260701-120436 - final verification - focused command passed 10/10; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 13:47 +02:00 - AM01 - codex-20260701-123848 - test-first focused verification - failed as expected because context/app-shell-environment.js does not exist; app-overlay-i18n passed 3/3.
2026-07-01 13:49 +02:00 - AM15 - codex-20260701-am15 - test-first focused verification - failed as expected because context/session-sidebar-decorations.js does not exist.
2026-07-01 13:58 +02:00 - AM15 - codex-20260701-am15 - final verification - focused command passed 10/10; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 14:10 +02:00 - AM06 - codex-20260701-am06 - test-first focused verification - failed as expected because context/den-desktop-auth-workflow.js does not exist.
2026-07-01 14:16 +02:00 - AM06 - codex-20260701-am06 - final verification - focused command passed 30/30; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 13:52 +02:00 - AM01 - codex-20260701-123848 - final verification - focused command passed 6/6; retargeted source-contract checks passed 18/18; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 13:53 +02:00 - AM01 - codex-20260701-123848 - merge verification - merged appmod/am01-app-shell-environment-effects; focused command passed 6/6; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 14:10 +02:00 - AM03 - codex-20260701-140710 - test-first focused verification - failed as expected because context/feedback-workflow.js does not exist; app-feedback-flow.contract passed 6/6.
2026-07-01 14:17 +02:00 - AM03 - codex-20260701-140710 - final verification - focused command passed 10/10; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 14:19 +02:00 - AM03 - codex-20260701-140710 - merge verification - merged appmod/am03-feedback-workflow; focused command passed 10/10; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 15:10 +02:00 - AM05 - codex-20260701-150643 - test-first focused verification - failed as expected because context/workspace-runtime-debug-probe.js does not exist; session-workspace-busy-source passed 1/1.
2026-07-01 15:15 +02:00 - AM05 - codex-20260701-150643 - final verification - focused command passed 4/4; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 15:17 +02:00 - AM05 - codex-20260701-150643 - merge verification - merged appmod/am05-workspace-runtime-debug-probes; focused command passed 4/4; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 15:13 +02:00 - AM14 - codex-20260701-am14 - test-first focused verification - after pnpm install, focused command failed as expected because context/session-archive-store.ts/js does not exist; existing archive model/settings checks passed 13/13.
2026-07-01 15:21 +02:00 - AM14 - codex-20260701-am14 - final verification - focused command passed 20/20; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 15:28 +02:00 - AM17 - codex-20260701-am17 - test-first focused verification - after pnpm install, focused command failed as expected because context/session-capabilities-store.ts/js does not exist; existing session capabilities/admin AI checks passed 14/14.
2026-07-01 15:36 +02:00 - AM17 - codex-20260701-am17 - final verification - focused command passed 19/19; app-send-latency-trace passed 20/20; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 15:27 +02:00 - AM13 - codex-20260701-152410 - test-first focused verification - failed as expected because pages/session-mutation-workflow.js does not exist; existing focused tests passed 7/7.
2026-07-01 15:41 +02:00 - AM13 - codex-20260701-152410 - final verification - focused command passed 13/13; retargeted source-contract checks passed 31/31; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 15:44 +02:00 - AM13 - codex-20260701-152410 - post-rebase verification - rebased onto local/sandbox-merge; focused command passed 13/13; retargeted source-contract checks passed 31/31; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check local/sandbox-merge..HEAD passed.
2026-07-01 15:46 +02:00 - AM13 - codex-20260701-152410 - merge verification - merged appmod/am13-session-mutation-commands; focused command passed 13/13; retargeted source-contract checks passed 31/31; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 17:07 +02:00 - AM19 - codex-20260701-am19-skill-registry-orchestrator - test-first focused verification - failed as expected because context/skill-registry-orchestrator.ts/js does not exist; existing lib/skill-registry-events checks passed 4/4.
2026-07-01 17:14 +02:00 - AM19 - codex-20260701-am19-skill-registry-orchestrator - final verification - focused command passed 9/9; workspace-session-snapshots passed 8/8; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 17:15 +02:00 - AM19 - codex-20260701-am19-skill-registry-orchestrator - post-adjustment verification - focused command passed 9/9; workspace-session-snapshots passed 8/8; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 17:16 +02:00 - AM19 - codex-20260701-am19-skill-registry-orchestrator - merged to local/sandbox-merge at 2eb26d40.
2026-07-01 17:05 +02:00 - AM16 - codex-20260701-170326 - test-first focused verification - failed as expected because context/session-route-sync.js does not exist; existing focused tests passed 30/30.
2026-07-01 17:11 +02:00 - AM16 - codex-20260701-170326 - final verification - focused command passed 35/35; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 17:13 +02:00 - AM16 - codex-20260701-170326 - merge verification - merged appmod/am16-session-route-sync; focused command passed 35/35; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check HEAD^..HEAD passed.
2026-07-01 17:19 +02:00 - AM20 - codex-20260701-171525 - test-first focused verification - failed as expected because context/mcp-connection-workflow.js does not exist; existing focused tests passed 17/17.
2026-07-01 17:23 +02:00 - AM22 - codex-20260701-am22 - test-first focused verification - after pnpm install, focused command failed as expected because pages/soul-data-store.ts/js does not exist; existing Soul tests mostly passed/skipped, with soul-layout-contract needing source retarget.
2026-07-01 17:27 +02:00 - AM22 - codex-20260701-am22 - final verification - focused command passed 18/18 with 10 existing Solid server-condition skips; app-soul-refresh/app-modularization contracts passed 8/8; targeted session-navigation marker tests passed 2/2; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 17:30 +02:00 - AM22 - codex-20260701-am22 - post-rebase verification - rebased onto local/sandbox-merge after AM20; focused command passed 18/18 with 10 existing Solid server-condition skips; app-soul-refresh/app-modularization contracts passed 8/8; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check local/sandbox-merge..HEAD passed.
2026-07-01 17:27 +02:00 - AM20 - codex-20260701-171525 - final verification - focused command passed 21/21; app-send-latency-trace plus app-modularization-contract passed 25/25; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 17:28 +02:00 - AM20 - codex-20260701-171525 - post-rebase verification - rebased onto local/sandbox-merge at 2eb26d40; focused command passed 21/21; app-send-latency-trace plus app-modularization-contract passed 25/25; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check local/sandbox-merge..HEAD passed.
2026-07-01 17:28 +02:00 - AM20 - codex-20260701-171525 - merge verification - merged appmod/am20-mcp-connection-workflow at 951a914a; focused command passed 21/21; app-send-latency-trace plus app-modularization-contract passed 25/25; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check HEAD^..HEAD passed.
2026-07-01 17:31 +02:00 - AM21 - codex-20260701-am21-scheduled-automation-store - merged appmod/am21-scheduled-automation-store at ae42b4c0; focused command passed 29/29; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 17:33 +02:00 - AM06 - codex-20260701-173304-am06-takeover - takeover - continuing existing AM06 worktree WIP with user approval; no done status change.
2026-07-01 17:36 +02:00 - AM22 - codex-20260701-am22 - post-AM21 rebase verification - rebased onto local/sandbox-merge at ae42b4c0 and resolved app.tsx store wiring conflict; AM22 focused passed 18 pass/10 skip; scheduled focused passed 8/8; app-soul-refresh/app-modularization contracts passed 8/8; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check local/sandbox-merge..HEAD passed.
2026-07-01 17:37 +02:00 - AM22 - codex-20260701-am22 - post-AM06 rebase verification - rebased onto local/sandbox-merge at 3511af40 without conflicts; AM22 focused passed 18 pass/10 skip; app-soul-refresh/app-modularization contracts passed 8/8; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check local/sandbox-merge..HEAD passed.
2026-07-01 17:41 +02:00 - AM18 - codex-20260701-am18-app-deep-link-workflow - test-first focused verification - after pnpm install, focused command failed as expected because context/app-deep-link-workflow.js does not exist; existing app-refactor-contracts checks passed 5/5.
2026-07-01 17:50 +02:00 - AM18 - codex-20260701-am18-app-deep-link-workflow - final verification - focused command passed 9/9; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 17:52 +02:00 - AM18 - codex-20260701-am18-app-deep-link-workflow - post-rebase verification - rebased onto local/sandbox-merge at 9789eba2 without conflicts; focused command passed 9/9; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check local/sandbox-merge..HEAD passed.
2026-07-01 17:36 +02:00 - AM06 - codex-20260701-173304-am06-takeover - post-rebase verification - rebased onto local/sandbox-merge at ae42b4c0; focused command passed 32/32; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check local/sandbox-merge..HEAD passed.
2026-07-01 17:37 +02:00 - AM06 - codex-20260701-173304-am06-takeover - merge verification - merged appmod/am06-den-desktop-auth-workflow at 3511af40; focused command passed 32/32; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check HEAD^..HEAD passed.
2026-07-01 17:39 +02:00 - AM14 - codex-20260701-am14 - takeover merge verification - merged appmod/am14-session-archive-store at 6169c434 after resolving AM06 import conflict; focused command passed 25/25; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 17:44 +02:00 - AM07 - codex-20260701-174058-am07 - test-first focused verification - after pnpm install, focused command failed as expected because context/managed-ai-access-store.ts/js does not exist.
2026-07-01 17:57 +02:00 - AM07 - codex-20260701-174058-am07 - post-rebase verification - rebased onto local/sandbox-merge at 7ef2fce3; focused command passed 28/28; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check local/sandbox-merge..HEAD passed.
2026-07-01 17:58 +02:00 - AM07 - codex-20260701-174058-am07 - merge verification - merged appmod/am07-managed-ai-access-profile-store at d2bed0f7; focused command passed 28/28; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check HEAD^..HEAD passed.
2026-07-01 18:01 +02:00 - AM08 - codex-20260701-175830-am08 - test-first focused verification - after pnpm install, focused command failed as expected because context/managed-ai-runtime-config.ts/js does not exist.
2026-07-01 17:51 +02:00 - AM22 - codex-20260701-am22 - merge verification - merged appmod/am22-soul-data-store at 9789eba2 after AM14 rebase; AM22 focused passed 62 pass/10 skip; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 17:53 +02:00 - AM18 - codex-20260701-am18-app-deep-link-workflow - merge verification - merged appmod/am18-app-deep-link-workflow at 7ef2fce3; focused command passed 14/14; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 17:59 +02:00 - AM23 - codex-20260701-am23-app-startup-hydration - reserved on appmod/am23-app-startup-hydration from main 7ef2fce3; keep done false until main merge verification.
2026-07-01 18:08 +02:00 - AM23 - codex-20260701-am23-app-startup-hydration - merge verification - rebased onto local/sandbox-merge at d2bed0f7 and merged appmod/am23-app-startup-hydration at 70d0e813; focused command passed 23/23; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 18:23 +02:00 - AM08 - codex-20260701-175830-am08 - post-rebase verification - rebased onto local/sandbox-merge at 70d0e813 after AM23 import conflict; AM08 focused plus retargeted source-contracts and app-modularization passed 38/38; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check local/sandbox-merge..HEAD passed.
2026-07-01 18:26 +02:00 - AM08 - codex-20260701-175830-am08 - merge verification - merged appmod/am08-managed-ai-runtime-config-sync at 7c5e1511; AM08 focused plus retargeted source-contracts and app-modularization passed 38/38; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check HEAD^..HEAD passed.
2026-07-01 22:18 +02:00 - AM12 - codex-20260701-221528-am12 - test-first focused verification - after pnpm install, focused command failed as expected because pages/session-creation-workflow.ts/js does not exist; app-session-creation-flow-contract also needs the AM12 retarget from app.tsx inline source to the new module.
2026-07-01 22:00 +02:00 - AM17 - codex-20260701-220025-am17-finish - takeover - continuing existing AM17 worktree WIP with user approval; no done status change.
2026-07-01 22:01 +02:00 - AM17 - codex-20260701-220025-am17-finish - post-rebase verification - committed WIP and rebased onto local/sandbox-merge at 7c5e1511; focused command passed 19/19; app-modularization/app-send-latency-trace passed 25/25; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check local/sandbox-merge..HEAD passed.
2026-07-01 22:02 +02:00 - AM17 - codex-20260701-220025-am17-finish - merge verification - merged appmod/am17-session-capabilities-store at a9e5e5a4; focused command passed 19/19; app-modularization/app-send-latency-trace passed 25/25; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check HEAD^..HEAD passed.
2026-07-01 22:12 +02:00 - AM15 - codex-20260701-am15 - takeover merge verification - rebased onto local/sandbox-merge at a9e5e5a4 and merged appmod/am15-session-sidebar-decorations at 48fa91ac; focused command passed 27/27; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed.
2026-07-01 22:15 +02:00 - AM12 - codex-20260701-221528-am12 - reserved on appmod/am12-session-creation-workflow from main 48fa91ac; keep done false until main merge verification.
2026-07-01 22:19 +02:00 - AM11 - codex-20260701-221919-am11 - reserved on appmod/am11-session-send-workflow from main 48fa91ac; implementation should wait for AM12 merge/rebase; keep done false until main merge verification.
2026-07-01 22:28 +02:00 - AM12 - codex-20260701-221528-am12 - merge verification - fast-forwarded appmod/am12-session-creation-workflow to local/sandbox-merge at e6a2e37d; focused command passed 14/14; app-modularization-contract passed 5/5; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed with existing CRLF warnings only.
2026-07-01 22:53 +02:00 - AM11 - codex-20260701-221919-am11 - final verification - rebased onto local/sandbox-merge at e6a2e37d after AM12; focused command passed 73/73; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed with existing CRLF warnings only; keep done false until main merge verification.
2026-07-01 22:56 +02:00 - AM11 - codex-20260701-221919-am11 - merge verification - fast-forwarded appmod/am11-session-send-workflow to local/sandbox-merge at fb81d98d; preserved and reapplied the pre-existing app-send-preflight-context local diff; focused command passed 73/73; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed with existing CRLF warnings only.
2026-07-01 23:03 +02:00 - AM24 - codex-20260701-230333-am24 - reserved on appmod/am24-app-view-props from main fb81d98d; keep done false until main merge verification.
2026-07-01 23:17 +02:00 - AM24 - codex-20260701-230333-am24 - final verification - extracted app view prop adapters at 1b61fdd1; focused command passed 129/129 including app-view-props, dashboard/session/settings/skills layout, screenshot regression, and app-modularization-contract; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --cached --check passed; keep done false until main merge verification.
2026-07-01 23:24 +02:00 - AM24 - codex-20260701-230333-am24 - merge verification - fast-forwarded appmod/am24-app-view-props to local/sandbox-merge at 1b61fdd1; preserved and moved the pre-existing soulWorkspaceMap app prop diff into app-view-props; focused command passed 129/129; pnpm --filter @neatech/veslo-ui typecheck passed; git diff --check passed with existing CRLF warnings only.
2026-07-01 23:27 +02:00 - AM25 - codex-20260701-232727-am25 - reserved on appmod/am25-final-app-shell-cleanup from main 1b61fdd1; keep done false until main merge verification.
2026-07-01 23:50 +02:00 - AM25 - codex-20260701-232727-am25 - merge verification - merged appmod/am25-final-app-shell-cleanup commit 840a47b1 into local/sandbox-merge; extracted app send trace owner, retargeted remaining app source-contract tests, and kept unrelated local dashboard/server work outside the merge commit.
2026-07-02 00:13 +02:00 - DOCS - codex - completion checkpoint - AM00-AM25 are merged/done, app.tsx measured 4,353 lines, pnpm --filter @neatech/veslo-ui typecheck passed, pnpm --filter @neatech/veslo-ui test:unit passed, and git diff --check passed with existing CRLF warnings only; recorded in docs/fixes/2026-07-02-fix-18-app-tsx-modularization-complete.md.
