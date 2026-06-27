---
title: Veslo Server Frontend Client Modularization Plan
date: 2026-06-27
target: packages/app/src/app/lib/veslo-server.ts
done: true
---

# Veslo Server Frontend Client Modularization Plan

## Goal

Modularize `packages/app/src/app/lib/veslo-server.ts` without creating a cloud of tiny files.
The public import path `../lib/veslo-server` must remain compatible for existing callers.

The final `done: true` value is allowed only after all phases below have their own `done: true`
and the verification commands pass.

## Non-Goals

- Do not rename public client methods.
- Do not force existing consumers to import from internal modules.
- Do not create one module per endpoint.
- Do not mix behavior changes into extraction-only phases.
- Do not move server-side code from `packages/server` as part of this plan.

## Module Size Rule

Create a module only when it owns a durable domain boundary:

- connection/settings/deep links
- transport/error/request handling
- workspaces/config/reload/audit
- conversations/session runs/transcripts
- files/inbox/artifacts
- skills/local store/removals/materialization
- skill registry
- soul
- AI access

Avoid modules with fewer than roughly 100 lines unless they are shared infrastructure.
Prefer a larger coherent domain file over many endpoint-sized files.

## Test-First Rule

Before extracting each module:

1. Add or update the test that captures the expected public behavior or route contract.
2. Run the focused test and record the current result.
3. Extract the module.
4. Run the same focused test again.
5. Run the broader verification set for the phase.
6. Only then change that phase from `done: false` to `done: true`.

If a phase is purely mechanical and an existing test already covers it, the agent must name that
existing test in the phase notes before implementation.

## Verification Commands

Focused checks:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server-route-manifest-contract.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server-session-prefetch.test.ts
```

Phase completion check:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-route-manifest-contract.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts src/app/tests/lib/veslo-server-modularization.test.ts
```

## Phase 1: Public Types Extraction

done: true

Target module:

- `packages/app/src/app/lib/veslo-server/types.ts`

Scope:

- Move public `Veslo*` DTO, input, result, and response types out of `veslo-server.ts`.
- Keep `veslo-server.ts` as the public re-export surface.
- Update existing `lib/veslo-server-domains/*` modules to import types from `../veslo-server/types` instead of the public barrel, where that avoids circular dependency risk.

Test first:

- Existing coverage: `src/app/tests/lib/veslo-server.test.ts` and `src/app/tests/lib/veslo-server-route-manifest-contract.test.ts`.
- Add a small type/export smoke test only if typecheck does not catch a broken public export.

Completion criteria:

- Existing imports from `../../lib/veslo-server.js` still work.
- Domain modules do not import types from the barrel when a direct type module import is available.
- Focused tests and typecheck pass.

## Phase 2: Connection and Deep-Link Helpers

done: true

Target module:

- `packages/app/src/app/lib/veslo-server/connection.ts`

Scope:

- Move server URL normalization.
- Move local server URL derivation.
- Move archive owner selection.
- Move invite and bundle URL build/read/strip helpers.
- Move browser storage settings helpers.

Test first:

- Extend `src/app/tests/lib/veslo-server.test.ts` around:
  - `buildVesloConnectInviteUrl`
  - `buildVesloBundleInviteUrl`
  - `deriveLocalVesloServerUrlFromOpencodeBaseUrl`
  - `resolveSessionArchiveClientOptions`
  - settings read/write/hydration behavior if touched

Completion criteria:

- No behavior changes to URL output or storage keys.
- `veslo-server.ts` re-exports the same public helper names.
- Focused tests and typecheck pass.

## Phase 3: Transport and Error Handling

done: true

Target module:

- `packages/app/src/app/lib/veslo-server/transport.ts`

Scope:

- Move `VesloServerError`.
- Move request helpers:
  - JSON
  - raw JSON
  - multipart
  - binary
- Move auth header and Den context header helpers when they are transport-level.
- Keep Tauri fetch audit behavior unchanged.

Test first:

- Extend `src/app/tests/lib/veslo-server.test.ts` for at least:
  - non-2xx error shape
  - bearer token handling
  - host token handling
  - timeout path if currently covered or practical to cover

Completion criteria:

- Client domain modules use shared transport context.
- Existing error instances still satisfy `error instanceof VesloServerError`.
- Focused tests and typecheck pass.

## Phase 4: Client Composition Shell

done: true

Target module:

- `packages/app/src/app/lib/veslo-server/client.ts`

Scope:

- Move `createVesloServerClient` out of the public barrel.
- Keep the initial method body mostly intact unless a method already belongs to an existing domain facade.
- Preserve both nested facades and flat aliases:
  - `client.plugins.list`
  - `client.listPlugins`
  - equivalent patterns for MCP, commands, automations, identities

Test first:

- Existing coverage: `src/app/tests/lib/veslo-server-route-manifest-contract.test.ts`.
- Add coverage only if a public alias is not represented in existing tests.

Completion criteria:

- `veslo-server.ts` becomes a barrel plus re-exports.
- Existing consumers do not change.
- Focused tests and typecheck pass.

## Phase 5: Workspaces Domain

done: true

Target module:

- `packages/app/src/app/lib/veslo-server-domains/workspace.ts`

Scope:

- health
- status
- capabilities
- workspace list/add/activate/delete/update
- config get/patch
- reload events and engine reload
- audit
- export/import
- workspace system provisioning
- scheduled jobs, if they are not better grouped with automations

Test first:

- Add or extend a route manifest test for workspace/config/reload/export/import requests.
- Use server route source as the contract where practical.

Completion criteria:

- `client.ts` composes a workspaces facade.
- Existing flat methods still call into the facade.
- Focused tests and typecheck pass.

## Phase 6: Conversations Domain

done: true

Target module:

- `packages/app/src/app/lib/veslo-server-domains/conversations.ts`

Scope:

- session archives
- conversation list/create/import
- conversation run/abort
- session latest run artifacts
- transcript prefetch/get/append
- session deletion if it remains tied to conversation/session behavior

Test first:

- Extend `src/app/tests/lib/veslo-server-session-prefetch.test.ts` and route manifest coverage before extraction.

Completion criteria:

- No route/path/query changes for transcript and conversation run calls.
- Existing queue/run result types remain public.
- Focused tests and typecheck pass.

## Phase 7: Files, Inbox, and Artifacts Domain

done: true

Target module:

- `packages/app/src/app/lib/veslo-server-domains/files.ts`

Scope:

- inbox upload/list/download
- file sessions create/renew/close
- file catalog snapshot/events
- read/write batch
- batch ops
- workspace file read/write
- artifact list/download

Test first:

- Add route contract tests for file session and artifact paths before extraction.
- Include multipart upload request expectations if practical.

Completion criteria:

- Multipart and binary transport behavior remains shared through `transport.ts`.
- Existing file/inbox/artifact client methods stay available.
- Focused tests and typecheck pass.

## Phase 8: Skills Domain

done: true

Target module:

- `packages/app/src/app/lib/veslo-server-domains/skills.ts`

Scope:

- local workspace skills
- hub skills
- user skill store
- skill enabled state
- removals and batch removals
- materialization status/sync

Registry publishing/review/rollout policy calls were kept in this domain with Phase 9 to avoid
creating a second near-duplicate skill transport/auth module.

Test first:

- Add route contract tests for local skills, hub skills, removals, and materialization before extraction.

Completion criteria:

- Product terminology remains unchanged in API-facing names.
- Registry-owned calls are not mixed into this module.
- Focused tests and typecheck pass.

## Phase 9: Skill Registry Domain

done: true

Target module:

- `packages/app/src/app/lib/veslo-server-domains/skills.ts`

Scope:

- registry search
- skill create
- version create/list
- installation create/update/delete/restore
- review request create/approve/reject
- workspace skill set replace
- rollout policy list/create/update/delete
- registry validators and registry-specific path builders

Implementation note:

- Kept inside `skills.ts` because it shares Den auth context, materialization helpers, and route
  timing with the rest of the skills client. Splitting it now would add another medium-small module
  without reducing the public client surface further.

Test first:

- Add route/path tests for registry operations before extraction.
- Keep response validator tests in `veslo-server.test.ts` or add a focused registry client test if the file becomes too large.

Completion criteria:

- Registry validation remains in the registry domain, not the generic transport.
- Public registry types remain re-exported from `veslo-server.ts`.
- Focused tests and typecheck pass.

## Phase 10: Soul Domain

done: true

Target module:

- `packages/app/src/app/lib/veslo-server-domains/soul.ts`

Scope:

- soul overview
- organization/user/workspace reads
- version list/get
- organization/user/workspace update
- restore operations
- workspace materialization sync
- heartbeat toggle/status/list

Test first:

- Add route/path tests for soul methods before extraction.
- Reuse existing soul layout/controller tests only as supplemental coverage, not as the only client-contract coverage.

Completion criteria:

- Den auth context headers are preserved.
- Materialization request body semantics remain unchanged.
- Focused tests and typecheck pass.

## Phase 11: AI Access Domain

done: true

Target module:

- `packages/app/src/app/lib/veslo-server/client.ts`

Scope:

- `getMyAiAccess`
- `requestManagedAiAccessBundle`
- gateway caller header behavior if not better kept in `transport.ts`

Implementation note:

- Kept in the client composition shell because the current AI access surface is two methods and a
  shared gateway header helper. A separate module would be below the module size rule until this
  domain grows.

Test first:

- Extend `src/app/tests/lib/veslo-server.test.ts` around managed AI access request headers and response handling.

Completion criteria:

- Send/runtime callers still import from `veslo-server.ts`.
- Gateway authorization headers are unchanged.
- Focused tests and typecheck pass.

## Phase 12: Final Barrel Cleanup

done: true

Scope:

- Ensure `packages/app/src/app/lib/veslo-server.ts` contains only:
  - public re-exports
  - public compatibility aliases if absolutely necessary
- Remove stale internal helpers from the barrel.
- Check for circular imports.
- Check for direct consumer imports from internal modules. Internal imports are allowed only from domain modules and tests that explicitly target internals.

Test first:

- Add a public barrel export smoke test if regressions are not fully caught by existing tests.

Completion criteria:

- Public barrel remains stable.
- No new tiny modules were added outside the approved boundaries.
- All focused checks pass.
- `done: true` at the top of this file is set after verification passes.

## Progress Log

Append entries here during implementation.

Format:

```text
YYYY-MM-DD - Phase N - test written: <test file> - module changed: <module file> - verification: <command/result> - done: true|false
```

2026-06-27 - Phase 1 - test written: `packages/app/src/app/tests/lib/veslo-server-modularization.test.ts` - module changed: `packages/app/src/app/lib/veslo-server/types.ts` - verification: `pnpm --filter @neatech/veslo-ui typecheck` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-route-manifest-contract.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts src/app/tests/lib/veslo-server-modularization.test.ts` passed - done: true
2026-06-27 - Phase 2 - test written: `packages/app/src/app/tests/lib/veslo-server.test.ts` - module changed: `packages/app/src/app/lib/veslo-server/connection.ts` - verification: `pnpm --filter @neatech/veslo-ui typecheck` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-route-manifest-contract.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts src/app/tests/lib/veslo-server-modularization.test.ts` passed - done: true
2026-06-27 - Phase 3 - test written: `packages/app/src/app/tests/lib/veslo-server.test.ts` - module changed: `packages/app/src/app/lib/veslo-server/transport.ts` - verification: `pnpm --filter @neatech/veslo-ui typecheck` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-route-manifest-contract.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts src/app/tests/lib/veslo-server-modularization.test.ts` passed - done: true
2026-06-27 - Phase 4 - test written: `packages/app/src/app/tests/lib/veslo-server-modularization.test.ts` - module changed: `packages/app/src/app/lib/veslo-server/client.ts`, `packages/app/src/app/lib/veslo-server.ts` - verification: `pnpm --filter @neatech/veslo-ui typecheck` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-route-manifest-contract.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts src/app/tests/lib/veslo-server-modularization.test.ts` passed - done: true
2026-06-27 - Phase 5 - test written: `packages/app/src/app/tests/lib/veslo-server.test.ts` - module changed: `packages/app/src/app/lib/veslo-server-domains/workspace.ts` - verification: `pnpm --filter @neatech/veslo-ui typecheck` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-route-manifest-contract.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts src/app/tests/lib/veslo-server-modularization.test.ts` passed - done: true
2026-06-27 - Phase 6 - test written: `packages/app/src/app/tests/lib/veslo-server.test.ts`, `packages/app/src/app/tests/lib/veslo-server-session-prefetch.test.ts` - module changed: `packages/app/src/app/lib/veslo-server-domains/conversations.ts` - verification: `pnpm --filter @neatech/veslo-ui typecheck` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-route-manifest-contract.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts src/app/tests/lib/veslo-server-modularization.test.ts` passed - done: true
2026-06-27 - Phase 7 - test written: `packages/app/src/app/tests/lib/veslo-server.test.ts` - module changed: `packages/app/src/app/lib/veslo-server-domains/files.ts` - verification: `pnpm --filter @neatech/veslo-ui typecheck` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-route-manifest-contract.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts src/app/tests/lib/veslo-server-modularization.test.ts` passed - done: true
2026-06-27 - Phase 8 - test written: `packages/app/src/app/tests/lib/veslo-server.test.ts` - module changed: `packages/app/src/app/lib/veslo-server-domains/skills.ts` - verification: `pnpm --filter @neatech/veslo-ui typecheck` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-route-manifest-contract.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts src/app/tests/lib/veslo-server-modularization.test.ts` passed - done: true
2026-06-27 - Phase 9 - test written: `packages/app/src/app/tests/lib/veslo-server.test.ts` - module changed: `packages/app/src/app/lib/veslo-server-domains/skills.ts` - verification: `pnpm --filter @neatech/veslo-ui typecheck` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-route-manifest-contract.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts src/app/tests/lib/veslo-server-modularization.test.ts` passed - done: true
2026-06-27 - Phase 10 - test written: `packages/app/src/app/tests/lib/veslo-server.test.ts` - module changed: `packages/app/src/app/lib/veslo-server-domains/soul.ts` - verification: `pnpm --filter @neatech/veslo-ui typecheck` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-route-manifest-contract.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts src/app/tests/lib/veslo-server-modularization.test.ts` passed - done: true
2026-06-27 - Phase 11 - test written: `packages/app/src/app/tests/lib/veslo-server.test.ts` - module changed: `packages/app/src/app/lib/veslo-server/client.ts` - verification: `pnpm --filter @neatech/veslo-ui typecheck` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-route-manifest-contract.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts src/app/tests/lib/veslo-server-modularization.test.ts` passed - done: true
2026-06-27 - Phase 12 - test written: `packages/app/src/app/tests/lib/veslo-server-modularization.test.ts` - module changed: `packages/app/src/app/lib/veslo-server.ts` - verification: `pnpm --filter @neatech/veslo-ui typecheck` passed; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-route-manifest-contract.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts src/app/tests/lib/veslo-server-modularization.test.ts` passed - done: true
