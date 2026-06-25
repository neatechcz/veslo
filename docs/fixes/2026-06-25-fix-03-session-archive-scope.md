# Fix 03: Session Archive Scope

## Problem

Archive records stored workspace metadata, but persistence deduplicated and deleted records by raw `sessionId`. If two workspaces had the same session id, archiving one could overwrite the other, and unarchiving one could remove the wrong archive entry.

## Fix

- Server archive storage now deduplicates by `workspaceIdAtArchive/workspaceIdentity + sessionId`.
- `DELETE /session-archives/:sessionId` accepts `workspaceId` as query scope. Without `workspaceId`, legacy callers keep the old delete-all-by-session behavior.
- App unarchive calls now pass `workspaceId` from sidebar and Settings archived rows.
- `SessionArchiveItem` now carries `workspaceId` so Settings can unarchive a specific workspace/session pair.
- Pending archive operations use the same scoped sidebar archive key.

## Files

- `packages/server/src/session-archives.ts`
- `packages/server/src/server.ts`
- `packages/server/src/tests/server-session-archives-mounted-route.test.ts`
- `packages/app/src/app/lib/veslo-server.ts`
- `packages/app/src/app/lib/session-archive-model.ts`
- `packages/app/src/app/types.ts`
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/pages/settings.tsx`
- `packages/app/src/app/pages/dashboard.tsx`
- `packages/app/src/app/tests/app-session-archives.test.ts`
- `packages/app/src/app/tests/lib/session-archive-model.test.ts`
- `packages/app/src/app/tests/lib/veslo-server.test.ts`

## Verification

```powershell
cd packages/app
node --test --import=tsx/esm src/app/tests/lib/session-archive-model.test.ts src/app/tests/lib/veslo-server.test.ts src/app/tests/app-session-archives.test.ts src/app/tests/pages/settings-archived-sessions.test.ts

cd ../..
bun test packages/server/src/tests/server-session-archives-mounted-route.test.ts
```

Result: pass.
