# Fix 36: Server-Owned Legacy Fallback Hardening

Date: 2026-07-07

## Scope

Closed the codebase-only follow-up from the app fallback audit after the Veslo
server-access and server-owned composer submit rollout. Installed-runtime E2E
and tauri-pilot validation are intentionally skipped for this checkpoint.

## Problem

Several adjacent app/server paths could still preserve legacy assumptions even
after the primary server-owned submit path was implemented:

- Attachment staging could fall back to the global cached Veslo server
  workspace id when the active workspace did not carry an acknowledged mapping.
- Existing-session and first-session local submit could fall through to the
  legacy app run path when the server submit adapter returned no typed result.
- Server run/abort resolution still accepted raw OpenCode session ids without a
  conversation binding.
- Remote Veslo activation could reuse a global settings token for a different
  host and persist inherited credentials into the workspace record.
- Abort and SSE paths could still use global or scoped legacy SDK clients when
  the server-owned route was unavailable.
- Runtime readiness could still be marked ready from the active legacy
  `engineReady` signal without a routed workspace client or orchestrator-ready
  snapshot.

## Fix

- Attachment staging now resolves write targets only from active remote identity
  or the acknowledged local `vesloWorkspaceId`, validated against the connected
  server list. The global cached workspace id is no longer a write fallback.
- Local server-owned submit fails closed when existing-session submit returns no
  result or first-session materialization does not produce a `submitted` or
  `queued` result. Those paths no longer run the legacy app submit fallback.
- Server conversation run and abort endpoints now require a conversation binding
  before contacting the engine, including for raw `sess-*` OpenCode ids.
- Remote Veslo activation uses the settings token only when the configured host
  exactly matches the workspace host, clears stale global credentials on host
  switch, and does not persist inherited fallback tokens into the workspace.
- `abortSession` now reports server abort unavailability as a blocked state
  instead of calling scoped or active OpenCode SDK abort fallbacks.
- Session SSE targets are built only from routed workspace entries. The event
  stream no longer opens a global active-client fallback stream or refreshes
  idle sessions through that global client.
- `runtime-owner` keeps legacy `engineReady` only as diagnostics; it no longer
  contributes to workspace runtime readiness.

## Verification

Run on 2026-07-07:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-attachment-staging.test.ts src/app/tests/app-attachment-workspace-readiness.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/context/workspace-activation-remote-source.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/pages/session-mutation-workflow.test.ts src/app/tests/lib/veslo-server.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/app-conversation-abort.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-boot-engine-ready.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/context/runtime-owner.test.ts
pnpm --filter veslo-server exec bun test src/tests/conversation-submit-service.test.ts src/tests/server-conversations.test.ts
```

Results:

- App attachment/send/remote activation bundle: `30` passed.
- App conversation-service/mutation/client bundle: `85` passed.
- App send/abort bundle: `27` passed.
- App boot/SSE/runtime-owner bundle: `27` passed.
- Server submit/conversation routes: `38` passed.

## Status

Implementation is complete for this codebase-only hardening slice. No
installed-runtime E2E or tauri-pilot validation was run.
