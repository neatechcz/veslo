# Sidebar Collapse Animation Design

Date: 2026-06-03

## Context

The left sidebar already persists two independent pieces of convenience UI state:

- project collapse state in by-project mode
- parent session expansion state for session/subagent branches

The current rendering hides collapsed project contents immediately and filters hidden
subagent rows out of a flat row list. The requested change is visual feedback only:
expand and collapse should feel continuous without changing the existing navigation,
persistence, or data-loading behavior.

## Decision

Use a small local collapse/expand presentation helper in the sidebar component. Do
not add a motion dependency. The helper will keep content mounted long enough to
animate from measured height to zero on collapse and from zero to measured height
on expand.

## Behavior

- In by-project mode, collapsing or expanding a project animates that project's
  session list as one unit.
- In by-project mode, collapsing or expanding a parent session animates that
  session's subagent branch.
- In recent mode, only parent session/subagent branches animate.
- The session branch interaction remains unchanged: branch expansion only follows
  the existing row-click rules for a selected parent session with children.
- `prefers-reduced-motion: reduce` disables movement and uses an immediate state
  change.

## Animation

Use a short, understated animation around 160 ms:

- height from measured content height to `0`, or back
- opacity from `1` to `0`, or back
- a small vertical offset during entry/exit

The animation should not change row spacing or typography, and should not make
hover actions, context menus, archive controls, pagination controls, or project
drag/reorder feedback harder to use.

## Implementation Shape

Add a sidebar-local animated collapse wrapper that receives:

- an `open` boolean
- child content
- optional class names for the inner list spacing

For project collapse, wrap the existing project session list and its load-more /
show-less controls.

For session branches, derive grouped render segments from the existing visible row
order so each parent can own an animated child container. The existing flat
visibility model remains the source of truth for which rows should be visible.

## Error Handling

Animation measurement failures should degrade to the current behavior: content is
shown when open and hidden when closed. Storage read/write failures remain handled
by the existing sidebar preference helpers.

## Verification

Use app-level checks first:

- `pnpm typecheck`
- `pnpm --filter @neatech/veslo-ui test:unit`

Add focused tests around the sidebar wiring to ensure:

- project collapse still persists through the existing project map
- session branch expansion still uses the existing row-click path
- no dedicated session branch toggle button is introduced
- the new animation wrapper is used for project content and session child branches

Because the change affects the desktop sidebar experience, verify the visual
behavior in the real Tauri desktop runtime following the repository testing
playbook.
