# Fix 17: Controller and Owner Extraction Checkpoint

## Problem

Several high-risk business logic areas were still owned by broad shell modules
or UI components even after route adapters and facades had been introduced.

The concrete risk was not route registration itself, but duplicated or hidden
domain ownership:

- AI Gateway runtime state lived in `server.ts` alongside HTTP proxy handling.
- Soul read-model and materialization rules were injected into `routes/soul.ts`
  from local `server.ts` helper closures.
- Workspace config import/export, `veslo.json`, conversation directory
  authorization, and OpenCode reload helpers lived in `server.ts`.
- Dashboard update prompt behavior was encoded as many local memos inside the
  view component.

`packages/app/src/app/context/extensions.ts` was reviewed but intentionally left
out of this checkpoint. It is already the current owner for that domain, even if
it is still large.

## Fix

- Added `packages/server/src/ai-gateway-runtime-owner.ts` as the runtime owner
  for AI Gateway state:
  - runtime provider authorization
  - active run registration and unregister
  - session resolution and placeholder fallback handling
  - active proxy request abort registry
  - provider hit watchdog state
- Added `packages/server/src/soul-controller.ts` as the server-side Soul owner
  for:
  - Den context extraction
  - edit permission checks
  - summary/read payload creation
  - pending user edit read-model state
  - materialization locks and configured workspace materialization
  - active workspace id parsing for Soul sync calls
- Added `packages/server/src/workspace-config-owner.ts` as the workspace config
  owner for:
  - `veslo.json` read/write semantics
  - conversation read directory normalization and authorization
  - OpenCode reload URL/auth handling
  - workspace import/export logic
- Added `packages/app/src/app/pages/dashboard-update-pill-model.ts` as a pure
  app-side model for Dashboard update prompt behavior.
- Rewired `packages/server/src/server.ts` to delegate to these owners while
  preserving the existing route contracts.
- Rewired `packages/app/src/app/pages/dashboard.tsx` so the update prompt view
  reads from the new model instead of owning the state matrix inline.
- Updated the existing Dashboard update prompt source-contract test to point at
  the extracted model.

## Scope Boundaries

- Extensions were not changed in this checkpoint.
- AI Gateway HTTP proxy streaming and response handling still remain in
  `server.ts`; this checkpoint moves runtime ownership, not the whole proxy
  transport.
- Existing route adapter contracts were kept stable.
- Existing user-facing behavior was preserved; the work is ownership and test
  structure, not a product behavior redesign.

## Coverage

- Added `packages/server/src/tests/ai-gateway-runtime-owner.test.ts`.
  - Covers unresolved OpenCode placeholder fallback, ambiguous active context
    suppression, active run unregister, runtime authorization selection and
    clearing, active proxy abort matching, and provider hit expiry.
- Added `packages/server/src/tests/soul-controller.test.ts`.
  - Covers Den context extraction, edit permission rules, stable empty Soul
    payloads, active workspace id expansion, and offline pending user edits.
- Added `packages/server/src/tests/workspace-config-owner.test.ts`.
  - Covers `veslo.json` replace/merge semantics, workspace-relative directory
    normalization, unauthorized directory rejection, reload URL/auth helper
    behavior, and export redaction boundaries.
- Added `packages/app/src/app/tests/pages/dashboard-update-pill-model.test.ts`.
  - Covers manual download gating, active-run install blocking, retry state,
    progress state, and desktop-runtime visibility gating.

## Verification

```powershell
bun test packages/server/src/tests/ai-gateway-runtime-owner.test.ts packages/server/src/tests/soul-controller.test.ts packages/server/src/tests/workspace-config-owner.test.ts
bun test packages/server/src/tests/ai-gateway-runtime-owner.test.ts packages/server/src/tests/server.ai-gateway-routes.test.ts packages/server/src/tests/server.ai-gateway.test.ts packages/server/src/tests/soul-controller.test.ts packages/server/src/tests/soul-routes.test.ts packages/server/src/tests/workspace-config-owner.test.ts packages/server/src/tests/server.workspace-management-routes.test.ts
pnpm --filter @neatech/veslo-ui exec node --conditions=browser --test --import=tsx/esm src/app/tests/pages/dashboard-update-pill-model.test.ts src/app/tests/pages/sidebar-update-prompt-actions.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
git add -N docs/fixes/2026-07-01-fix-17-controller-owner-extraction.md
git diff --check -- docs/fixes/2026-07-01-fix-17-controller-owner-extraction.md
git diff --check
```

Result:

- new server owner focused suite passed: `13 pass`, `0 fail`
- broader server AI Gateway/Soul/workspace focused suite passed: `51 pass`,
  `0 fail`
- app Dashboard update prompt focused suite passed: `10 pass`, `0 fail`
- server typecheck passed
- app typecheck passed
- the new markdown note was marked intent-to-add before running targeted
  `git diff --check`
- `git diff --check` passed with only Windows LF-to-CRLF warnings

## Status

This controller/owner extraction checkpoint is complete. The remaining
architectural follow-up is optional: a future narrow pass could move the AI
Gateway HTTP proxy transport out of `server.ts`, but the mutable runtime state
and core business rules now have explicit owners.
