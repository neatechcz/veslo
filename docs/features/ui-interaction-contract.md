# UI Interaction Contract

This document defines app-wide interaction behavior that future UI work should
preserve.

## Text Selection

Veslo should not expose accidental browser-style text selection on standard app
controls. Buttons, menu rows, navigation items, tabs, toolbar actions, badges,
chips, status pills, list controls, session-sidebar rows, project rows, and
bulk-selection controls should behave like native app chrome: clicking and
dragging them should activate, focus, scroll, or open the intended control, not
highlight the label text.

Text selection is appropriate only on editable or document-like content:

- the Composer message box
- rendered message text, code blocks, terminal/log output, and similar
  transcript content
- skill detail descriptions, review notes, package text, and other readable
  detail content where copying the text is useful
- diagnostics, configuration snippets, and exported text previews

If a new surface is ambiguous, treat command chrome as non-selectable and
content regions as selectable. Do not make selection available just because a
control label is implemented with regular text.

## Modal Dismissal

Shared modal shells may close from backdrop clicks by default when the modal
content is simple and no copyable content is at risk. Modals that contain user
input, generated diagnostics, issue identifiers, logs, or other text users may
need to select and copy must not close from backdrop clicks. Those modals should
close from their explicit close control and from Escape.

Escape dismissal is owned by the visible modal. A modal that handles Escape
must mark the keyboard event handled before app-level shortcuts run, so closing
the modal does not also trigger session-level actions such as stopping an active
agent run.

## Drag Behavior

Standard UI controls should not be draggable by default. Dragging a button,
menu item, sidebar row, list row, tab, chip, or action label should not create a
browser drag ghost, select label text, or start any implicit drag-and-drop
operation.

Drag behavior is reserved for explicit interaction surfaces:

- Tauri window drag regions such as titlebar chrome
- explicit reorder handles or other visible drag affordances
- Composer attachment/file drop targets
- text selection inside editable or document-like content regions

When adding a menu, list, or repeated row control, apply the same rule to every
interactive child unless that child is an explicit content field.

## Left Sidebar Context Menus

Every part of the left sidebar shares one context-menu behavior, backed by a
single menu primitive and a declarative per-target item model.

Right-click targets and their actions:

- **Session rows** (project view): Rename, Archive/Unarchive, then a "Project"
  group (Share, Soul settings, Reveal in Finder/Explorer, and for remote
  workspaces Recover / Test connection / Edit connection), then Delete. No
  "Open" item — opening a session stays the row's left-click action.
- **Chat rows**: Rename, Archive/Unarchive, Delete.
- **Recent rows**: session actions plus "Show in project", which switches to
  the by-project view, expands the project, and scrolls it into view. No
  project action group.
- **Project headers** and the workspace "…" button: New session, Rename,
  Share, Soul settings, Reveal (local), remote connection actions, and Remove
  workspace. "Remove workspace" appears only here, never on session rows.
- **Empty list area**: Add directory/project (same action as the toolbar
  button), Search sessions, Archived items.

Behavioral rules:

- Unavailable actions render disabled rather than hidden, so the menu shape
  stays stable while a workspace is connecting or switching.
- If text is selected inside the target when right-clicking, a Copy item is
  prepended; the menu always prevents the default context menu so the global
  desktop copy handler never fires alongside it.
- Escape, outside clicks, scrolling, window resize, and window blur close the
  menu. Arrow keys move focus between items; Enter/Space activates.
- The dashboard navigation and the bottom status controls intentionally have
  no context menu — they own dedicated controls.

## Active Run Timing

The session footer run indicator should show elapsed time for the active agent
run to all users. The label must use human time units rather than milliseconds:
sub-second runs show `<1 s`, then seconds, minutes, and hours as the run grows.
Developer diagnostics may record millisecond values internally, but the visible
run indicator should not expose millisecond formatting.
