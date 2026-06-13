# App Controller Refactor Implementation Plan

## Goal

Reduce `packages/app/src/app/app.tsx` from a global orchestration component into a thin shell. Move route, session creation, startup hydration, and managed config synchronization into small controller modules with pure decision helpers and focused effects.

The immediate motivation is to prevent Solid reactive loops where a route effect reads session state and writes the same session state, causing full UI rewrites, duplicate selection, aborted runs, or `Maximum call stack size exceeded`.

## Current Findings

- `app.tsx` contains roughly 78 `createEffect` calls.
- About 40 effects primarily synchronize state.
- About 23 effects start async/network work.
- Two large effects own route/navigation decisions.
- `selectSession` is already modularized in `context/session.ts`, but route orchestration and create-session orchestration still live in `app.tsx`.
- The riskiest patterns are effects that both read and write route/session state, and effects that call network APIs while also mutating global UI state.

## Target Structure

```text
packages/app/src/app/
  controllers/
    README.md
    session-route-controller.ts
    session-creation-flow.ts
    app-startup-controller.ts
    managed-ai-config-sync.ts
  context/
    session.ts
    workspace.ts
    workspace-session-snapshots.ts
    ...
  tests/
    controllers/
      session-route-controller.test.ts
      session-creation-flow.test.ts
      app-startup-controller.test.ts
      managed-ai-config-sync.test.ts
```

Controller responsibilities:

- `session-route-controller.ts`: pure route decisions for `/session`, `/session/:id`, pending session ids, own-navigation guards, and fallback redirects.
- `session-creation-flow.ts`: create conversation/session, materialize optimistic session/sidebar state, navigate, then call `selectSession`.
- `app-startup-controller.ts`: localStorage hydration, desktop snapshot hydration, deep-link fan-in, onboarding initial state.
- `managed-ai-config-sync.ts`: default model resolution, managed provider routing config writes, reload-required marking.

## Solid Guidelines

- Use `createMemo` for derived values. Avoid `createEffect` plus setter when no external side effect is needed.
- Effects may subscribe, persist to storage, call external APIs, or run a controller action. They should not encode multi-branch domain policy inline.
- Route effects should not write session state that is owned by `selectSession`.
- Store modules should not navigate. They should return a result or emit an intent.
- Use `batch` for multi-signal UI transitions.
- Use `untrack` for incidental reads inside effects or commands.
- Use request ids/stale guards for async effects.

## Migration Steps

### Step 1: Extract Session Route Policy

Status: started.

Files:

- Add `controllers/session-route-controller.ts`.
- Add `tests/controllers/session-route-controller.test.ts`.
- Keep `app.tsx` wiring unchanged until the policy is covered.

Acceptance:

- Pure tests cover own-navigation consumption, live/offline reselection, foreign workspace ignore, pending session ids, and bare `/session` clearing.
- Route guard does not write `selectedSessionId` when consuming create-session navigation.

### Step 2: Wire Session Route Controller Into `app.tsx`

Replace route effect branches with:

```ts
const decision = resolveSessionPathDecision(...);
executeSessionPathDecision(decision);
```

Acceptance:

- Existing `session-route-client-resume.test.ts` passes.
- New controller tests pass.
- No direct `setSelectedSessionId(id)` remains in route guard branches except pending session handling, unless moved into explicit decision execution.

### Step 3: Extract Session Creation Flow

Create `controllers/session-creation-flow.ts` around the current `createSessionAndOpen` sequence.

The flow order must remain:

1. preflight gates
2. create Veslo conversation or OpenCode session
3. register optimistic title
4. insert session into store
5. materialize sidebar item
6. set own-navigation guard
7. navigate to `/session/:id`
8. call `selectSession`
9. return created id

Acceptance:

- Source-code tests assert the order.
- Unit tests cover "no client", "empty root", "Veslo create fallback", and "own-navigation guard before select".

### Step 4: Extract Startup Hydration

Move the boot `onMount` and localStorage hydration into `app-startup-controller.ts`.

Acceptance:

- Existing startup/deep-link tests move from app source scanning toward controller tests.
- `app.tsx` keeps only `createAppStartupController(...).start()`.

### Step 5: Extract Managed AI Config Sync

Move default model and provider routing config effects into `managed-ai-config-sync.ts`.

Acceptance:

- Config write policy is pure-testable.
- Effects only execute returned commands.
- Managed config writes never reload or dispose the engine directly.

### Step 6: Reduce `app.tsx` Surface

Target budget:

- Under 35 `createEffect` calls in `app.tsx`.
- No route policy branches longer than 20 lines in `app.tsx`.
- No async function over 150 lines in `app.tsx`.
- No store module callback that both clears selected session and navigates.

## Test Plan

Run after each step:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm `
  src/app/tests/controllers/session-route-controller.test.ts `
  src/app/tests/session-route-client-resume.test.ts `
  src/app/tests/context/session-select-background-hydration.test.ts `
  src/app/tests/context/workspace-session-snapshots.test.ts

pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui build
```

Manual verification:

- Restart Tauri pilot after Vite config changes.
- Send a prompt in a new session.
- Switch workspaces while a run is active.
- Confirm no timer reset, no duplicate `prompt_async`, no unintended `abort`, and no Solid stack overflow.
