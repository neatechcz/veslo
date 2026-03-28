# Left Menu Return To Session Design

**Date:** 2026-03-28  
**Status:** Approved  
**Branch:** codex/menu-return-last-session

## Goal

Make the left titlebar menu button return the user from dashboard-side surfaces back to the last selected session for the active workspace, with the same behavior on desktop and narrow viewports.

## Scope

- Dashboard left-menu action resolution in:
  - `packages/app/src/app/pages/dashboard-menu-navigation.ts`
- Dashboard left-menu button handling in:
  - `packages/app/src/app/pages/dashboard.tsx`
- Existing selected-session persistence already maintained in:
  - `packages/app/src/app/app.tsx`
- Target tabs covered by the current return-to-session rule:
  - `scheduled`
  - `soul`
  - `skills`
  - `mcp`
  - `plugins`
  - `config`
  - `settings`

Out of scope:

- Session-page sidebar or overlay behavior.
- New route history state or a general-purpose "back" stack.
- New localStorage keys or new session persistence models.
- Changes to bottom mobile dashboard navigation.
- Changes to workspace/session selection persistence.

## Validated Product Decisions

1. The target repo is `/Users/vaclavsoukup/AI agent projects/Veslo`.
2. The requested behavior is: when the user is on `Automations`, `Soul`, `Skills`, `Extensions`, or related menu surfaces, pressing the left menu button again should return them to the last selected session.
3. The behavior should be the same everywhere, not mobile-only.
4. The preferred approach is the smallest possible change that reuses the current state model.
5. We should not introduce a new route-history abstraction for this feature.
6. We should keep the fallback behavior safe: if no session is selected, the left menu button should still behave as a sidebar toggle.
7. Session return should stay scoped to the active workspace.
8. Tests should stay focused on the dashboard navigation rule rather than expanding into unnecessary end-to-end coverage at this stage.

## Options Considered

### Option 1: Reuse the existing selected-session rule on all viewports

Remove the viewport gate from the dashboard left-menu action resolver and keep the rest of the rule intact.

Pros:

- Smallest change.
- Reuses existing `selectedSessionId` wiring.
- Reuses the existing per-workspace "last session" persistence.
- Keeps behavior consistent between desktop and narrow layouts.

Cons:

- On desktop dashboard surfaces, the left menu button stops being a pure sidebar-toggle affordance whenever a return target exists.

### Option 2: Add a generic route-history "back" behavior

Track prior routes and let the left menu button behave like a history back action.

Pros:

- More flexible and more generally expressive.
- Could support future non-session return flows.

Cons:

- Introduces extra state and edge cases.
- Harder to reason about with workspace switches, deleted sessions, and direct deep links.
- Overbuilt for the requested outcome.

### Option 3: Keep viewport-specific behavior but add a desktop-only special case

Preserve the current narrow behavior and add parallel logic elsewhere for desktop.

Pros:

- Minimizes immediate behavior change on desktop.

Cons:

- Creates two sources of truth for the same UX.
- Directly conflicts with the approved requirement that behavior be the same everywhere.

## Recommended Approach

Use Option 1.

- Keep `resolveLeftMenuAction(...)` as the single source of truth for the dashboard left-menu button.
- Remove viewport-specific gating so the same rule applies on desktop and narrow screens.
- Continue using the existing selected session of the active workspace as the return target.
- Keep fallback sidebar-toggle behavior when no valid session target exists.

## Architecture

### Return target source

Do not add new state.

The return target already exists in the current app model:

- `selectedSessionId` is passed into `DashboardView`
- `app.tsx` already persists the last selected session by workspace in `veslo.workspace-last-session.v1`
- dashboard return behavior can stay route-driven by calling `setView("session", sessionId)`

This means the feature is a navigation-policy change, not a data-model change.

### Dashboard menu action resolution

`packages/app/src/app/pages/dashboard-menu-navigation.ts` should continue to answer one question:

- should the left titlebar menu button toggle the left sidebar, or
- should it return to the selected session?

After this change, the decision should depend only on:

- whether the current dashboard tab belongs to the existing session-return set
- whether `selectedSessionId` is non-empty

It should no longer depend on viewport width.

### Dashboard button wiring

`packages/app/src/app/pages/dashboard.tsx` should keep its current `handleLeftMenuToggle()` structure:

- resolve the action
- if the action is `return-to-session`, call `props.setView("session", action.sessionId)`
- otherwise toggle the left sidebar

No new routing helper is needed.

## Interaction And State Behavior

- On `scheduled`, `soul`, `skills`, `mcp`, `plugins`, `config`, and `settings`, the left menu button returns to the currently selected session when one exists.
- The same rule applies on desktop and narrow screens.
- If no session is selected for the active workspace, the left menu button continues to toggle the left sidebar.
- The return target remains the active workspace's last selected session, not a global session from another workspace.
- Deleted-session cases remain safe because the existing route/session guards already fall back away from missing sessions.

## Risks

1. Desktop users may already think of the left menu button primarily as a sidebar toggle, so the behavior change must stay tightly scoped to the current dashboard return set.
2. If the implementation accidentally changes the return-tab set instead of only removing the viewport gate, behavior could regress on tabs that already return correctly in narrow mode.
3. If tests only assert the helper in isolation and not the dashboard wiring, the route action could regress silently in `dashboard.tsx`.

## Testing Strategy

### Unit verification

- Update `packages/app/src/app/pages/dashboard-menu-navigation.test.ts` to verify:
  - return-to-session on desktop-width conditions
  - return-to-session on narrow-width conditions
  - fallback toggle behavior when no selected session exists
- Add a dashboard wiring test only if needed to make the route action explicit.

### Manual verification

1. Open a session in a workspace.
2. Navigate from that session to `Automations`, `Soul`, `Skills`, and `Extensions`.
3. Press the left titlebar menu button on desktop and confirm it returns to the prior session.
4. Repeat on a narrow/mobile-width layout and confirm the same behavior.
5. Clear or avoid session selection and confirm the button falls back to toggling the left sidebar.
6. Switch workspaces and confirm the return target stays scoped to the currently active workspace.

## Acceptance Criteria

- The left titlebar menu button returns from dashboard-side menu surfaces back to the last selected session on desktop and narrow screens.
- The feature reuses the existing selected-session and per-workspace persistence model.
- No new route-history abstraction or new persistence key is introduced.
- When no session is selected, the left menu button still toggles the left sidebar.
- Focused dashboard navigation tests cover the unified behavior.
