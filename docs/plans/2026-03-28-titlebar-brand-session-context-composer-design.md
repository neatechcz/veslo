# Titlebar Brand + Session Context + Composer Relayout Design

**Date:** 2026-03-28  
**Status:** Approved  
**Branch:** `codex/titlebar-session-composer`

## Goal

Move `Veslo by Neatech` into the shared native titlebar area next to the left-menu toggle, move the current session directory label into the same titlebar instead of the composer, and reshape the session composer so the input is visually wider while the AI disclaimer moves out of the input box into the lower-right edge of the center panel.

## Scope

- Shared titlebar UI used by desktop app views:
  - `packages/app/src/app/components/titlebar-menu-toggles.tsx`
  - `packages/app/src/app/components/titlebar-menu-layout.ts`
- Session page layout:
  - `packages/app/src/app/pages/session.tsx`
- Dashboard and other views that render the shared titlebar:
  - `packages/app/src/app/pages/dashboard.tsx`
- Session composer UI:
  - `packages/app/src/app/components/session/composer.tsx`
  - `packages/app/src/app/components/session/composer-workspace-label.ts`
  - `packages/app/src/app/components/session/composer-disclaimer.ts`
- Titlebar / session / composer source-contract tests.

Out of scope:

- Adding any new header row below the titlebar.
- Changing sidebar visibility logic, persistence, or docking rules.
- Changing the right titlebar toggle behavior.
- Redesigning dashboard content or settings layout outside the shared titlebar brand treatment.
- Changing the disclaimer copy itself.

## Validated Product Decisions

1. The target repo is `/Users/vaclavsoukup/AI agent projects/Veslo`.
2. `Veslo by Neatech` should live directly in the titlebar, next to the left toggle.
3. No new menu row, subheader, or extra bar may be added under the titlebar.
4. The session working directory should also live in the titlebar, not in the composer.
5. The session titlebar directory label should display only the last path segment, matching current composer behavior.
6. The directory label should appear only on screens where it makes product sense, especially the chat/session screen.
7. Settings and similar screens should not show a meaningless directory label.
8. The composer should be widened so it uses almost the full available width of the center panel.
9. The disclaimer should be removed from the composer and placed under the input in the lower-right corner of the center panel.
10. The disclaimer must continue to work in all supported locales via the existing i18n key.

## Options Considered

### Option 1: Shared titlebar shell with session-specific center context (chosen)

- Keep one shared titlebar component.
- Add a stable left brand slot for all relevant app views.
- Allow pages to provide optional center content to the titlebar.
- In `SessionView`, provide the current directory leaf as the titlebar center content.
- Remove both the workspace label and disclaimer from the composer, then widen the composer layout.

Pros:

- Matches the approved behavior exactly.
- Keeps global identity and session context in the same top chrome layer.
- Avoids introducing a second header or duplicate context surfaces.
- Keeps non-session pages simple by passing no center content.

Cons:

- Requires careful titlebar spacing so the center label does not collide with the right toggle.
- Touches both shared chrome and session layout tests.

### Option 2: Sidebar-owned brand and session-only top context

Pros:

- Smaller code change than restructuring the shared titlebar.

Cons:

- Fails the requirement that the brand stays visible next to the left-toggle even when the left sidebar is closed.
- Splits brand and session context across different surfaces.

### Option 3: Composer-only reflow with titlebar untouched

Pros:

- Lowest implementation risk.

Cons:

- Fails the requirement to move the directory into the titlebar.
- Keeps top-level chrome weaker than requested.

## Recommended Approach

Use Option 1.

- Treat the titlebar as the only top chrome layer.
- Extend the shared titlebar component so it can render:
  - a left-side brand next to the existing left toggle
  - optional center content supplied by the current page
- Keep the session-specific directory logic in `SessionView`, not inside the shared titlebar component.
- Leave non-session pages without a directory label.
- Simplify the composer to a wider input-first control surface with no embedded session label and no embedded disclaimer.

## Architecture

### Shared titlebar responsibilities

The shared titlebar component should own:

- left toggle
- left brand content
- right toggle
- drag-region-safe layout and platform offsets

It should also expose an optional center-content slot. This keeps titlebar rendering global while allowing page-specific context.

### Page responsibilities

- `SessionView` derives the current directory label and passes it to the titlebar center slot.
- `DashboardView` and other views pass no center content unless they later need explicit titlebar context.
- `SessionView` also owns the relocated disclaimer because it becomes part of the session page layout, not part of the input component.

### Composer responsibilities

`composer.tsx` should be reduced back to input and control actions only:

- editor
- attachment actions
- agent mode switch
- folder chooser action if still applicable
- send / stop control

It should no longer own:

- current workspace leaf label
- disclaimer placement logic

## Component And Data Flow

### Titlebar brand

`TitlebarMenuToggles` currently renders only the left and right toggle buttons. It should be reshaped into a shared titlebar shell that still preserves platform-safe classes from `resolveTitlebarMenuLayout(...)`, while adding inline content next to the left toggle.

Expected left-side composition:

`[left toggle] [Veslo by Neatech]`

### Session directory label

The existing helper `resolveComposerWorkspaceLabel(...)` already knows how to produce the last local path segment and fallback labels. That behavior should be reused so the directory label shown in the titlebar matches current behavior instead of introducing a second path formatter.

In session view:

- local workspace: show the last segment
- remote workspace: keep existing remote/local fallback semantics if the current helper already resolves them
- empty / not meaningful workspace: show nothing rather than a fake placeholder in the titlebar

### Composer width and disclaimer

The session composer currently shares a center width cap of `960px`, but its internal control rail still reads visually compact because the directory label and disclaimer occupy the same row.

The new structure should:

- keep a generous center max width for the input container
- stretch the input box visually across most of the center panel
- align left actions near the left edge of the composer
- align send / stop near the right edge of the composer
- render the disclaimer outside the composer, anchored to the lower-right edge of the center panel just below the input

## Layout Behavior

### Titlebar

- No extra row below the titlebar.
- Brand is always visible in the titlebar next to the left toggle.
- Session directory is visible in the titlebar only when the current screen has active workspace context.
- The directory label must truncate safely if the window gets narrow.
- Right-side titlebar toggle remains where it is today.

### Session center panel

- The composer remains docked at the bottom of the center panel.
- The disclaimer sits below the composer, aligned to the bottom-right of the center panel.
- The composer itself becomes more compact horizontally, meaning less dead center whitespace and more direct use of available width.

### Non-session screens

- Dashboard and other app surfaces keep the shared titlebar brand treatment.
- No synthetic directory label appears on settings or other screens where it would be meaningless.

## Risks

1. Native-titlebar spacing is platform sensitive. On macOS and Windows the new brand text reduces the free width around the center titlebar slot, so truncation and offset behavior need explicit coverage.
2. The current session directory helper lives near the composer. Reusing it from `SessionView` is correct, but the code boundary must stay clean so the shared titlebar does not become session-aware.
3. Moving the disclaimer out of the composer will intentionally break current source-contract tests that encode the old structure. Those tests must be updated instead of patched around.
4. Existing `packages/app` `typecheck` is already failing outside this scope. Implementation verification must separate pre-existing failures from feature regressions.

## Testing Strategy

### Source-contract / unit verification

- Update titlebar tests to verify:
  - left titlebar still exposes left and right toggles
  - brand content renders next to the left toggle
  - center slot can render session context without changing drag-region rules
- Update session/composer tests to verify:
  - workspace label no longer renders inside the composer rail
  - disclaimer no longer renders inside the composer rail
  - composer uses a widened control layout
- Add a session page source test verifying:
  - session passes the current directory leaf into the shared titlebar
  - disclaimer is rendered in the session layout outside the composer

### Type and regression checks

- Run targeted node tests covering titlebar, session width, composer layout, and workspace-label behavior.
- Run `pnpm --filter @neatech/veslo-ui typecheck` and record that current baseline contains unrelated pre-existing failures unless those failures are fixed separately.

### Manual verification

In the Tauri desktop app:

1. Open Session view and confirm `Veslo by Neatech` is visible in the titlebar next to the left toggle.
2. Confirm the current directory leaf is visible in the same titlebar, not under it.
3. Confirm the composer is visually wider than before.
4. Confirm the disclaimer is below the composer at the lower-right edge of the center panel.
5. Open Dashboard and confirm the brand remains in the titlebar.
6. Open Settings and confirm no misleading directory label appears.

## Acceptance Criteria

- `Veslo by Neatech` renders in the shared titlebar beside the left menu toggle.
- No new header row is added below the titlebar.
- Session view renders the current working directory leaf in the titlebar itself.
- The session directory label no longer appears inside the composer.
- The disclaimer no longer appears inside the composer.
- The disclaimer appears below the input at the lower-right edge of the session center panel.
- The composer uses a visibly wider layout across the center panel.
- Non-session pages keep the shared titlebar brand treatment and do not show a meaningless directory label.
