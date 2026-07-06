# Fix 35: App Server Workspace ID Fail-Closed Cleanup

Date: 2026-07-06

## Scope

Closed the app-side follow-up from the Veslo server access rollout where
frontend code could still manufacture a Veslo server workspace id from local UI
state or a server workspace list. E2E/pilot validation is intentionally skipped
for this checkpoint.

## Problem

Several app paths still had legacy workspace-id fallbacks after the server
identity and acknowledged-registration work:

- The active local Veslo workspace signal could fall back to app-local workspace
  ids or discover a remote workspace through `listWorkspaces`.
- Automation and Soul workspace maps could still map a local or remote app
  workspace to a server workspace through path/directory matching.
- Attachment staging could choose a server workspace from path matching,
  `activeId`, or a singleton server workspace list.
- Workspace sharing and debug/audit paths could still use app-side lookup
  logic instead of an acknowledged server mapping.

These paths could hide a missing `vesloWorkspaceId` mapping and route
server-bound calls to the wrong workspace.

## Fix

- Local app workspaces now publish a Veslo server workspace id only from the
  acknowledged `vesloWorkspaceId` mapping.
- Remote Veslo app workspaces use explicit stored or URL-mounted workspace ids,
  validated against the connected server where a list is available.
- Automation, Soul, attachment staging, workspace share, MCP/plugin, and
  managed-AI paths no longer adopt a workspace by path/directory match,
  `activeId`, or "first listed workspace" fallback.
- Devtools/audit loading no longer has a separate workspace-id resolver; it
  uses the same `vesloServerWorkspaceId` signal as normal app paths.
- Regression tests now assert that unmapped local workspaces fail closed instead
  of treating app workspace ids or list-derived ids as server-owned ids.

## Scope Boundaries

This does not change the server's deterministic local workspace id algorithm or
the desktop/orchestrator dual-id migration. It only removes frontend inference
paths that could bypass the acknowledged mapping contract.

Remote connect still may select a workspace from a remote server's workspace
list when the user is explicitly connecting to that remote host; that is outside
the local desktop server-access contract covered here.

## Verification

Run on 2026-07-06:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/app-managed-ai-config-sync-contract.test.ts src/app/tests/context/extensions-plugin-policy.test.ts src/app/tests/context/mcp-connection-workflow.test.ts src/app/pages/scheduled-automations.test.ts src/app/tests/components/session/composer-docx-delegation.test.ts src/app/tests/components/session/composer-screenshot-staging-regression.test.ts src/app/tests/pages/scheduled-automation-store.test.ts src/app/tests/pages/session-attachment-staging.test.ts src/app/tests/pages/workspace-share-controller.test.ts src/app/tests/pages/soul-data-store.test.ts src/app/tests/lib/automation-workspace-map.test.ts src/app/tests/lib/soul-workspace-map.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

Results:

- App server-workspace-id regression bundle: `95` passed.
- App typecheck passed.
- `git diff --check` passed with LF/CRLF warnings only.

## Status

Implementation is complete for this codebase-only fail-closed cleanup slice. No
installed-runtime E2E or tauri-pilot validation was run.
