# Archived Sessions Settings Design

## Summary

Veslo should expose a global `Archived sessions` list in `Settings` with the ability to unarchive sessions.

Archived-session state must be synced through the hosted Veslo cloud deployment on Render. Local desktop state may cache or render that data, but it must not be the source of truth.

When a user unarchives a session, Veslo should return it to the same workspace/project bucket it belonged to at archive time, then let the normal session sorting rules take over.

## Goals

- Add a dedicated `Archived sessions` surface to `Settings`.
- Sync archived-session state across devices through the hosted Veslo server on Render.
- Preserve the session's effective Veslo location when it is archived, including sessions moved via `Choose folder`.
- Allow unarchiving even when the backing workspace is unavailable on the current device.
- Keep the sidebar and settings UI consistent with one archive source of truth.

## Non-Goals

- Turning archive into an OpenCode session-native server state.
- Reordering unarchived sessions to their exact prior visual row position.
- Auto-archiving or auto-unarchiving subagent trees as one unit.
- Solving general cloud continuation for local workspaces.

## Product Decisions

- `Settings > Archived sessions` shows archived sessions from all workspaces combined.
- Ordering is `archivedAt desc`, newest archive first.
- `Unarchive` returns the session to its original workspace/project bucket and then uses the normal Veslo session ordering for that bucket.
- If the backing workspace is unavailable on the current device, the session is still visible in settings and still unarchivable, but it must be labeled as unavailable on this device.

## Source Of Truth

The archive registry must live in the hosted Veslo cloud surface on Render.

This means:

- the desktop app is a consumer of archive state, not the owner
- local `localStorage` archive IDs are legacy data only
- workspace config files are not the right persistence layer because archive state is per-user, not per-workspace
- local self-hosted Veslo server behavior should mirror the same API shape, but the production source of truth is the hosted Render deployment

## Data Model

Archive state is a Veslo-managed per-user session UI record, not an OpenCode session mutation.

Each archive record should contain at least:

- `sessionId`
- `archivedAt`
- `titleSnapshot`
- `workspaceIdAtArchive`
- `workspaceLabelSnapshot`
- `resolvedDirectoryAtArchive`
- `projectRootAtArchive`
- `projectLabelSnapshot`
- `parentSessionId`
- `createdAtSnapshot`
- `updatedAtSnapshot`
- `workspaceIdentity`

`workspaceIdentity` exists because current local `workspaceId` values are path-derived and are not stable across devices. It should represent the best stable identity available for the archived session location:

- remote workspace: hosted workspace identity such as `vesloHostUrl + vesloWorkspaceId`, with a fallback to `baseUrl + directory`
- local workspace: the resolved project root/directory snapshot used for bucket matching on the current device

## Hosted API Surface

The hosted Veslo server should expose a global archive registry surface, independent of any one workspace route.

Recommended shape:

- `GET /session-archives`
- `PUT /session-archives/:sessionId`
- `DELETE /session-archives/:sessionId`

Behavior:

- `GET` returns the current user's archived sessions, already sorted by `archivedAt desc`
- `PUT` archives or refreshes the record for one session using the client-provided Veslo location snapshot
- `DELETE` unarchives one session by removing the archive record

The server-side owner key must map to the signed-in cloud account, not to workspace ID and not to a client token hash. The current repo does not yet show a general-purpose per-user cloud identity contract in `packages/server`, so implementation must make that prerequisite explicit instead of assuming it already exists.

## UI And Behavior

### Settings

`Settings` gets a dedicated `Archived sessions` section that lists archived sessions across all workspaces.

Each row should show:

- session title
- workspace label
- project label or archived directory snapshot
- archived time
- current device availability state
- `Unarchive` action

If the session is not available on this device, the row still renders and `Unarchive` remains enabled, but the UI must show a clear note such as `Not available on this device`.

### Sidebar

The existing archive action in the session list remains, but it must call the hosted archive API instead of writing archive IDs to `localStorage`.

The current `Show archived` toggle can remain only as a local display preference. It may control whether cloud-archived sessions are temporarily visible in the sidebar, but it must not decide whether a session is archived.

## Returning Sessions To The Right Bucket

When the user unarchives a session, Veslo should place it back into the same workspace/project bucket it belonged to when it was archived.

Important rule:

- use the Veslo-resolved session location, including `sessionDirectoryOverrideById`, not just the raw OpenCode `session.directory`

This is required because `Choose folder` can move a session to a new effective workspace while the raw OpenCode session record may still point at the original private workspace path.

Implementation rule:

- archive writes must snapshot the resolved location at archive time
- unarchive reads should prefer live session resolution when available
- archive snapshots act as the fallback for bucket restoration and settings display

## Availability On This Device

Client availability should not be derived from `workspaceId` alone.

The app should determine `availableOnThisDevice` by comparing the archive record's `workspaceIdentity` and archived resolved directory against the currently known local/remote workspaces on the device.

If there is no match:

- keep the row visible in settings
- show `Not available on this device`
- keep `Unarchive` enabled
- remove the archive record when the user unarchives
- do not pretend the session is locally continuable

## Migration From Local Storage

The app currently stores archive IDs in local storage:

- `veslo.sidebar-archived-session-ids.v1`

That store should be treated as legacy import data only.

Migration plan:

1. On first successful load of the cloud archive registry, read the legacy local archive IDs.
2. If cloud archive data for the user is empty, upload migrated records best-effort.
3. Because legacy local data has no real `archivedAt`, preserve order by assigning synthetic timestamps from the stored order.
4. After successful migration, clear the legacy local archive IDs.

The local `show archived` display preference may remain because it is not part of the synced archive source of truth.

## Error Handling

- If archive or unarchive fails, the initiating control should show a short pending state and then revert with a toast on failure.
- If a session no longer exists, the archive record may remain visible in settings as a stale row. The user should still be able to remove it from the archive registry.
- If session metadata changed on another device, prefer live data when the session can be resolved locally; otherwise render the archived snapshot.
- Archive and unarchive writes should be idempotent.

## Edge Cases

- Sessions moved with `Choose folder` must archive against their resolved directory, not the stale engine directory.
- Child/subagent sessions should continue to archive independently by session ID unless a later design explicitly introduces tree semantics.
- Simultaneous archive/unarchive from multiple devices uses last-write-wins semantics.
- A session unarchived on a device without the backing workspace remains non-continuable there until the workspace becomes available.

## Testing Requirements

Required verification after implementation:

- server unit tests for archive record normalization, persistence, sorting, idempotent writes, and delete behavior
- app tests for bootstrapping archive state from the hosted registry
- sidebar tests proving archive actions no longer depend on local archive ID storage
- settings tests for the global archived list, ordering by `archivedAt`, and unavailable-on-this-device labeling
- migration tests from legacy local archive IDs to hosted archive records
- moved-session tests proving archive snapshots use the resolved session directory
- desktop runtime verification using the required Tauri + WebDriver flow

## Implementation Prerequisite

Before implementation begins, the engineer must explicitly resolve how the hosted Render deployment derives a stable per-user archive owner key.

The current repo shows:

- desktop Den auth state in the app
- bearer-token client auth in the Veslo server
- no obvious general-purpose per-user cloud archive ownership layer in `packages/server`

Do not silently assume this exists. Make the chosen owner-key contract explicit in code and tests before building the archive registry on top of it.
