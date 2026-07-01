# App.tsx Business Logic Deep Audit: Dev-Specific Handoff

Date: 2026-07-02

Scope: current `packages/app/src/app/app.tsx` after the app modularization work
on `local/sandbox-merge`.

This document is a read-only audit handoff for the next agent. No code changes
or runtime tests were performed while writing it.

The worktree was dirty during the audit, and another agent was already working
on the `sendPromptInFlight` wiring. Do not use this note as permission to
revert unrelated changes.

## High-Signal Findings

### 1. `sessionViewLockUntil` Is Wired As A Guard But Never Set

Files:

- `packages/app/src/app/app.tsx`
- `packages/app/src/app/context/app-route-sync.ts`
- `packages/app/src/app/tests/context/app-route-sync.test.ts`

Current shape:

- `app.tsx` creates `const [sessionViewLockUntil, setSessionViewLockUntil] =
  createSignal(0);`
- `createAppRouteSync()` receives `sessionViewLockUntil`.
- `app-route-sync.ts` blocks dashboard navigation when
  `now() < deps.sessionViewLockUntil()`.
- `setSessionViewLockUntil` is not called anywhere in the app.

Why this matters:

- In production wiring this guard is always disabled.
- The route-sync tests prove the controller supports this behavior, but the app
  no longer drives the state.

Recommended next-agent decision:

- Either remove the app-level signal and route-sync dependency if this guard is
  obsolete, with tests updated to reflect that.
- Or wire it intentionally from the session creation/handoff flow if the guard
  is still required.

Do not treat this as a pure rename. It is a behavior decision.

### 2. Per-Session Model Maps Look Dead In Current App Wiring

Files:

- `packages/app/src/app/app.tsx`
- `packages/app/src/app/pages/session-send-workflow.ts`

Current shape:

- `sessionModelOverrideById` and `sessionModelById` are created in `app.tsx`.
- `modelForSession()` reads both maps.
- `setSessionModelOverrideById({})` is called during config reset and workspace
  changes.
- `setSessionModelById` has no writer in current app wiring.
- `setSessionModelOverrideById` has no non-reset writer in current app wiring.

Why this matters:

- These two branches inside `modelForSession()` are effectively always empty.
- `modelForSession()` itself is not dead. The send workflow uses it for pending
  session materialization, and it still has useful fallbacks:
  - managed AI selected model
  - global default model
  - last user message model for the selected session

Recommended next-agent decision:

- Remove only the dead map layers if product no longer supports explicit
  per-session model overrides.
- Keep `modelForSession()` and the message/global/managed fallbacks unless a
  broader product decision says otherwise.

### 3. `autoCompactContext` Preference Layer Is Legacy

Files:

- `packages/app/src/app/app.tsx`
- `packages/app/src/app/context/app-startup-hydration.ts`
- `packages/app/src/app/app-view-props.ts`
- `packages/app/src/app/tests/app-view-props.test.ts`
- `packages/app/src/app/tests/pages/settings-tabs-layout.test.ts`

Current shape:

- `app.tsx` creates `autoCompactContext` with default `true`.
- Auto-compaction checks `autoCompactContext()` before compacting.
- Startup hydration does not restore a user-selected false value. It forces
  `veslo.autoCompactContext` to JSON `true`.
- Settings tests assert that `autoCompactContext` / `toggleAutoCompactContext`
  are not exposed in settings.
- `app.tsx` still passes `autoCompactContext` and `setAutoCompactContext` into
  `createAppViewProps()`, but `app-view-props.ts` no longer destructures or uses
  them.

Important distinction:

- The auto-compaction behavior is not obviously dead.
- The user preference/toggle/persistence layer appears dead or intentionally
  defaulted on.

Recommended next-agent decision:

- If auto-compaction should always be on, remove the preference signal, storage
  key persistence, app-view-props pass-through, and reset-default setter.
- If the preference should come back, reintroduce real load/set UI behavior and
  tests.

### 4. Clean Dead Aliases In `app.tsx`

Files:

- `packages/app/src/app/app.tsx`

Confirmed unused aliases:

- `activeSessions = createMemo(() => sessions())`
- `activeMessages = createMemo(() => messages())`
- `providerDefaults = createMemo(() => globalSync.data.provider.default ?? {})`

Why this matters:

- These are not business features; they are stale aliases.
- `activeMessages` is not used instead of `messages()` or `visibleMessages()`.
- `activeSessions` is unrelated to the local `activeSessions` variable inside
  `forceStopActiveSessionsAndReload()`.
- Provider default setters are still used elsewhere, but the `providerDefaults`
  memo is not.

Recommended next-agent action:

- Remove these aliases with a tiny focused diff.
- Run typecheck or the narrow source-contract tests that cover `app.tsx`.

### 5. Skill Fallback Auto-Reload State Is Probably A Leftover

Files:

- `packages/app/src/app/app.tsx`
- `packages/app/src/app/lib/skill-reload-guard.ts`
- `packages/app/src/app/tests/lib/skill-reload-guard.test.ts`

Current shape:

- `createSkillReloadGuard()` is still meaningful. It waits for OpenCode
  hot-reload confirmation before showing a skill reload-required fallback.
- `markReloadRequired("skills")` is still called by skills/plugins flows.
- `pendingSkillFallbackAutoReload` is set when the fallback fires.
- A later effect immediately clears `pendingSkillFallbackAutoReload`.
- A comment says legacy skill-fallback auto-reload was removed.
- There is an empty `onMount(() => { /* comment only */ })` block saying Veslo
  no longer listens for legacy reload-required events.

Recommended next-agent decision:

- Keep `createSkillReloadGuard()` unless replacing the whole skill reload
  fallback contract.
- Remove the local `pendingSkillFallbackAutoReload` signal/effects if they no
  longer drive behavior.
- Remove the empty `onMount` block.

## Do Not Remove Without A Separate Behavior Review

These pieces look unusual but are probably not dead:

- `visibleRuntimeActivityHold` and `activeVisibleRuntimeActivityId`
  - Used to keep runtime refresh/polling from racing active sends and accepted
    run handoff.
  - Covered by `app-send-latency-trace.test.ts`.

- `latestRunArtifactResponse` and latest-run artifact refresh
  - Keeps server artifacts authoritative for the selected scoped session.
  - Resolves workspace/directory from selected session scope instead of blindly
    using the active workspace.
  - Covered by source-contract tests and artifact-family tests.

- `workspaceStoreRefVersion`
  - Awkward bootstrap bridge for controllers created before `workspaceStore`
    assignment.
  - Covered by dashboard/session navigation source-contract tests.

- `legacyDefaultModel`
  - Still acts as the global/default model fallback when workspace config does
    not specify a model.

- session directory override and pending initial session title logic
  - These cross sidebar/session transcript/session creation behavior.
  - They may be extraction candidates, but not deletion candidates.

## AppViewProps Boundary Note

`AppViewPropsScope` is currently `Record<string, any>`.

During the audit, a read-only compare found:

- 293 keys passed from `app.tsx` into `createAppViewProps()`
- 291 keys destructured by `app-view-props.ts`
- extra pass-through keys:
  - `autoCompactContext`
  - `setAutoCompactContext`

This loose input type lets stale pass-through dependencies survive after the
view adapter stops using them. If the next agent touches this boundary, prefer a
typed `AppViewPropsScope` contract or another narrow guard that fails when
`app.tsx` passes unused view props.

## Suggested KISS Order

1. Remove pure dead aliases:
   - `activeSessions`
   - `activeMessages`
   - `providerDefaults`

2. Remove app-view-props dead pass-through:
   - `autoCompactContext`
   - `setAutoCompactContext`

3. Decide `autoCompactContext` product intent:
   - always-on auto-compaction, or real preference toggle.

4. Decide `sessionViewLockUntil`:
   - remove obsolete guard, or wire it intentionally.

5. Decide per-session model maps:
   - remove dead map layers, or restore real writers.

6. Clean skill fallback leftover:
   - preserve `createSkillReloadGuard()`
   - remove only no-op local pending state and empty `onMount`, if confirmed.

## Verification Suggestions

For tiny cleanup-only slices:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/app-view-props.test.ts \
  src/app/tests/context/app-route-sync.test.ts \
  src/app/tests/pages/session-send-workflow.test.ts \
  src/app/tests/lib/skill-reload-guard.test.ts

pnpm --filter @neatech/veslo-ui typecheck
git diff --check HEAD
```

Do not include the currently in-progress `sendPromptInFlight` work in these
cleanup slices unless that other agent has merged first.
