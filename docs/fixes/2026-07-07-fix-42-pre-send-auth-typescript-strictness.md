# Fix 42: Pre-Send Auth TypeScript Strictness Pass

Date: 2026-07-07

## Scope

This checkpoint records a targeted TypeScript strictness pass over pre-send,
auth, gateway, and conversation-submit boundaries.

Covered areas:

- app DEN auth and desktop auth exchange helpers
- app managed-AI access retry and Veslo server transport/settings helpers
- server AI gateway route/runtime authorization boundary
- server conversation submit parsing and draft resolution
- server conversation/session routes used by send, submit, abort, transcript,
  and prefetch flows

## What Changed

- Removed explicit `undefined` optional fields from app auth/session settings
  payloads; absent optional values are now omitted.
- Made managed-AI access retry delay indexing safe under
  `noUncheckedIndexedAccess`.
- Built Veslo server request `RequestInit` values without `body` when no body is
  present.
- Added a local required route-param helper for server conversation routes and
  used it before workspace resolution.
- Built AI gateway proxy inputs without `actor` when no actor is present.
- Tightened conversation-submit parsing so target, draft, attachment, and
  option objects do not emit optional properties with explicit `undefined`.
- Tightened submit result payloads so `debugTrace` is present only when a real
  trace exists.
- Updated tests that previously asserted explicit `undefined` optional fields.
- Tightened auth/gateway test helpers so they do not record optional arguments
  as explicit `undefined`.

## Findings

`noUncheckedIndexedAccess` is useful in this slice. It found real assumptions in
base64 byte iteration, retry-delay lookup, and server route parameter reads.

`exactOptionalPropertyTypes` is also useful, but not ready to enable globally in
the app or server. It showed a consistent boundary smell: many callsites build
objects with `foo: undefined` instead of omitting `foo`. The pre-send submit and
auth helper boundaries were small enough to fix now.

Remaining app findings are mostly in orchestration callsites such as
`conversation-service`, `managed-ai-runtime-config`, `send-runtime-readiness`,
and `session-send-workflow`. Remaining server findings are mostly in
`server.ts`, AI gateway diagnostic payload construction, request context
creation, and skill-registry/materialization payload builders.

## Future Direction

- Introduce small object builder helpers for optional fields, especially for
  request/response DTOs that cross app-server or server-runtime boundaries.
- Continue with `exactOptionalPropertyTypes` by ownership slice:
  app runtime preflight, app session send workflow, server AI gateway proxy,
  then server skill registry/materialization.
- Keep `noUncheckedIndexedAccess` as the next candidate for targeted enablement
  in route/request boundary files after required-param and array-result helpers
  are in place.
- Add route-level tests for missing required params where handlers can be called
  directly in tests, even if the runtime router normally guarantees them.
- Prefer fail-closed route/input helpers over downstream fallback behavior in
  send and gateway flows.

## Verification

Run on 2026-07-07:

```powershell
pnpm --filter @neatech/veslo-ui typecheck
# exit 0

pnpm --filter veslo-server typecheck
# exit 0

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/den-auth.test.ts src/app/tests/lib/managed-ai-access-retry.test.ts src/app/app-managed-ai-access-retry-gate.test.ts src/app/tests/lib/veslo-server.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/context/managed-ai-runtime-config.test.ts src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/app-send-preflight-context.test.ts src/app/tests/app-send-workspace-scope.test.ts src/app/tests/pending-session-send-flow.test.ts
# pass 204, fail 0

pnpm --filter veslo-server exec bun test src/tests/conversation-submit-service.test.ts src/tests/conversation-submit-draft-resolution.test.ts src/tests/conversation-submit-skill-command-resolution.test.ts src/tests/server.conversation-session-routes.test.ts src/tests/server-conversations.test.ts src/tests/server.ai-gateway.test.ts src/tests/server.ai-gateway-routes.test.ts src/tests/ai-gateway-runtime-owner.test.ts
# pass 101, fail 0

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/den-auth.test.ts src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/managed-ai-access-retry.test.ts src/app/app-managed-ai-access-retry-gate.test.ts
# pass 91, fail 0

pnpm --filter veslo-server exec bun test src/tests/ai-gateway-runtime-owner.test.ts src/tests/server.ai-gateway-routes.test.ts
# pass 11, fail 0

pnpm --filter veslo-server build:bin
# exit 0

git diff --check -- packages/app/src/app/lib/den-auth.ts packages/app/src/app/lib/managed-ai-access-retry.ts packages/app/src/app/lib/veslo-server/connection.ts packages/app/src/app/lib/veslo-server/transport.ts packages/app/src/app/tests/lib/den-auth.test.ts packages/app/src/app/tests/lib/veslo-server.test.ts packages/server/src/ai-gateway-runtime-owner.ts packages/server/src/conversation-submit-contract.ts packages/server/src/conversation-submit-draft-resolution.ts packages/server/src/conversation-submit-service.ts packages/server/src/conversation-submit-skill-command-resolution.ts packages/server/src/routes/ai-gateway.ts packages/server/src/routes/conversations.ts packages/server/src/tests/ai-gateway-runtime-owner.test.ts
# exit 0, LF/CRLF warnings only
```

Diagnostic checks intentionally not enabled globally:

```powershell
pnpm --filter @neatech/veslo-ui exec tsc -p tsconfig.json --noEmit --noUncheckedIndexedAccess
# still reports broad app findings outside this slice

pnpm --filter @neatech/veslo-ui exec tsc -p tsconfig.json --noEmit --exactOptionalPropertyTypes
# still reports broad app orchestration optional-property findings

pnpm --filter veslo-server exec tsc -p tsconfig.json --noEmit --noUncheckedIndexedAccess
# still reports broad server findings outside this slice

pnpm --filter veslo-server exec tsc -p tsconfig.json --noEmit --exactOptionalPropertyTypes
# remaining findings are mainly in server.ts and skill-registry/materialization builders
```

## Status

The pre-send/auth strictness slice is complete. The targeted app and server
tests pass, both package typechecks pass, and the server binary was rebuilt.
