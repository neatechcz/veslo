# Global Unpublished Chat Draft Design

Date: 2026-06-28

## Goal

Replace per-workspace unpublished chat drafts with one application-wide unpublished draft. The change applies only before the first message creates a real conversation. Existing real conversations keep their own composer draft behavior.

## Decisions

- Keep one global unpublished draft body for the whole application.
- Use the selected target as metadata on that global draft: private chat, workspace id, and normalized directory.
- Keep desktop-backed pending-draft persistence so the one draft survives restart with text and attachment chips.
- Do not migrate old per-workspace pending drafts. New behavior starts from an empty global draft when no valid global draft exists.
- Preserve the current first-send behavior after the user posts the draft.

## Architecture

Unpublished chats are modeled as one active pending draft. `Chat`, project `+`, and the composer target picker all open the same draft body. Switching targets changes where that draft will be posted, not which text bucket is loaded.

Real conversations remain separate. Once a draft is sent and a real conversation exists, the session keeps the existing per-session composer behavior.

The desktop pending-draft store remains the durable home for the unpublished draft payload and attachment copies, but it no longer represents multiple project draft buckets. Old per-workspace pending drafts are treated as obsolete and must not appear in the target picker or resurrect on restart.

## Data Flow

Typing in an unpublished chat writes to one fixed global pending-draft storage key.

When the user selects `Chat`, project `+`, or another workspace target, Veslo keeps the same draft text and attachments and records the intended send destination.

On send, Veslo snapshots both the global draft and the selected destination. It then uses the existing first-send materialization path to create the real conversation in that destination. After a successful handoff, Veslo clears the global pending draft. If handoff fails, the draft and selected destination remain available for retry.

Post-send behavior should stay the same as it is today. The intended behavior change is only that other unpublished workspace drafts are no longer saved or restored.

## Error Handling And Cleanup

If the global pending draft cannot be loaded from desktop storage, Veslo clears the stale pending state and opens an empty unpublished draft.

If attachment restore partially fails, Veslo keeps the current warning behavior and restores the draft without the failed attachments.

Old per-workspace pending drafts are not migrated. The implementation can ignore them on read and may delete them as cleanup, but they must not affect user-visible draft selection.

If switching the selected destination fails because the workspace cannot be registered or activated, Veslo keeps the global draft content and shows the existing target-unavailable style error.

## Testing

Primary coverage must include a real desktop E2E UI scenario using `tauri-pilot`:

1. Open an unpublished chat.
2. Type a draft message.
3. Switch the unpublished target to a project workspace.
4. Verify the same draft text remains visible.
5. Send the draft.
6. Verify a real conversation is created in the selected project using the existing first-send behavior.
7. Start another unpublished chat and verify no old project-specific draft is restored.

Focused app tests should support the E2E path by proving:

- unpublished pending draft keys resolve to one global identity
- target switching no longer creates or restores separate workspace draft bodies
- old per-workspace pending drafts are ignored
- existing real-session composer drafts remain separate
- failed send preserves the global draft and selected destination

## Non-Goals

- Do not remove per-session composer drafts for existing real conversations.
- Do not migrate old workspace-specific pending draft content.
- Do not change Veslo server conversation binding or workspace runtime ownership.
- Do not use browser-only runtime verification as proof of the desktop behavior.
