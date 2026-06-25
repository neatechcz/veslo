# Fix 05: VSLO-254 Workspace Runtime Route Recovery

## Problem

After sending in one workspace, opening another workspace or private chat could fail on the first send with `Odeslani selhalo`. The app selected the new workspace correctly, but the workspace-scoped OpenCode health route returned `404 {"error":"workspace not found"}`. Send readiness treated that failed probe as non-fatal and continued with the stale routed client, so session creation failed through the server as `502 OpenCode request failed`.

The deeper issue was that runtime readiness could be over-reported from a cached workspace route even when the local orchestrator no longer had that workspace registered.

## Fix

- Send runtime health now classifies `workspace not found`, `workspace_id_mismatch`, and local `404` responses as stale route/runtime signals.
- Failed health probes against an existing routed client no longer default to "continue"; unknown probe failures recover once by releasing the scoped route, ensuring the target workspace runtime, and reacquiring a client.
- If recovery cannot prove a routed client, send readiness returns `false` before session or pending UI state is created.
- The app runtime owner now supports `requiresOrchestratorReadiness(workspaceId)`.
- The app shell enables that strict readiness guard for Tauri local workspaces running through `veslo-orchestrator`, so a cached route alone is not a runtime-ready proof without an orchestrator ready/idle engine snapshot.
- Remote workspaces and non-orchestrator/direct local runtime modes keep the existing route-based readiness behavior.

## Files

- `packages/app/src/app/context/send-runtime-readiness.ts`
- `packages/app/src/app/context/runtime-owner.ts`
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/tests/context/send-runtime-readiness.test.ts`
- `packages/app/src/app/tests/context/runtime-owner.test.ts`
- `packages/app/src/app/tests/lib/veslo-server.test.ts`
- `packages/app/src/app/tests/app-stale-local-runtime-recovery.test.ts`
- `packages/app/src/app/tests/app-send-latency-trace.test.ts`
- `packages/orchestrator/src/tests/router-proxy.test.ts`
- `docs/dev/state-and-config-reference.md`
- `C:\Users\jajse\Desktop\projekty\dev-specific\20260625-vslo-254-workspace-not-found-send-audit.md`

## Verification

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/runtime-owner.test.ts src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/app-stale-local-runtime-recovery.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/app-send-preflight-context.test.ts

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-routing.test.ts src/app/tests/context/workspace-activate-order-sync.test.ts src/app/tests/context/workspace-activation-local-source.test.ts src/app/tests/app-boot-engine-ready.test.ts src/app/tests/context/workspace-runtime-controller-source.test.ts

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts

pnpm --filter veslo-orchestrator exec bun test src/tests/router-proxy.test.ts

pnpm --filter @neatech/veslo-ui typecheck

git diff --check -- packages/app/src/app/context/runtime-owner.ts packages/app/src/app/app.tsx packages/app/src/app/tests/context/runtime-owner.test.ts packages/app/src/app/tests/app-send-latency-trace.test.ts packages/app/src/app/context/send-runtime-readiness.ts packages/app/src/app/tests/context/send-runtime-readiness.test.ts packages/app/src/app/tests/app-stale-local-runtime-recovery.test.ts packages/app/src/app/tests/lib/veslo-server.test.ts packages/orchestrator/src/tests/router-proxy.test.ts docs/dev/state-and-config-reference.md docs/fixes/2026-06-25-fix-05-vslo-254-workspace-runtime-route-recovery.md
```

Result: targeted runtime/send tests passed (`54/54`), neighboring workspace routing/activation/boot contracts passed (`38/38`), Veslo server client tests passed (`44/44`), orchestrator proxy tests passed (`22/22`), typecheck passed, and diff check passed for the touched files.

Full `test:unit` was not used as the final signal because the current working tree has unrelated existing failures outside VSLO-254.
