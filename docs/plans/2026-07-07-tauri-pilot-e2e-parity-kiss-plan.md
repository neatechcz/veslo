---
title: Tauri Pilot E2E Parity KISS Plan
date: 2026-07-07
status: in_progress
done: false
issue: unlinked
source_audit: chat:2026-07-07-tauri-pilot-e2e-parity-audit
base_branch: local/sandbox-merge
tpe00_token_handoff_done: true
tpe01_fresh_e2e_build_done: true
tpe02_redacted_diagnostics_done: false
tpe02_core_auth_redaction_done: true
tpe02_live_inference_timing_done: true
tpe03_live_inference_timeout_policy_done: true
tpe04_production_path_suite_contract_done: true
---

# Tauri Pilot E2E Parity KISS Plan

## Goal

Make the Tauri Pilot E2E path behave as close as practical to the development
and release desktop paths, especially for live managed-AI inference.

The acceptance path must prove that:

- the app uses the real local Veslo AI gateway,
- OpenCode receives the local Veslo server client token through
  `VESLO_OPENCODE_SERVER_CLIENT_TOKEN`,
- inference goes through `codex_oauth` and not an OpenAI API-key fallback,
- E2E does not silently test stale sidecars or a stale Tauri binary,
- failure diagnostics explain the failing transition without leaking live auth
  secrets.

## Current Evidence

- The E2E Tauri config uses the dedicated identifier
  `com.neatech.veslo.e2e` and grants `pilot:default` only in
  `packages/desktop/src-tauri/tauri.e2e.conf.json`.
- The Rust Pilot plugin is gated behind
  `#[cfg(all(debug_assertions, feature = "e2e"))]`.
- `tauri-pilot` and `tauri-plugin-pilot` are currently on `0.7.2`.
- Live managed-AI Pilot scenarios reject the gateway fixture and require a real
  Den auth snapshot.
- The latest local live-inference run completed `20/20` steps in `68.774s`
  with the real snapshot-hydrated account, the local Veslo server,
  `codex_oauth`, a native Pilot send-button click, and a rendered assistant
  response. It used no managed-AI gateway fixture, artificial response delay,
  or activity-probe fixture; debug dev autostart was enabled.
- The redacted per-run summary measured `52.542s` from native click to first
  assistant text: `1.029s` to server acceptance, `42.508s` before OpenCode
  made the provider request, `7.609s` to upstream response headers, and
  `1.396s` to first rendered text. It reported no real runtime/model/server
  fallback. The dominant delay is therefore before the provider request, not
  Pilot input, local server submission, or a fallback branch.
- This is still an isolated-profile cold-first-inference measurement: the
  orchestrator spawned its engine `3.271s` before the native send. It must not
  be represented as a normal warmed dev-window latency baseline.
- The earlier local `401` happened after OpenCode selected `codex_oauth`; the
  current gate now asserts the actual accepted event
  `sendPrompt:server-submit-first-success`, not the stale
  `sendPrompt:success` trace name.

## KISS Principles

- Fix the real app path first. Do not hide app bugs behind E2E fallbacks.
- Keep `pilot:default` isolated to E2E builds.
- Prefer one client-token source of truth over retry/fallback logic.
- Prefer one explicit fresh E2E build command over implicit stale-binary checks.
- Redact diagnostics at capture time instead of relying on reviewers to avoid
  sharing sensitive artifacts.
- Keep lifecycle/recovery scenarios separate from production-path inference
  acceptance scenarios.

## Implementation Progress — 2026-07-16

Completed:

- **TPE00:** the generated server client token is retained in
  `VesloServerManager`; persisted server recovery now compares a requested
  token before adoption and records only non-secret decision booleans when it
  rejects a mismatch.
- **TPE01:** `build:desktop:e2e` is the single fresh local entry point. It
  builds `veslo-server`, force-prepares sidecars, then builds the E2E Tauri
  binary. The missing-binary error points to that command and explicitly names
  `tauri.e2e.conf.json`.
- **TPE02 core safety:** post-boot Pilot auth injection/reload was removed.
  Live scenarios verify the snapshot-hydrated signed-in state instead. Failure
  diagnostics now record redacted storage summaries and redact known credential
  fields from captured output, errors, and command arguments.
- **TPE02 live-inference timing:** a successful canonical run now writes one
  redacted summary with only simulated-input state, dev-autostart/model shape,
  pipeline timing breakdown, provider identity, explicit fallback classes, and
  startup database-missing count. Correlation IDs, auth, headers, prompt text,
  and raw traces remain out of that artifact. The suite writes server traces
  only into its harness-owned E2E log directory and keeps raw app output there;
  normal success output is the concise diagnostic line. Set
  `E2E_FORWARD_APP_LOGS=1` for an intentional raw local troubleshooting run.
  A lifecycle polling event is no longer misclassified as a runtime fallback.
- **TPE03:** canonical `live-inference` now contains only the 180-second
  message-send scenario. The runner checks every TOML global/step timeout for
  that suite and bounds the outer command to 185 seconds, including a five
  second diagnostic grace. This is a real-provider observation budget, not a
  latency target. The longer cold-start handoff has an explicit
  `live-inference-lifecycle` suite instead.
- **TPE04:** canonical live inference requires a real snapshot-hydrated Den
  user, no gateway fixture, the harness-owned isolated profile, local
  `codex_oauth` access, a visible assistant response, no direct engine-start
  IPC, and no inherited OpenAI key/base environment. It handles the real
  account's SharePoint prompt through visible Pilot actions, uses the
  browser-native contenteditable input path before the native send click. Every
  isolated live managed-AI scenario mirrors only the allowlisted native runtime
  preferences from the dev profile (`sharedUnsandboxedEngine`,
  `supportDiagnostics`). Lifecycle coverage remains separately labelled.

TPE02 remains open until the non-secret sidecar/provider-config/log/env-presence
artifacts and their focused tests are added.

The next parity decision is deliberately separate: add a named warm
steady-state live-inference measurement only if the desired baseline is a
long-running developer window. It must warm the same isolated profile through
the real path first, then measure a second native Pilot send; do not relabel
this cold-first-inference observation as warm latency.

## TPE00 - Fix Veslo Server Client Token Handoff

### Problem

`commands/engine.rs` can generate a Veslo server client token before starting
the local server and passes that token to the orchestrator. `start_veslo_server`
can then adopt persisted server state with a different token before it considers
the requested token. OpenCode then calls the local AI gateway with a bearer
token that the local server does not accept.

This matches the observed live failure:

- submit reaches server successfully,
- OpenCode selects `codex_oauth/gpt-5.5`,
- local `/ai-gateway/.../chat/completions` returns `401`.

### KISS Fix

- Normalize `veslo_server_client_token` before persisted recovery in
  `start_veslo_server`.
- Adopt persisted server info only when either no requested token exists or the
  recovered `client_token` equals the requested token.
- When persisted recovery is rejected because of a requested-token mismatch,
  emit a diagnostic with booleans only:
  `hasRequestedClientToken`, `hasRecoveredClientToken`, `decision`, `reason`.
- Seed a newly generated token from `current_or_new_veslo_client_token` back
  into `VesloServerManager` state so repeated callers reuse the same token.
- Do not log token values.

### Tests

- Unit test that requested-token mismatch rejects persisted adoption.
- Unit test that requested-token match allows persisted adoption.
- Unit test or focused assertion that `current_or_new_veslo_client_token`
  returns a stable manager-backed token after first generation.

## TPE01 - Add Fresh E2E Desktop Build Entry Point

### Problem

The E2E runner launches an already-built debug binary from
`packages/desktop/src-tauri/target/debug/veslo.exe`. It does not rebuild
sidecars or the Tauri binary. Development and release paths do prepare sidecars
as part of their normal build/start flow, so E2E can test old code.

### KISS Fix

- Add a small script such as `packages/e2e/scripts/build-e2e-desktop.mjs`.
- The script should run, in order:
  - `pnpm --filter veslo-server build:bin`
  - `VESLO_SIDECAR_FORCE_BUILD=1 pnpm --filter @neatech/veslo run prepare:sidecar`
  - from `packages/desktop`:
    `pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e`
- Add package scripts that make the intended path obvious, for example:
  - `build:desktop:e2e`
  - `test:pilot:live-inference:fresh`
- Update stale launcher error messages that still point at
  `tauri.dev.conf.json`; E2E builds should point at `tauri.e2e.conf.json`.

### Tests

- Unit or smoke test that the launcher error text references
  `tauri.e2e.conf.json`.
- Script dry-run or command-construction test if the script is structured for
  testability.

## TPE02 - Redact Pilot Failure Diagnostics

### Problem

Pilot diagnostics currently capture raw storage dumps. Live Den auth can be
present in `veslo.den.auth`, which risks writing bearer tokens into
`storage-local.json` or `storage-session.json`.

### KISS Fix

- Replace raw storage output with redacted storage output for known auth keys.
- For `veslo.den.auth`, write only:
  `present`, `hasToken`, `email`, `denApiBase`, and parse errors if any.
- Add a generic diagnostic redactor for sensitive field names:
  `token`, `accessToken`, `refreshToken`, `Authorization`, `apiKey`,
  `secret`, `password`.
- Add high-signal non-secret artifacts:
  - sidecar `versions.json`,
  - redacted OpenCode provider config summary,
  - OpenCode log tail filtered for provider, model, and error lines,
  - env presence booleans for `VESLO_OPENCODE_SERVER_CLIENT_TOKEN`.

### Tests

- Unit test that diagnostics do not include a sample Den token.
- Unit test that `veslo.den.auth` is summarized instead of copied.
- Unit test that generated redacted provider config preserves provider/model
  evidence while hiding bearer material.

## TPE03 - Define the 180 Second Live-Inference Observation Policy

### Problem

`resolveLaunchTimeout` caps desktop boot waits at 95 seconds, but a real cold
Codex OAuth response can take longer after the app is ready. Treating the boot
cap as an inference cap made the production-path gate fail before a valid live
response could arrive.

### KISS Fix

- Keep the 95 second boot cap and give canonical `live-inference` a separate
  180 second response observation budget.
- Keep long lifecycle/recovery scenarios outside the canonical production-path
  inference suite unless they fit this focused observation contract.
- Add a helper test that rejects `global_timeout_ms` and step `timeout_ms`
  above 180000 for canonical live-inference scenarios.
- Leave broader non-inference scenario cleanup for a separate pass.

### Tests

- Helper test that the `live-inference` suite scenarios have no timeout above
  180000 and that the outer Pilot command allows only the additional five
  second diagnostic grace.
- Focused check that `VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS` remains
  bounded for live-inference runs.

## TPE04 - Mark the Production-Path Inference Suite Explicitly

### Problem

Some managed-AI scenarios use direct Tauri IPC calls such as `engine_start`,
`engine_info`, or `orchestrator_workspace_activate`. That can be valid for
lifecycle/recovery coverage, but it is not the same as proving the production
user path.

### KISS Fix

- Keep a small canonical production-path suite for live inference.
- For that suite, require:
  - no managed-AI gateway fixture,
  - real Den auth,
  - no OpenAI API-key fallback,
  - no direct engine-start IPC unless explicitly allowed by the suite contract,
  - bounded timeouts.
- Keep lifecycle/recovery scenarios in a separate suite with explicit labels.

### Tests

- Extend existing runner tests so the canonical production-path suite rejects
  direct engine IPC commands.
- Keep allowlisted lifecycle scenarios out of that assertion.

## Verification Order

1. Run targeted Rust tests around `veslo_server` token adoption.
2. Run E2E helper tests:
   `pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/app-launcher.test.ts helpers/pilot-runner.test.ts`.
3. Run the fresh E2E desktop build script.
4. Run the canonical live-inference Pilot suite with a real Den auth snapshot
   and `E2E_MANAGED_AI_GATEWAY_FIXTURE=0`.
5. Inspect diagnostics from any failure and confirm they identify the first
   failing transition without exposing auth tokens.

## Non-Goals

- Do not enable Pilot in release builds.
- Do not make fixture gateway runs count as live inference acceptance.
- Do not replace the local Veslo AI gateway with direct OpenAI API calls.
- Do not globally rewrite all Pilot scenarios in the first patch.
- Do not introduce a new auth fallback to mask local server token mismatch.
