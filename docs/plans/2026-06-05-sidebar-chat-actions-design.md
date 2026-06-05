# Sidebar Chat Actions Design

Date: 2026-06-05

## Context

The left sidebar in by-project mode has a bottom Chats section with its own
resizable and collapsible state. When that section is fully collapsed, the
current UI primarily communicates the hidden section label. The user still needs
an obvious way to create a chat from that collapsed state.

Project and workspace headers also expose a small plus icon for creating a
session in that project. The action works, but the affordance is too subtle and
does not read like a first-class button.

## Decision

Keep the Chats collapse/expand control, but make the collapsed state show a
compact `+ Chat` button as the primary visible action. Clicking that button will
create a chat and expand the Chats section so the new chat is immediately
visible.

The automatic expansion caused by `+ Chat` should use a conservative default
height that shows at most about three chat rows. Manual resize behavior remains
available and can still persist a larger user-selected height.

Make each project/workspace plus action look like an actual sidebar button, not
just an inline icon. Preserve the compact icon-only shape so project headers do
not become crowded.

## Behavior

- In by-project mode, when Chats is collapsed, the collapsed footer row keeps the
  expand affordance on the right.
- The same collapsed row also exposes a compact `+ Chat` button.
- Clicking `+ Chat` starts the existing quick-chat action and expands Chats.
- The post-create automatic expanded height is limited to roughly three chat
  rows so the sidebar does not jump to a large vertical footprint.
- Existing drag/resize interactions for Chats remain intact.
- Existing create-session-in-project behavior remains intact for every project
  header and recent empty-project fallback.
- Project plus buttons use visible button chrome: fixed size, border, surface,
  hover state, focus state, disabled state where applicable, and existing
  localized title and accessibility labels.

## Implementation Shape

Add a small helper for the compact project action button classes inside the
session sidebar component. Reuse it for the normal by-project header plus action
and the recent empty-project fallback plus action.

Split the collapsed Chats footer into two explicit controls:

- a `+ Chat` button that calls the existing quick-chat handler and expands Chats
- the existing expand control for revealing the hidden Chats section

Change the quick-chat path so it can expand Chats with a compact default height.
The helper should not overwrite a user's persisted manual height except when the
user triggers `+ Chat` from the collapsed state.

## Error Handling

If quick chat is unavailable, the `+ Chat` button should be disabled using the
same disabled affordance as other sidebar controls. If local storage reads or
writes for chat sidebar height fail, keep the current in-memory behavior and
fall back to a compact visible height.

## Verification

Use app-level checks first:

- `pnpm typecheck`
- focused `@neatech/veslo-ui` unit tests covering the sidebar layout

Add or update focused tests to assert:

- collapsed Chats still has an expand control
- collapsed Chats exposes a visible `+ Chat` button
- clicking the collapsed `+ Chat` path expands Chats before/while starting a
  quick chat
- automatic expansion uses a compact three-row default instead of the full saved
  height
- project header plus actions use button chrome rather than bare `p-1` icon
  styling

Because this is a user-visible sidebar interaction, verify the result in the
real Tauri desktop runtime when implementation is complete.
