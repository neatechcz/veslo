# Fix 09: Managed AI Run-Scoped Gateway Correlation

## Problem

In shared non-sandboxed OpenCode runtime, provider config is shared by multiple workspaces. Veslo wrote `x-veslo-workspace-id` into generated model headers, so a stale shared config could send a provider request for workspace B with workspace A's header.

When OpenCode also sent `x-veslo-session-id: ${OPENCODE_SESSION_ID}`, the local server resolved the placeholder through the workspace fallback. If the stale workspace still had an active managed-AI run, the provider hit could be attributed to the wrong run. The real run then timed out with `AI gateway provider request did not start`, or the proxy returned `gateway_session_unresolved` when the stale workspace did not match any active context.

## Fix

- Generated managed-AI provider config no longer writes `x-veslo-workspace-id`.
- Config sanitization scrubs legacy `x-veslo-workspace-id` model headers from existing managed provider config.
- Runtime validation treats any legacy workspace-scoped gateway model header as stale config that needs a rewrite.
- The local AI gateway proxy resolves placeholder Veslo session ids from OpenCode's real per-request `x-session-id` header.
- Provider-hit tracking records the effective workspace from the resolved active run, while traces keep `incomingWorkspaceId` separately for diagnostics.
- Workspace fallback remains only as a legacy path when there is one active workspace context; cross-workspace active contexts fail closed instead of misattributing a provider hit.

## Files

- `packages/app/src/app/lib/opencode.ts`
- `packages/app/src/app/lib/ai-access.ts`
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/tests/lib/provider-routing.test.ts`
- `packages/app/src/app/tests/lib/ai-access.test.ts`
- `packages/app/src/app/tests/app-managed-ai-config-sync-contract.test.ts`
- `packages/server/src/server.ts`
- `packages/server/src/tests/server.ai-gateway.test.ts`
- `packages/server/src/tests/server-conversations.test.ts`
- `docs/dev/state-and-config-reference.md`
- `docs/features/session-runtime.md`
- `docs/sandbox/ai-gateway-audit.md`

## Verification

```powershell
bun test packages/server/src/tests/server.ai-gateway.test.ts packages/server/src/tests/server-conversations.test.ts

pnpm exec node --test --import=tsx/esm src/app/tests/lib/provider-routing.test.ts src/app/tests/lib/ai-access.test.ts src/app/tests/app-managed-ai-config-sync-contract.test.ts

pnpm --filter veslo-server typecheck

pnpm --filter @neatech/veslo-ui typecheck
```

Result: targeted server gateway/conversation tests passed (`34/34`), targeted app managed-AI config tests passed (`56/56`), and server/app typechecks passed.
