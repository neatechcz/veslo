---
title: Header Token Owner Profiles Checkpoint
date: 2026-07-08
status: complete
done: true
plan: ../plans/2026-07-08-header-token-owner-profiles-implementation-plan.md
repo: veslo-main
---

# Header Token Owner Profiles Checkpoint

## Summary

The header/token owner profile slice is complete for the audited first scope.
The implementation keeps the ownership boundaries small:

- app Veslo server transport owns app-side auth/content/Den/gateway caller
  header builders,
- app Veslo server domain clients reuse the shared Den context builder,
- server inbound routes use a server-owned request header reader module,
- server CORS browser-facing custom headers are derived from a single
  server-owned allowlist,
- AI gateway proxy stripping has a dedicated profile for internal, local-only,
  and AI-gateway transport headers,
- OpenCode/server proxy transport names remain local to `server.ts`,
- OpenCode provider routing and orchestrator header ownership remain local to
  their existing boundaries.

## Evaluation

Verdict: KISS-clean for the first slice.

The original cause was scattered header ownership, not a missing individual
header. The fix addresses that cause by moving repeated app Den header building,
server Den/header parsing, CORS allowlist ownership, and AI gateway strip lists
behind explicit local owners.

The final review found one real scope leak before this checkpoint: generic proxy
transport names had drifted into `request-headers.ts`. That is now fixed.
`request-headers.ts` owns Veslo inbound request headers and readers only.
`server.ts` keeps OpenCode/server proxy transport constants local, and the AI
gateway profile owns its own transport strip list.

Behavioral contracts preserved:

- Den token/org/base validation keeps the existing error codes.
- `/hub/mcp`, `/hub/skills`, Soul, and skill registry keep their existing Den
  base URL semantics.
- AI gateway reads local/internal headers before stripping them.
- AI gateway still forwards upstream provider `Authorization`, forwarded
  `x-veslo-session-id`, `content-type`, and `x-veslo-request-id`.
- CORS continues to allow the browser-facing Veslo custom headers from a
  server-owned allowlist.
- App conversation send-trace and archive account headers now resolve through
  the app header profile instead of local string literals.
- Static literal audits leave only explicitly local or external owner surfaces:
  OpenCode generated provider config, MCP connector headers, feedback/publisher
  headers, Den outbound clients, orchestrator lifecycle, and internal
  OpenCode/AI-gateway request correlation.

No blocker remains for the header/token owner profile implementation.

## Changed Scope

Primary files:

- `packages/app/src/app/lib/veslo-server/header-profiles.ts`
- `packages/app/src/app/lib/veslo-server/transport.ts`
- `packages/app/src/app/lib/veslo-server-domains/conversations.ts`
- `packages/app/src/app/lib/veslo-server-domains/mcp.ts`
- `packages/app/src/app/lib/veslo-server-domains/skills.ts`
- `packages/app/src/app/lib/veslo-server-domains/soul.ts`
- `packages/app/src/app/lib/veslo-server-domains/workspace.ts`
- `packages/server/src/request-headers.ts`
- `packages/server/src/ai-gateway-proxy-headers.ts`
- `packages/server/src/routes/conversations.ts`
- `packages/server/src/routes/mcp.ts`
- `packages/server/src/routes/skill-materialization.ts`
- `packages/server/src/routes/skill-registry.ts`
- `packages/server/src/routes/skill-removals.ts`
- `packages/server/src/routes/workspace-skills.ts`
- `packages/server/src/server.ts`
- `packages/server/src/soul-controller.ts`
- `packages/server/src/tests/server.skill-registry-search.test.ts`
- `packages/server/src/tests/ai-gateway-proxy-headers.test.ts`
- `docs/plans/2026-07-08-header-token-owner-profiles-implementation-plan.md`

Dirty tree note: the worktree also contains unrelated modified files from
other slices. This checkpoint covers only the header/token owner profile scope.

## Verification

Fresh verification after the final scope-leak fix:

```powershell
corepack pnpm@10.27.0 --filter veslo-server typecheck
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/ai-gateway-proxy-headers.test.ts src/tests/server.conversation-session-routes.test.ts
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/ai-gateway-proxy-headers.test.ts src/tests/server.ai-gateway.test.ts src/tests/ai-gateway-runtime-owner.test.ts src/tests/server.skill-registry-search.test.ts
rg -n "export const ACCEPT_ENCODING_HEADER|export const CONTENT_LENGTH_HEADER|export const HOST_HEADER|export const ORIGIN_HEADER|export const HOP_BY_HOP_REQUEST_HEADERS" packages\server\src\request-headers.ts
rg -n "ACCEPT_ENCODING_HEADER|CONTENT_LENGTH_HEADER|HOST_HEADER|ORIGIN_HEADER|HOP_BY_HOP_REQUEST_HEADERS" packages\server\src\request-headers.ts packages\server\src\server.ts packages\server\src\ai-gateway-proxy-headers.ts
```

Results:

- server typecheck: passed,
- app typecheck: passed,
- AI gateway strip and conversation route smoke tests: 2 passed,
- server focused AI gateway/runtime/CORS tests: 47 passed,
- server transport owner audit: `request-headers.ts` has no generic transport
  exports; transport names remain only in `server.ts` and the AI gateway strip
  profile,
- app literal audit: conversation send-trace/account literals are gone from the
  domain client; remaining literals are accepted local/external owners,
- earlier full app focused suite recorded in the plan: 143 passed.

Additional verification was already recorded in the implementation plan:

- app focused tests: 143 passed,
- broader server focused route/Soul/AI gateway bundle: 96 passed.

## Self-Review Notes

Follow-up self-review found and fixed two non-behavioral cleanup issues:

- the implementation plan had stale continuation notes around transport header
  ownership; those now point to the final state where `request-headers.ts` does
  not own generic proxy transport names,
- `server.ts` still used direct `content-type` / `Content-Type` literals even
  though `CONTENT_TYPE_HEADER` already existed; those now use the owner
  constant, and the AI gateway strip-profile test does the same.

During this self-review, the three untracked/modified server files were
rewritten once by another active process in the same worktree. The final state
was reapplied and rechecked after that rewrite. The last audit showed no
generic proxy transport exports in `request-headers.ts`.

Follow-up stabilization confirmed no `veslo-main` dev/watch processes remained.
After that, server typecheck, app typecheck, AI gateway strip smoke tests, and
the server AI gateway/runtime/CORS focused bundle passed without the source
files being rewritten again.

## Non-Blocking Follow-Ups

These are intentionally outside this completed slice:

- decide whether `extraHeaders` should be prevented from overriding base app
  auth/content headers,
- decide whether app and server should share neutral header-name constants in a
  separate protocol package,
- decide whether the literal audits should become a committed CI script,
- revisit orchestrator constants only if a future orchestrator slice needs it.
