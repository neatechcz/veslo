# Fix 11: UI/Server Contract Route Owner Extraction Complete

## Problem

Fix 10 captured the UI/server contract work as a checkpoint, but the implementation plan still had open items:

- remaining server route adapters for skills materialization, workspace skills, Soul, health/status, workspace management, and admin approval routes
- incomplete `createVesloServerClient` domain composition
- no finalized aggregate read-model policy
- working-rule checklist items still marked incomplete in the implementation plan

That meant `docs/fixes` still described the effort as unfinished even after the route extraction and client facade work were completed.

## Fix

- Completed the remaining route adapter extraction from `packages/server/src/server.ts`.
- Added server route adapters for:
  - `routes/skill-materialization.ts`
  - `routes/workspace-skills.ts`
  - `routes/soul.ts`
  - `routes/health.ts`
  - `routes/workspace-management.ts`
  - `routes/admin.ts`
- Added route registration tests for the new adapters.
- Completed `createVesloServerClient` domain composition:
  - `client.skills`
  - `client.soul`
  - `client.workspace`
  - `client.conversations`
  - `client.files`
  - read-only `client.extensionsInventory`
- Completed the frontend client modularization around that composition:
  - `packages/app/src/app/lib/veslo-server.ts` is now the public barrel only
  - `packages/app/src/app/lib/veslo-server/client.ts` owns `createVesloServerClient`, AI access helpers, and flat compatibility aliases
  - `packages/app/src/app/lib/veslo-server/types.ts`, `connection.ts`, and `transport.ts` own shared types, connection helpers, and transport/error handling
- Kept legacy flat client methods as compatibility wrappers delegating into the domain facades from the client composition shell.
- Added read-only aggregate policy:
  - no new server aggregate endpoint was added in this checkpoint
  - `extensionsInventory` is a client-side read model over MCP, plugins, skills, and commands
  - mutations remain in the original domain facades
- Updated `docs/plans/2026-06-26-server-route-owner-extraction-implementation-plan.md` so every implementation/checklist item is complete.

## Review Hardening

Follow-up review fixes closed the remaining P1/P2 risks without changing the route extraction shape:

- Removed the client bearer token from unauthenticated `/health` and `/w/:id/health` responses.
- Kept desktop live-state recovery compatible with legacy health payloads, while current dev fallback reads auth only from explicit env (`VESLO_DEV_SERVER_TOKEN` or `VESLO_TOKEN`) instead of public health JSON.
- Added a shared app client `workspacePath()` helper so workspace IDs are encoded consistently as URL path segments.
- Updated app contract tests to lock encoded workspace ID URLs.
- Strengthened extracted server route registration tests to assert route order and `auth` mode, not only route existence.
- Marked required new route/client files with intent-to-add so `git diff` includes them for handoff.

## Files

- `docs/plans/2026-06-26-server-route-owner-extraction-implementation-plan.md`
- `packages/server/src/server.ts`
- `packages/server/src/routes/admin.ts`
- `packages/server/src/routes/health.ts`
- `packages/server/src/routes/skill-materialization.ts`
- `packages/server/src/routes/soul.ts`
- `packages/server/src/routes/workspace-management.ts`
- `packages/server/src/routes/workspace-skills.ts`
- `packages/server/src/tests/server.admin-routes-registration.test.ts`
- `packages/server/src/tests/server.health-status-routes.test.ts`
- `packages/server/src/tests/server.skill-materialization-routes.test.ts`
- `packages/server/src/tests/server.soul-routes-registration.test.ts`
- `packages/server/src/tests/server.workspace-management-routes.test.ts`
- `packages/server/src/tests/server.workspace-skills-routes.test.ts`
- `packages/app/src/app/lib/veslo-server.ts`
- `packages/app/src/app/lib/veslo-server/client.ts`
- `packages/app/src/app/lib/veslo-server/connection.ts`
- `packages/app/src/app/lib/veslo-server/transport.ts`
- `packages/app/src/app/lib/veslo-server/types.ts`
- `packages/app/src/app/lib/veslo-server-domains/conversations.ts`
- `packages/app/src/app/lib/veslo-server-domains/extensions-inventory.ts`
- `packages/app/src/app/lib/veslo-server-domains/files.ts`
- `packages/app/src/app/lib/veslo-server-domains/path.ts`
- `packages/app/src/app/lib/veslo-server-domains/skills.ts`
- `packages/app/src/app/lib/veslo-server-domains/soul.ts`
- `packages/app/src/app/lib/veslo-server-domains/workspace.ts`
- `packages/app/src/app/tests/lib/veslo-server.test.ts`
- `packages/app/src/app/tests/lib/veslo-server-modularization.test.ts`
- `packages/desktop/src-tauri/src/commands/veslo_server.rs`
- `packages/desktop/src-tauri/src/veslo_server/mod.rs`

## Verification

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server-route-manifest-contract.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server-modularization.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin
pnpm --filter veslo-server exec bun test src
git diff --check
```

Additional review-hardening verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-route-manifest-contract.test.ts src/app/tests/lib/veslo-server-modularization.test.ts
pnpm --filter veslo-server exec bun test src/tests/server.bridge-listener.test.ts src/tests/server.health-status-routes.test.ts src/tests/server.admin-routes-registration.test.ts src/tests/server.skill-materialization-routes.test.ts src/tests/server.workspace-management-routes.test.ts src/tests/server.workspace-skills-routes.test.ts src/tests/server.soul-routes-registration.test.ts src/tests/server.conversation-session-routes.test.ts src/tests/server.skill-registry-routes.test.ts src/tests/server.skill-removal-routes.test.ts src/tests/server.user-global-skills-routes.test.ts src/tests/server.skill-enabled-routes.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server typecheck
cargo test sanitize_live_info
cargo test read_persisted_server_info
```

Result:

- app client/domain tests passed
- app route-manifest and modularization tests passed
- app typecheck passed
- server typecheck passed
- server binary rebuild passed
- full server suite passed: `733 pass`, `9 skip`, `0 fail`
- `git diff --check` passed with only Windows LF -> CRLF warnings
- review-hardening app, server, and Rust targeted tests passed
- `cargo fmt --check` still reports an existing formatting diff in `packages/desktop/src-tauri/src/runtime_preferences.rs`; this review fix did not modify that file

## Status

The implementation plan is complete. The only remaining `done: false` text in the plan is the glossary line explaining what that status would mean; it is not an open task.
