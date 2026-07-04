# Fix 27: VSLO-270 Stop Reload Reconnect

## Problem

After a long or blocked desktop agent run, the installed app could leave the
user without reliable control:

- a `blocked` model retry diagnostic was visible as an error phase, so Stop
  could take the local error-reset path instead of backend abort,
- abort could depend on a locally remembered run id that may be missing after a
  restart or session handoff,
- server abort intent depended too much on OpenCode abort success,
- reload could proceed after failed stop attempts,
- installed-app relaunch reconnect was not covered by the VSLO-270 sequence.

## Fix

- UI Stop now treats backend-active error phases as abortable and calls the
  normal abort path.
- App conversation abort falls back to server-resolved active-run abort when
  the local run id is missing.
- Server abort records durable abort intent and reconciles successful aborts to
  terminal lifecycle state.
- Reload force-stop records per-session failures and waits for reload-blocking
  lifecycle/status state to clear before reloading.
- Added installed/Tauri pilot coverage for:
  blocked model retry -> Stop -> backend abort -> active lifecycle clear ->
  app quit/relaunch -> local Veslo host reconnect -> original conversation not
  active.

## Validation

```powershell
pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts helpers/app-launcher.test.ts
python -c "import tomllib; tomllib.load(open('packages/e2e/pilot-scenarios/vslo-270-relaunch-reconnect.toml','rb')); tomllib.load(open('packages/e2e/pilot-scenarios/vslo-270-stop-reload-reconnect.toml','rb')); print('toml ok')"
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario vslo-270-stop-reload-reconnect
```

Result:

- server focused tests: `47 pass`, `0 fail`
- server typecheck: passed
- UI conversation-service test: `6 pass`, `0 fail`
- UI typecheck: passed
- E2E runner/app launcher tests: `35 pass`, `0 fail`, `1 skip`
- TOML parse: passed
- installed debug pilot main scenario: `4 pass`, `0 fail`
- installed debug relaunch scenario: `4 pass`, `0 fail`

## Status

VSLO-270 KISS slice is complete. Deferred product follow-ups remain separate:
engine stop semantics and final reload copy polish.
