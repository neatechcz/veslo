# Fix 02: Sidebar Session Scope

## Problem

Sidebar hierarchy code keyed rows by raw `session.id`. Two workspaces can legitimately contain the same engine session id, so recent/project sidebar rows could be dropped, overwritten, or nested under the wrong parent.

## Fix

- Added row-level identity based on `workspaceId:sessionId`.
- Kept legacy session-id lookup fields for existing call sites, but made hierarchy, expansion, descendant lookup, and project grouping use row keys.
- Updated sidebar expansion state to write `row.rowKey` while still accepting old raw session ids as a read fallback.
- Hardened direct child lookup for animated branch slices where the parent row is not present in the slice.
- Added regression coverage for duplicate session ids and duplicate parent ids across workspaces.

## Files

- `packages/app/src/app/components/session/workspace-session-list-model.ts`
- `packages/app/src/app/components/session/workspace-session-list.tsx`
- `packages/app/src/app/tests/components/session/workspace-session-list-model.test.ts`
- `packages/app/src/app/tests/components/session/workspace-session-list-interactions.test.ts`

## Verification

```powershell
cd packages/app
node --test --import=tsx/esm src/app/tests/components/session/workspace-session-list-model.test.ts src/app/tests/components/session/workspace-session-list-interactions.test.ts
```

Result: pass.
