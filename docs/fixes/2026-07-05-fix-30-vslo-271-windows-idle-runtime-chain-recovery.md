# Fix 30: VSLO-271 Windows Idle Runtime Chain Recovery

Date: 2026-07-05

## Scope

Implemented the local runtime-chain recovery path for Windows shared
unsandboxed mode:

- stale desktop orchestrator daemon URLs are rejected before use,
- orchestrator shutdown records caller/reason and clears persisted daemon state
  even when cleanup fails,
- server `/status` reports a concrete `runtimeChain` status,
- app connection and send preflight require runtime-chain readiness instead of
  `/health` alone,
- shared OpenCode proxy failures mark the shared engine unhealthy,
- recoverable post-preflight send failures retry once with the same
  `clientMessageId`,
- engine SSE/event stream failures release stale routing and trigger bounded
  recovery.

Follow-up KISS hardening after audit:

- source-contract tests now target the current owners
  (`workspace-runtime-controller`, `local-runtime-lifecycle`,
  `workspace-routing`) instead of stale `workspace.ts` symbols,
- server lifecycle register conflicts now do one active-run lookup and reuse the
  existing active run when `clientMessageId` matches, avoiding a duplicate
  queued prompt in the narrow direct-submit race,
- VSLO-271 Pilot timeouts now let the in-webview watchdog write scenario
  diagnostics before the runner/global timeout can kill the step.

Current diff footprint at the time of this note:

- 49 modified tracked files,
- 4 untracked files:
  - `docs/fixes/2026-07-05-fix-30-vslo-271-windows-idle-runtime-chain-recovery.md`,
  - `docs/plans/2026-07-05-windows-idle-runtime-chain-recovery-implementation-plan.md`,
  - `packages/app/src/app/tests/lib/engine-sse.test.ts`,
  - `packages/e2e/pilot-scenarios/vslo-271-windows-idle-runtime-chain-recovery.toml`.

Key implementation owners:

- Desktop/Rust: orchestrator base URL liveness, shutdown reason plumbing, E2E
  fault injection commands, Rust SSE stream error emission.
- Orchestrator: shutdown cleanup ordering, shared engine HTTP health strikes,
  proxy upstream error health marking, run-store `client_message_id`/`origin`
  persistence.
- Server: workspace-scoped runtime-chain `/status`, lifecycle client
  `clientMessageId`/`origin` plumbing, active-run idempotence and queue dedupe.
- App: local server false-green prevention, send preflight runtime recovery,
  post-preflight retry, SSE route release and recovery, clearer send-failure UI.
- E2E: VSLO-271 live-auth Pilot scenario and Pilot runner enforcement for live
  managed-AI auth.

## Desktop Pilot

Live-auth Windows Pilot command used for the VSLO-271 scenario:

```powershell
$env:VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE='C:\Users\jajse\.veslo\den-auth.json'
$env:E2E_MANAGED_AI_GATEWAY_FIXTURE='0'
$env:VESLO_ENABLE_AUTOMATIONS='0'
$env:VESLO_ENABLE_AUTOMATIONS_PLUGIN='0'
$env:E2E_TAURI_PILOT_BIN='C:\Users\jajse\.cargo\bin\tauri-pilot.exe'
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario vslo-271-windows-idle-runtime-chain-recovery
```

Result: `4 passed, 0 failed`.

The scenario used live Den auth for `david.kral@neatech.cz`, disabled the
managed-AI fixture, injected dead orchestrator and shared proxy faults, recovered
the runtime chain, sent a real composer prompt, and observed `sendPrompt:success`
with the expected assistant token.

One earlier pilot pass was rejected because it reported green while the send
trace contained `AI gateway provider request did not start within 30000ms`.
The scenario now fails on send trace errors and widens the live provider-start
watchdog to 90000 ms for this scenario.

Latest follow-up changed only scenario timing/diagnostic budgets:

- scenario global timeout: `340000` ms,
- eval step timeout: `280000` ms,
- in-webview diagnostic watchdog: `260000` ms,
- final marker wait: `290000` ms.

The live Pilot was not rerun after the final KISS follow-up; the Pilot runner
contract test was rerun and passed.

## Validation

Targeted validation completed during the main fix pass:

```powershell
cargo fmt
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::orchestrator::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml orchestrator::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml --features e2e --quiet
pnpm --filter veslo-orchestrator exec bun test src/tests/router-proxy.test.ts src/tests/shared-opencode-engine.test.ts src/tests/run-store.test.ts
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-server exec bun test src/tests/server.health-status-routes.test.ts src/tests/conversation-run-lifecycle-controller.test.ts src/tests/conversation-run-queue-store.test.ts src/tests/server.opencode-proxy-timeout.test.ts src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/message-list-edit-user-message.test.ts src/app/tests/context/veslo-server-connection.test.ts src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/app-stale-local-runtime-recovery.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:i18n
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts
pnpm --filter veslo-server build:bin
$env:VESLO_SIDECAR_FORCE_BUILD='1'; pnpm --filter @neatech/veslo run prepare:sidecar; Remove-Item Env:\VESLO_SIDECAR_FORCE_BUILD
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario vslo-271-windows-idle-runtime-chain-recovery
pnpm release:review --strict
```

The final pilot teardown stopped the app process and managed child processes.
`release:review --strict` passed with warnings only: missing sidecar manifest
and unset `SOURCE_DATE_EPOCH`.

Additional validation after the follow-up audit fixes:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/workspace-browse-cold-start.test.ts src/app/context/workspace-quiet-connect-timeout.test.ts src/app/tests/context/workspace-runtime-controller-source.test.ts
pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/context/veslo-server-connection.test.ts src/app/tests/lib/engine-sse.test.ts
pnpm --filter veslo-server exec bun test src/tests/server.health-status-routes.test.ts src/tests/conversation-run-lifecycle-controller.test.ts src/tests/conversation-run-queue-store.test.ts src/tests/server.opencode-proxy-timeout.test.ts src/tests/server-conversations.test.ts
pnpm --filter veslo-orchestrator exec bun test src/tests/run-store.test.ts src/tests/run-registry.test.ts src/tests/shared-opencode-engine.test.ts src/tests/router-proxy.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server typecheck
pnpm --filter veslo-orchestrator typecheck
git diff --check
```

Results:

- app stale/source runtime tests: `4 pass`,
- app runtime/SSE/status subset: `37 pass`,
- server lifecycle targeted: `30 pass`,
- server broader subset: `59 pass`,
- orchestrator subset: `61 pass`,
- Pilot runner tests: `21 pass`,
- app/server/orchestrator typechecks passed,
- `git diff --check` passed with CRLF warnings only.
