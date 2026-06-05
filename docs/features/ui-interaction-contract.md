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
