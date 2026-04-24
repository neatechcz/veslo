# Pending Session Drafts Design

## Summary

Veslo should stop creating visible sidebar sessions before the user actually starts a run.

`New session` and project-level `+` should open a durable pending draft instead of immediately creating an OpenCode session. The draft must preserve typed text, structured composer parts, and copied attachment content across navigation changes and full app restarts. A real session should be created only when the user presses `Run`.

## Goals

- Keep the left sidebar free of unstarted sessions.
- Preserve draft text and attachments when the user switches between sessions, workers, and app launches.
- Reuse the existing private-worker creation behavior for `New session` on the first open.
- Reuse an existing pending draft when the same entry point is opened again.
- Keep session creation and attachment staging behavior correct once the user actually sends the draft.

## Non-Goals

- Redesigning the composer UI or introducing a new visible draft-management UI.
- Syncing pending drafts between devices.
- Changing the underlying OpenCode session model.
- Reworking worker creation flows beyond what is needed to stop duplicate private workers for repeated `New session` clicks.

## User Model

User-facing concepts:

- `Session`: a real started conversation that appears in the sidebar.
- `Draft`: unpublished work in the composer that is not yet a session.
- `New session`: a shortcut back to the one pending private-session draft.
- `Project draft`: a pending draft tied to one concrete folder/project entry.

Internal concepts:

- `Pending draft`: persisted local record with metadata, composer payload, and copied attachments.
- `Draft target`: either the special `new-private` target or a concrete directory target.

## Core Rules

### New session

`New session` must have exactly one pending draft across the whole app.

Behavior:

1. On the first click, Veslo may keep the current behavior of creating a private worker immediately.
2. Veslo persists a pending draft that points at that private worker/workspace.
3. Additional clicks on `New session` must reopen the same pending draft.
4. Additional clicks must not create another private worker while the pending draft still exists.
5. Once the draft is successfully sent, the pending draft is deleted. The next `New session` click can then create a fresh private worker and a fresh pending draft.

### Project `+`

Each concrete project/directory target must have at most one pending draft.

Behavior:

1. Clicking `+` on project A opens or creates the pending draft for project A.
2. Clicking `+` on project B opens or creates the pending draft for project B.
3. Returning to project A must reopen the existing project-A draft with its text and attachments intact.
4. Project pending drafts must not appear in the sidebar until they are sent.

### Sidebar visibility

- Pending drafts are never rendered as sidebar sessions.
- Only real started OpenCode sessions appear in the sidebar.
- A pending draft can exist even when the current route is `/session` with no selected session id.

## Storage Model

Pending drafts should be stored in desktop app data rather than browser storage.

Recommended shape:

- metadata root:
  - `app_data/pending-session-drafts/index.json`
- per-draft directory:
  - `app_data/pending-session-drafts/<draft-id>/draft.json`
  - `app_data/pending-session-drafts/<draft-id>/attachments/<attachment-id>`

Each draft record should store:

- stable draft id
- draft kind: `new-private` or `directory`
- target workspace id
- target directory or project root when relevant
- private workspace id for `new-private`
- composer payload:
  - mode
  - parts
  - text
  - resolved text
  - copied attachment metadata
- timestamps:
  - created at
  - updated at

Each attachment copy should store:

- attachment id
- file name
- mime type
- size
- kind
- persisted binary payload

App restart should reconstruct the composer attachment chips from the stored copies rather than from the original source files.

## Routing And Selection Model

The current `selectedSessionId = null` route state already represents a draft-ready empty session surface. That behavior should stay, but the composer source must stop being keyed only by `selectedSessionId`.

Recommended model:

- real sessions keep using their session id as the composer key
- pending drafts use a separate active pending-draft key
- `/session` remains the route for both:
  - no pending draft selected yet
  - a pending draft is active
- `/session/<id>` remains reserved for real sessions only

This keeps route semantics simple and avoids inventing visible fake session ids.

## Interaction Flows

### Flow 1: First `New session`

1. User clicks `New session`.
2. Veslo checks whether a `new-private` pending draft already exists.
3. If none exists:
   - create the private worker/workspace using the current flow
   - persist the pending draft for that worker
4. Open `/session` with that pending draft active.
5. Do not create an OpenCode session.

### Flow 2: Repeated `New session`

1. User clicks `New session` again later.
2. Veslo finds the existing `new-private` pending draft.
3. Veslo activates its saved worker/workspace if needed.
4. Veslo opens the same draft.
5. No new private worker is created.

### Flow 3: Project `+`

1. User clicks `+` on a concrete project.
2. Veslo resolves a stable target key from the workspace id plus normalized directory root.
3. Veslo opens the existing pending draft for that target, or creates a new one if needed.
4. Veslo navigates to `/session`.
5. No OpenCode session is created yet.

### Flow 4: Switching away and back

1. User types into a pending draft and adds attachments.
2. User opens another session, another worker, or another project draft.
3. The active pending draft is flushed to durable storage.
4. Reopening the same entry point restores the draft text, parts, and attachment chips.

### Flow 5: Restart

1. User closes the app with pending drafts still present.
2. On next launch, Veslo reloads the pending-draft index from app data.
3. Reopening `New session` or the relevant project `+` restores the same draft.

### Flow 6: Send

1. User presses `Run` from a pending draft.
2. Veslo creates the real OpenCode session in the resolved target directory.
3. Veslo stages the persisted attachment copies into the session directory.
4. Veslo sends the composed prompt.
5. On success:
   - navigate to `/session/<real-session-id>`
   - delete the pending draft metadata and copied attachments
6. The new real session appears in the sidebar through the existing session-loading flow.

## Attachment Handling

Pending drafts must own copied attachment content.

Rules:

- Attachment persistence must not depend on the original source file path staying valid.
- Screenshot, drag-drop, and pasted file flows must all end up with the same persisted attachment-copy behavior.
- Restored attachments should continue to render the existing chips and image previews.
- Existing send-time model routing stays in place; the only change is that the input attachment source now comes from persisted draft copies.

## Error Handling

- If creating the first private worker for `New session` fails, show a clear retryable error and do not persist a half-created draft.
- If pending-draft persistence fails, do not silently fall back to volatile-only behavior.
- If loading a pending draft finds a missing or corrupt attachment copy:
  - keep the draft text
  - drop only the broken attachment
  - show a clear non-fatal error/toast
- If real session creation fails during `Run`, keep the pending draft and its attachments intact.
- If send succeeds but cleanup of draft files fails, keep the real session and schedule best-effort cleanup rather than reporting the run as failed.

## Documentation Updates Required

If implemented, the canonical docs should be updated to reflect:

- pending drafts are durable local UI/runtime state
- unstarted drafts do not appear as sessions in the sidebar
- `New session` reopens an existing unpublished private draft until it is sent or discarded

Relevant docs:

- `docs/features/session-runtime.md`
- `docs/dev/state-and-config-reference.md`

## Testing Requirements

Required verification after implementation:

- first `New session` creates one private worker and one pending draft
- repeated `New session` clicks reopen the same draft without creating another worker
- project `+` creates one pending draft per concrete target directory
- switching between drafts preserves text and copied attachments
- restarting the app preserves pending draft text and copied attachments
- sending from a pending draft creates the real session only at send time
- real sessions appear in the sidebar only after send
- failed sends keep the pending draft intact
- corrupted attachment-copy restoration degrades gracefully

## Open Questions Deferred

These are intentionally out of scope for this change:

- whether the UI should expose an explicit `Discard draft` action
- whether stale pending drafts should be auto-cleaned after long inactivity
- whether future cloud-backed pending drafts should exist
