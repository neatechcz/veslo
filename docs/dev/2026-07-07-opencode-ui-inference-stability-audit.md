# OpenCode and UI inference stability audit

Date: 2026-07-07
Branch: `sandbox-merge`
Head: `93c03afd8ca710eecb3c0529643a1addb5842bd2`

## Scope

This is a static deep audit of the current OpenCode and UI work around:

- inference stability and predictability,
- server-owned composer submit,
- historical message and cross-chat continuity,
- shared OpenCode engine versus sandboxed runtime defaults,
- UI observability and user-facing runtime state.

No runtime behavior was changed in this pass. I did not run a live Tauri/Pilot end-to-end scenario in this audit, so all live-inference conclusions below are code/docs based unless explicitly marked as prior recorded evidence.

Primary sources inspected:

- `docs/dev/opencode-workspace-runtime-architecture.md`
- `docs/dev/opencode-shared-non-sandbox-runtime.md`
- `docs/dev/conversation-history-resume.md`
- `docs/dev/server-owned-composer-submit.md`
- `docs/dev/2026-07-06-app-server-flow-delay-blackbox-audit.md`
- `docs/testing/tauri-pilot/README.md`
- `docs/testing/findings/2026-07-06-full-test-sweep-failure-handoff.md`
- `docs/plans/2026-07-07-opencode-old-conversation-submit-audit.md`
- desktop runtime preference code under `packages/desktop/src-tauri/src`
- orchestrator topology code under `packages/orchestrator/src`
- server conversation read/write code under `packages/server/src`
- app session selection and send workflow code under `packages/app/src/app`

## Executive conclusion

1. Fresh desktop profiles on Windows and macOS do default to direct shared OpenCode mode: sandbox effectively off, shared OpenCode engine on. This is not the bare orchestrator/server default. It is a desktop runtime preference that writes both `VESLO_DISABLE_SANDBOX=1` and `VESLO_SHARED_OPENCODE_ENGINE=1` for that runtime.

2. The current server-owned submit path is more predictable for new or already-bound Veslo conversations because it fails closed instead of falling back through legacy UI paths. That is good for determinism.

3. The biggest current stability gap is old conversation continuity. The read path can show historical OpenCode sessions, but the write path requires a Veslo conversation binding. That means an old conversation can be visible in the UI while follow-up submission fails before inference starts.

4. The system has improved inference diagnostics: provider-start timeout is treated as diagnostic after OpenCode accepts the prompt, not as an automatic live-run failure. The AI gateway owner also suppresses ambiguous workspace fallback. These are strong predictability improvements.

5. The remaining inference risk is not primarily "model inference". It is routing and lifecycle identity: which workspace, which Veslo conversation, which OpenCode session, and which active run receives the next message.

6. The UI now presents a positive "Sandbox" setting instead of exposing the internal "shared unsandboxed engine" flag as the primary control. That is directionally correct. The UI still needs a first-class "effective runtime topology" readout for support/debugging, because the same app can run under desktop defaults, explicit env, dev Pilot mode, or bare orchestrator mode.

7. The current `pnpm dev`/Pilot work improves observability, but it changes the normal dev runtime shape by default. In particular, setting `VESLO_E2E=1` in a manual dev runtime should be treated as a risk unless every consumer is audited as diagnostic-only.

## Answer: sandbox default versus shared OpenCode engine

For the desktop app on Windows/macOS with no saved preference:

- Yes, the sandbox version is default-off in effect.
- Yes, shared OpenCode engine is default-on in effect.
- The desktop runtime preference emits both env values together:
  - `VESLO_DISABLE_SANDBOX=1`
  - `VESLO_SHARED_OPENCODE_ENGINE=1`

For the bare orchestrator/server:

- No, shared-unsandboxed mode is not the default.
- The default topology remains pooled/per-workspace unless explicitly configured.
- `VESLO_SHARED_OPENCODE_ENGINE=1` without `VESLO_DISABLE_SANDBOX=1` is rejected as an invalid configuration.
- A fallback from WSL sandbox launch failure to direct host mode is not the same as shared engine mode.

This distinction matters because "sandbox is off" and "shared engine is on" are not globally equivalent. They are equivalent only when the desktop preference path or explicit env path sets both sides of the contract.

## Runtime topology evidence

Desktop preference layer:

- `packages/desktop/src-tauri/src/runtime_preferences.rs`
  - `default_shared_unsandboxed_engine_enabled()` is true on Windows and macOS.
  - missing preference file resolves to `Some(true)` on Windows/macOS.
  - enabled preference emits both `VESLO_DISABLE_SANDBOX=1` and `VESLO_SHARED_OPENCODE_ENGINE=1`.
  - disabled preference emits both as `0`.

Desktop startup layer:

- `packages/desktop/src-tauri/src/commands/engine.rs`
  - reads the desktop shared-unsandboxed preference and forwards it to orchestrator spawn.
- `packages/desktop/src-tauri/src/commands/orchestrator.rs`
  - builds orchestrator env overrides from the same preference.
- `packages/desktop/src-tauri/src/veslo_server/spawn.rs`
  - maps enabled shared-unsandboxed preference to no sandbox backend and applies the same env contract.

Orchestrator topology layer:

- `packages/orchestrator/src/engine-topology.ts`
  - topology is `shared-unsandboxed` only when shared engine is explicitly enabled, sandbox is disabled, and sandbox kind is `none`.
  - otherwise topology is `pooled-per-workspace`.
  - shared engine with sandbox still enabled is rejected.
- `packages/orchestrator/src/cli.ts`
  - creates `SharedOpenCodeEngine` only for `shared-unsandboxed`.
  - shared runtime files are scoped under orchestrator data directories, not mixed with the workspace directory itself.

Audit judgment:

- The default is intentional and guarded for desktop Windows/macOS.
- The invalid mixed state is rejected in orchestrator code, which improves predictability.
- The remaining risk is operator confusion: different launch paths can have different defaults, so diagnostics must show effective topology, not just configured sandbox capability.

## Historical messages and other chats

Current identity model:

- UI session id
- Veslo conversation id
- OpenCode session id
- workspace/directory scope

The current design separates passive history browse from live inference:

- Selecting an old scoped sidebar conversation should be passive.
- It should read durable host transcript first.
- It should not activate a workspace or cold-start OpenCode just to browse.
- If host transcript is unavailable, live fallback is allowed only under narrow conditions: scoped metadata, owning workspace already active, runtime ready, and known OpenCode session id.

Important boundary:

- Durable host history can be displayed even when the original OpenCode engine session cannot be resumed.
- A raw transcript alone is not enough to guarantee continuation of the same OpenCode session.
- "Messages from other chats" are only usable if they are in known Veslo/OpenCode storage, under the exact workspace/directory scope, and can be bound or imported into Veslo's conversation identity model.
- There is no general cross-chat memory or automatic semantic stitching across arbitrary chat histories in the current architecture.

Current read path:

- `packages/server/src/conversation-read-store.ts`
  - can read OpenCode SQLite session rows by exact directory variants.
  - returns unavailable rather than silently treating missing history as empty.
- `packages/server/src/conversation-service.ts`
  - host-first transcript load.
  - can attach/bind conversations when list/read paths have enough data.

Current write path:

- `packages/server/src/server.ts`
  - existing-session submit resolves through `resolveConversationExecutionTarget`.
  - requires requested directory.
  - requires Veslo conversation binding for the target.
  - returns `conversation_not_found` when no binding exists.
- `packages/app/src/app/context/session-send-workflow.ts`
  - treats server-owned submit as authoritative.
  - does not fall back to legacy UI run when server submit fails or blocks.

Audit judgment:

- This is deterministic for already-bound conversations.
- It is brittle for old OpenCode-only sessions because UI visibility does not imply submit eligibility.
- The failure happens before provider inference, so AI Gateway/model debugging will not explain it.

## Primary finding: historical read/write asymmetry

Severity: P1

Observed contract:

- Read path can show historical OpenCode sessions from SQLite.
- Write path requires a Veslo `conversation_binding`.
- Some legacy/global OpenCode sessions can appear in the UI without that binding.
- Follow-up submit then fails before OpenCode receives the prompt.

Likely user symptom:

- "I can see old OpenCode conversations, but when I write a new prompt into one, no answer comes back."

Why this is a stability problem:

- The UI presents the conversation as selectable/resumable.
- The server rejects it as not executable.
- That makes inference look flaky even though inference was never reached.

Preferred fix:

- Add server-side safe import-on-submit for exact, known legacy OpenCode sessions.
- Do not re-enable broad frontend fallback.

Safe import-on-submit contract:

1. Existing-session submit first checks normal Veslo binding.
2. If missing and the request carries a raw OpenCode session id, require an explicit directory/workspace scope.
3. Read OpenCode SQLite for the exact session id under the exact directory variants.
4. Reject if the session id exists only under another directory.
5. Create the missing Veslo conversation binding.
6. Retry the submit through the normal server-owned path.

Required tests:

- old OpenCode-only session under exact workspace can be imported and submitted,
- same raw session id under wrong workspace is rejected,
- missing directory is rejected,
- already-bound conversation follows the existing path,
- frontend still does not call legacy run fallback after server-owned submit failure.

## Inference stability and predictability

The current architecture has three distinct layers that must be separated when debugging:

1. Submit/lifecycle routing
2. OpenCode prompt acceptance and event stream
3. AI Gateway/provider request and SSE response

Good current properties:

- Server-owned composer submit centralizes the decision to start a run.
- Existing-session submit is fail-closed.
- Runtime readiness no longer relies on the old global `engineReady` shortcut.
- Provider-start observation is diagnostic after OpenCode accepts the prompt.
- A provider-start timeout records diagnostics and schedules reconcile instead of failing or aborting a live OpenCode run.
- AI Gateway runtime owner suppresses ambiguous workspace fallback instead of guessing when multiple active contexts exist.

Main remaining risks:

- Active run correlation still depends on correct session/workspace context at every boundary.
- Progress is split between POST run result, OpenCode events, transcript ingestion, lifecycle polling, and UI optimistic state.
- Streaming/abort semantics are still called out as a high-risk area by the latest broad test sweep.
- Several fixes are verified by focused tests/typechecks, but not yet by installed-runtime Tauri/Pilot end-to-end coverage.

Audit judgment:

- Inference itself is becoming more predictable.
- The fragile part is the route to inference and the mapping back from provider/OpenCode events to the correct UI conversation.
- For user-visible stability, every "no answer" case should be classified as one of:
  - submit did not reach OpenCode,
  - OpenCode accepted prompt but did not call provider,
  - provider returned error/timeout,
  - provider returned SSE 200 but transcript/lifecycle/UI did not reconcile.

## UI behavior

Positive findings:

- The settings UI now presents "Sandbox" as the primary concept.
- Enabling/disabling the toggle writes the inverse shared-unsandboxed preference correctly.
- Tests assert that internal strings such as "Shared unsandboxed engine" and `VESLO_DISABLE_SANDBOX` do not appear in the primary user-facing settings surface.
- Developer runtime diagnostics expose configured/effective sandbox details, fallback, child kind, and related context.

Remaining UI risks:

- The app should surface effective runtime topology explicitly:
  - `shared-unsandboxed`
  - `pooled-per-workspace`
  - sandbox backend/effective child kind
  - whether a restart is required
- Historical conversations need a visible state distinction:
  - readable and resumable,
  - readable but needs import/bind,
  - readable only,
  - unavailable.
- A server `conversation_not_found` on a visible historical conversation should not look like generic inference failure.
- Developer-only runtime text still has localization/literal-scan cleanup risk according to the broad test sweep.

## Current `pnpm dev` and Pilot runtime work

Observed WIP changes:

- `packages/desktop/scripts/tauri-dev.mjs`
  - defaults manual `pnpm dev` to Pilot runtime unless disabled.
  - creates runtime manifests and trace files.
  - sets `VESLO_TAURI_PILOT=1`.
  - sets `VESLO_DEV_RUNTIME_MODE=manual-pilot`.
  - sets `VESLO_E2E=1`.
- `packages/desktop/scripts/tauri-dev.test.mjs`
  - validates the new script behavior by source-level tests.
- `docs/testing/tauri-pilot/README.md`
  - documents manual dev runtime/Pilot debugging.

Audit judgment:

- This is valuable for observability.
- It also means `pnpm dev` is no longer a pure normal dev runtime unless opted out.
- `VESLO_E2E=1` in a manual dev workflow is the main concern. Even if current usage appears mostly diagnostic/test-helper related, this variable is semantically broad enough to create accidental test-mode behavior later.

Recommendation:

- Prefer `VESLO_TAURI_PILOT=1` and `VESLO_DEV_RUNTIME_MODE=manual-pilot` for manual dev diagnostics.
- Avoid setting `VESLO_E2E=1` by default unless every runtime consumer is audited and documented as safe.
- If keeping it, add a small documented invariant: manual Pilot may enable observability only, never alternate business logic or submit behavior.

## Risk table

| Area | Severity | Current state | Recommended next action |
| --- | --- | --- | --- |
| Old OpenCode session submit | P1 | Visible history can lack Veslo binding, submit fails before inference | Implement safe server import-on-submit |
| Workspace/session identity drift | P1 | Improved, but still called out by broad sweep | Add end-to-end tests across workspace switch, old session, first send, abort |
| Streaming/lifecycle semantics | P1 | Known high-risk area from sweep | Re-run focused OpenCode proxy, AI gateway, abort, retry scenarios |
| Desktop shared-unsandboxed default | P2 | Correct for Windows/macOS desktop, not global | Expose effective topology in UI/diagnostics |
| Manual Pilot default in `pnpm dev` | P2 | Better tracing, changed dev runtime shape | Remove or narrowly justify default `VESLO_E2E=1` |
| User-facing historical state | P2 | Readable/unavailable states exist, resumability not clear enough | Add explicit "readable but not resumable/import needed" UI state |
| Localization/literal cleanup | P3 | Primary settings improved, debug surfaces remain | Gate developer-only strings or localize as expected |

## Recommended next implementation sequence

1. Implement safe server-side import-on-submit for old OpenCode sessions under exact workspace scope.
2. Add UI copy/state for "history readable, continuation needs import" or hide submit until import eligibility is known.
3. Add Tauri/Pilot scenario:
   - seed old OpenCode session without Veslo binding,
   - display it in sidebar,
   - send follow-up,
   - verify OpenCode receives prompt,
   - verify transcript reconciles into the same visible conversation.
4. Add a compact send critical-path trace covering:
   - selected UI session id,
   - Veslo conversation id,
   - OpenCode session id,
   - workspace id/path,
   - submit target,
   - run id,
   - provider-start state,
   - reconcile state.
5. Audit `VESLO_E2E` consumers before making manual Pilot the default shape of `pnpm dev`.
6. Promote effective runtime topology in settings/developer diagnostics.

## Stop rules for future verification

Do not call an inference problem fixed until the evidence identifies which layer was exercised:

- UI submit reached server-owned run route.
- Server resolved a concrete Veslo conversation and OpenCode session.
- OpenCode accepted `prompt_async`.
- AI Gateway provider route was or was not hit.
- Provider SSE returned status and timing.
- Transcript reconcile appended the assistant response into the expected conversation.
- UI rendered the response under the same selected workspace/session.

For old conversations, also require:

- exact workspace directory match,
- exact OpenCode session id match,
- Veslo conversation binding present or created by safe import,
- no legacy frontend fallback used.

