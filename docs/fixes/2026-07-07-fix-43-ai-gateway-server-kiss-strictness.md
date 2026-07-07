# Fix 43: Server Boundary TypeScript Strictness Rollup

Date: 2026-07-07

## Scope

This checkpoint records the small TypeScript strictness cleanup slices that were
done after the broader pre-send/auth pass.

Touched areas:

- `packages/server/src/server.ts`
- `packages/server/src/routes/admin.ts`
- `packages/server/src/routes/commands.ts`
- `packages/server/src/routes/scheduler.ts`
- `packages/server/src/routes/health.ts`
- `packages/server/src/routes/mcp.ts`
- `packages/server/src/routes/workspace-management.ts`
- `packages/server/src/routes/workspace-skills.ts`
- `packages/server/src/routes/skill-materialization.ts`
- `packages/server/src/skills.ts`
- `packages/server/src/skill-materializer.ts`
- `packages/server/src/skill-package-cache.ts`
- `packages/server/script/typecheck-skills-strict.mjs`
- `packages/server/package.json`

## What Changed

- AI gateway proxy DTOs now omit absent optional fields instead of passing
  explicit `undefined`.
- The AI gateway upstream `fetch` init is built without a `body` property when
  no request body exists.
- Admin token and approval routes now guard required route params before token
  revocation or approval response logic.
- Admin token creation omits the optional label payload when the label is absent
  or blank.
- Workspace command routes now guard required workspace and command route params
  before workspace resolution or command deletion.
- Command upsert payloads now omit absent optional fields.
- Scheduler routes now guard the required workspace route param before scheduler
  job logic.
- Health/status routes now guard the required workspace route param before
  workspace-scoped status and workspace-list responses.
- MCP workspace routes now guard the required workspace route param before
  MCP list, install, token refresh, add, remove, and auth-remove logic.
- Workspace management routes now guard the required workspace route param
  before workspace rename, activation, deletion, config, provisioning, audit,
  events, reload, export, and import logic.
- Workspace skill routes now guard the required workspace route param before
  skill list, resolve, hub install, read, file read, upsert, and delete logic.
- Workspace skill route DTOs now omit absent optional fields for list options,
  skill resolver tuning, hub repo overrides, upsert descriptions, and removal
  reasons.
- Skill and materialization internals now omit absent optional marker, registry,
  removal-journal, cache, and materializer fields instead of passing explicit
  `undefined`.
- Skill materialization workspace routes now guard the required workspace route
  param before status, user-global-store sync, and workspace sync logic.
- Added `pnpm --filter veslo-server typecheck:skills-strict`, an owner-scoped
  strict TypeScript check for skill/materialization files using
  `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.

## KISS Boundary

This intentionally avoids broad refactors. No server owners were extracted, no
shared route helper was introduced, and domain validation remains with the
existing domain functions such as `upsertCommand`, `deleteCommand`, and
scheduler job resolution.

The skill/materialization strict check is implemented as an owner-scoped runner
instead of a standalone `files` tsconfig because TypeScript still checks the
full imported graph for these flags. The runner keeps the business-owner signal
without making unrelated server owners fail this checkpoint.

## Business Logic Value

The strictness findings were useful where they touched boundary contracts:

- AI gateway auth/session/diagnostic DTOs should preserve the difference between
  an absent field and an explicit `undefined`.
- Route handlers should fail closed before passing absent route params into
  token, approval, workspace, command, scheduler, status, MCP, or workspace
  management and skill logic.
- Optional mutation payloads should only include fields that callers actually
  supplied.
- Skill materialization registry inputs should not blur "missing org/user/auth
  context" with "present but undefined" because those fields decide rollout and
  personal-global targeting.

This is a better fit for business logic than enabling stricter TypeScript flags
globally and fixing hundreds of lower-signal UI prop or test fixture findings.

## False Positive Evaluation

This rollup kept the high-signal findings and avoided the noisy parts:

- AI gateway exact-optional findings were in auth/session/runtime boundary
  payloads.
- Admin, command, and scheduler `noUncheckedIndexedAccess` findings were route
  param boundary gaps.
- Health/status `noUncheckedIndexedAccess` findings were workspace route-param
  boundary gaps.
- MCP `noUncheckedIndexedAccess` findings were workspace route-param boundary
  gaps; MCP name validation remains owned by the existing validators and domain
  functions.
- Workspace management `noUncheckedIndexedAccess` findings were all workspace
  route-param boundary gaps; workspace CRUD behavior remains unchanged.
- Workspace skill findings were split between route-param boundary gaps and
  exact-optional DTO construction; skill name/path validation remains owned by
  the existing skill functions.
- Skill/materialization exact-optional findings were in registry request
  inputs, internal materialization payloads, managed skill marker metadata,
  package-cache inputs, and removal-journal snapshots.
- `noPropertyAccessFromIndexSignature` was evaluated and rejected for now
  because it mainly created mechanical JSON/index/env access churn in this
  owner scope.
- Command/admin exact-optional findings were mutation DTO construction issues.
- Broader source and test findings remain outside this checkpoint.

## Future Direction

- Continue strictness one owner at a time rather than enabling global flags.
- Prefer route-boundary and app/server DTO slices before UI prop/test fixture
  cleanup.
- If repeated route guards keep appearing, consider a shared helper only after a
  few more route owners are cleaned.
- Next low-risk server candidates are plugin route param boundaries and other
  isolated server route owners with clear business checks.
- Keep sessionless fallback behavior explicit and covered by tests.

## Verification

Run on 2026-07-07:

```powershell
pnpm --filter veslo-server exec tsc -p tsconfig.json --noEmit --exactOptionalPropertyTypes --pretty false
# AI gateway/admin/commands/scheduler/health/MCP/workspace-management/workspace-skills matches: 0

pnpm --filter veslo-server exec tsc -p tsconfig.json --noEmit --noUncheckedIndexedAccess --pretty false
# admin/commands/scheduler/health/MCP/workspace-management/workspace-skills matches: 0

pnpm --filter veslo-server typecheck:skills-strict
# skills strict diagnostics: 0

pnpm --filter veslo-server typecheck
# exit 0

pnpm --filter veslo-server exec bun test src/tests/server.ai-gateway.test.ts src/tests/ai-gateway-runtime-owner.test.ts src/tests/server.ai-gateway-routes.test.ts
# pass 35, fail 0

pnpm --filter veslo-server exec bun test src/tests/server.admin-routes-registration.test.ts src/tests/tokens.test.ts
# pass 10, fail 0

pnpm --filter veslo-server exec bun test src/tests/server.commands-routes.test.ts src/tests/resource-owner.test.ts
# pass 4, fail 0

pnpm --filter veslo-server exec bun test src/tests/server.scheduler-routes.test.ts
# pass 1, fail 0

pnpm --filter veslo-server exec bun test src/tests/server.health-status-routes.test.ts
# pass 7, fail 0

pnpm --filter veslo-server exec bun test src/tests/server.mcp-routes.test.ts src/tests/mcp.remote-connect.e2e.test.ts src/tests/validators.test.ts
# pass 33, fail 0

pnpm --filter veslo-server exec bun test src/tests/server.workspace-management-routes.test.ts src/tests/server.workspaces-crud.test.ts
# pass 14, fail 0

pnpm --filter veslo-server exec bun test src/tests/server.workspace-skills-routes.test.ts src/tests/server.skill-materialization.test.ts src/server.skill-enabled-overrides.test.ts
# pass 43, fail 0

pnpm --filter veslo-server exec bun test src/tests/server.skill-materialization.test.ts src/tests/server.skill-materialization-routes.test.ts src/tests/skill-materializer.test.ts src/tests/skills.test.ts src/tests/skill-package-cache.test.ts src/tests/workspace-skill-set.test.ts src/tests/workspace-skill-lockfile.test.ts src/tests/server.workspace-skills-routes.test.ts src/server.skill-enabled-overrides.test.ts
# pass 75, fail 0

pnpm --filter veslo-server build:bin
# exit 0
```

## Status

The server boundary strictness rollup is complete. The former narrow follow-up
notes for admin, command, and scheduler routes were consolidated here to avoid
over-fragmenting `docs/fixes`.
