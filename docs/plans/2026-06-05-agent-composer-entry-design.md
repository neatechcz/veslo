# Agent Composer Entry Design

Date: 2026-06-05

## Context

The empty session screen currently starts with a quickstart area: a headline, explanatory text, and starter prompt cards. The approved design removes that area and makes the composer itself the primary entry point for creating an agent conversation.

The design was mocked in Pencil on the `Agent Composer Entry Proposal CZ` board in `docs/UI designs.pen`.

## Goals

- Remove the quickstart prompt cards and generic starter headline from the empty new-session screen.
- Vertically center the composer as the dominant region when no transcript is visible.
- Show the current conversation target above the composer in larger type.
- Provide a target picker that is always available on the empty composer entry surface.
- Let users switch between private chat and project/workspace targets before sending.
- Protect existing draft content when switching to a target that already has a pending draft.

## Out Of Scope

- Changing the message transcript layout after a session has messages.
- Changing the composer send behavior, queue behavior, attachments, shell mode, slash commands, or agent mode controls.
- Adding a new durable draft storage layer.
- Reworking the sidebar workspace/session model.

## Approved UX

The empty entry surface uses a centered stack:

1. Large target headline, for example `Vkládáš do projektu Veslo`.
2. A compact target picker pill showing the target label and path or context.
3. The existing composer control, visually unchanged except for its vertical placement.
4. The existing AI disclaimer below the composer.

The target picker opens a compact menu with:

- `Chat`
- known local or remote workspaces/projects
- draft status badges such as `Rozepsáno`
- an option to choose another slash workspace/project when applicable

The picker uses restrained Veslo styling: white surfaces, subtle borders, small radius, and the current product typography. It should feel like part of the session surface, not a marketing hero.

## Draft Conflict UX

When the user switches the target and the destination already has a pending draft while the current composer also has content, show a modal before changing the active draft.

The modal shows two side-by-side draft previews:

- Left: current composer text
- Right: existing draft text from the selected target

Actions are placed under the preview they affect:

- Under the current composer preview: `Použít aktuální text`
- Under the existing draft preview: `Načíst původní draft`

Cancel is not a footer button. It is a top-right `X` control with a visible `Esc zavře` hint. Pressing Escape should close the modal without changing the target or draft.

## State Model

Use the existing pending draft model:

- Private chat remains the existing `new-private` pending draft concept.
- Project/workspace drafts remain directory pending drafts keyed by workspace and normalized directory.
- The active empty composer surface is a view over one pending draft target at a time.

Switching target should not silently overwrite draft content. A conflict exists when:

- the current composer draft has meaningful content, and
- the destination target has a meaningful pending draft that differs from the current draft.

If only one side has meaningful content, switching can proceed without a modal:

- current-only content can become the destination draft if the destination is empty;
- destination-only content can load into the composer;
- no-content switching simply changes the active target.

## Error Handling

- If target activation fails, keep the current target and show the existing error/toast path.
- If loading a destination pending draft fails, keep the current target and report the restore error.
- If pending draft attachments cannot be restored, preserve the existing attachment restore warning behavior.
- If the user closes the modal with `X` or Escape, no target or draft mutation should happen.

## Testing

Prefer focused E2E coverage for the real Tauri runtime when implementing the workflow. Add lower-level tests only around pure decision logic so the conflict rules stay deterministic.

Recommended coverage:

- Empty pending session shows centered composer entry with target label and no quickstart prompt cards.
- Opening the target picker shows chat/workspace options and draft status badges.
- Switching to a target with an existing draft and a non-empty current composer opens the conflict modal.
- `Použít aktuální text` writes the current draft to the destination target.
- `Načíst původní draft` replaces the current composer with the destination draft.
- `X` and Escape close the conflict modal without mutation.

## Documentation

When implemented, update the session runtime feature docs because this changes the durable empty-session and pending-draft behavior users and future agents rely on.
