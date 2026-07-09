# 2026-07-09 Session Flow Scope Root Cause KISS Implementation Plan

Status: Phase 0 done; Phase 1 done and targeted-test verified; Phase 2 material-change and scheduler TTL/debounce slices done and targeted-test verified; Phase 3 first diagnostics slice done and targeted-test verified; Phase 4 guard/reset plus trace-only formatting guard done and targeted-test verified; Phase 5 bounded active-visible recovery plus app-level opt-in validation done and targeted-test verified. Remaining caller/source tracing for `/opencode/mcp` stays deferred until a fresh runtime run proves route volume is still unexplained after dedupe.

Context: latest dev runtime logging from `2026-07-09` around `02:21-02:24` Europe/Prague showed successful submit calls, but repeated warning signals around missing session scope, transcript fallback, and UI run-state reset.

Implementation note from the follow-up audit: the submit path itself was not failing. The strongest confirmed problems were:

- existing-session sends could briefly run before the UI had a hydrated browse scope;
- provider config comparison could report `matches:false` for semantically equal JSON when object key order differed.

Second implementation note from the runtime deep audit: the latest split-trace dev run did not reproduce the older shared-engine/listener/trace-corruption symptoms. The remaining high-value problems are narrower: MCP status refresh had too many owners, skill-registry degradation lacked enough resource-level diagnostics, Managed AI routing/logging still formats too often, and active-session live reads can be too passive when the server is temporarily disconnected. Treat these as separate slices, not one implementation batch.

Third implementation note: Phase 2 first slice is now implemented. MCP refresh now uses a stable workspace/project/entries fingerprint before bumping the app refresh fingerprint, so equivalent MCP entries no longer force session capability reloads. Explicit/manual refresh still runs and still probes runtime status when requested.

Third implementation follow-up note: Phase 2 scheduler slice is now implemented. MCP auto refresh now coalesces rapid runtime dependency churn with a short debounce and suppresses repeated auto refresh for the same workspace/project target inside a bounded TTL. Explicit/manual refresh remains outside this auto-refresh skip path.

Fourth implementation note: Phase 3 first diagnostics slice is now implemented. Skill registry ApiError details now include scrubbed action/resource/scope metadata for materialization-relevant registry calls, materialization degraded payloads expose those fields, and workspace-skill-set 404 is no longer conflated with missing required package 404.

Fifth implementation note: Phase 4 first guard/reset slice is now implemented. Managed AI inactive-heal tracking now keys off a stable desired route/config fingerprint, and managed access metadata refreshes such as `updatedAt` no longer clear inactive-heal config tracking. Runtime auth-prime cache reset remains conservative and still follows the full managed access object.

Fifth implementation follow-up note: Phase 4 trace-only formatting guard is now implemented. `formatManagedAiAccessConfig()` opts out of `apply-gateway-provider-routing:start/done` telemetry for pure formatting, while direct `applyGatewayProviderRouting()` calls keep trace behavior by default.

Sixth implementation note: Phase 5 first bounded recovery slice is now implemented. Default `live-read` remains passive and still declines server startup, but an explicitly active visible selected-session transcript read may perform one bounded local server recovery start per workspace/directory/session key. Duplicate recovery attempts inside the window are traced and skipped.

Sixth implementation follow-up note: Phase 5 app-level wiring validation is now implemented. `loadOfflineTranscript()` passes the active-visible selected-session opt-in, while passive latest-session DB hydration remains a background read and does not request server-start recovery.

## Implementation Principles

- Keep fixes portable in repo code. Do not rely on local `.env`, machine-specific scripts, or developer-only runtime toggles.
- Preserve the simple shared non-sandbox engine path. The current shared engine baseline is healthy; do not split engines as the first response to telemetry noise.
- Prefer single-owner or deduped refresh paths over raising limits or adding retries.
- Keep reads best-effort, but do not let read fallback become write/send authority.
- Add tests before behavior changes in each new slice.
- Keep diagnostics useful and bounded: add caller/reason/fingerprint details where they answer a future audit question, but avoid tracing pure no-op formatting as if it were runtime work.

## Handoff State And KISS Boundary

This document intentionally mixes completed work and follow-up candidates. The completed slice is Phase 0 only.

Current repo state at the time this plan was evaluated:

- this plan file is untracked;
- Phase 0 app files are modified in the worktree:
  - `packages/app/src/app/context/workspace-send-target.ts`
  - `packages/app/src/app/lib/opencode.ts`
- related Phase 0 tests are expected in the worktree and should be checked before merge/handoff.

Handoff rule:

- implement one phase at a time;
- stop after each phase for targeted tests and `git diff --check`;
- do not combine MCP dedupe, skill-registry diagnostics, Managed AI routing churn, and live-read recovery in one change set;
- for Phases 2-5, add the narrow characterization test first, then the smallest code change that makes that test pass.

## Root Cause Hypothesis

The highest-signal failure mode is not an HTTP submit failure. Existing sessions can enter the send flow before `selectedSessionBrowseScope` / remembered conversation scope is fully hydrated.

The initial plan assumed this should immediately fail closed. The test-first audit narrowed that: if an authoritative send-target scope already exists, using it for send-time workspace activation is valid. What must not happen is treating active-workspace fallback as an explicit selected-session scope.

The secondary confirmed cause is config churn: `managedConfigContentsMatchForServerPatch()` normalized secrets, but then compared objects using raw `JSON.stringify()` order. That can keep `apply-gateway-provider-routing` noisy even when the actual config is equivalent.

## Evidence

- Runtime log signal: `sendPrompt:scoped-workspace-skipped-no-scope` appeared while the UI still had an active workspace and queue key.
- Runtime log signal: `sendPrompt:target-workspace-snapshot` had `workspaceId:null`, `workspaceRoot:null`, and `directory:null` for existing-session sends before later code recovered via fallback.
- Runtime log detail: existing-session sends for `ses_0bbbf31a6ffeO3mli81KpMqZGK` had null target snapshots at trace rows 147, 227, and 488, with matching `sendPrompt:scoped-workspace-skipped-no-scope` at rows 149, 229, and 490. Later sends for `ses_0c1378298ffespK2KBEEZvliOm` had the expected workspace and directory.
- Runtime log signal: `offline-transcript-fallback` reported `client unavailable`, `empty`, or slow fallback reads. This is consistent with selection/resume paths that do not have a stable conversation scope yet.
- Runtime log detail: `client unavailable` fallback appeared twice for the same session. One case had `activeWorkspaceId:null` and `sessionWorkspaceId:ws-8df10915b772`; the next had `activeWorkspaceId:ws-8df10915b772` and `sessionWorkspaceId:null`. That points to scope/runtime readiness ordering, not a failed server submit.
- Runtime log signal: `run-state:reset` happened after `hasBegun:true`. This is likely a visible symptom of lifecycle/idle transitions, not the primary root cause.
- Runtime log signal: repeated `managed-config-compare matches:false` appeared with changing byte counts. A unit test confirmed one concrete cause: semantically identical provider config with different JSON object key order was treated as a mismatch.

Relevant code:

- `packages/app/src/app/context/workspace-session-selection.ts`
  - `resolveSelectedSessionBrowseScope()` resolves only from selected/remembered conversation scope.
  - `setSessionBrowseScope()` is the intended owner for binding selected sessions to workspace/conversation scope.
- `packages/app/src/app/context/workspace-send-target.ts`
  - `ensureSelectedSessionWorkspaceActiveForSend()` was the right owner for the scope race. It now falls back from missing hydrated browse scope to send-target scope only when that target points at a non-active workspace.
- `packages/app/src/app/pages/session-send-workflow.ts`
  - Existing-session server submit falls back to `workspace.activeWorkspaceId()` and `workspace.activeWorkspaceRoot()` when `sendTargetWorkspace` is missing.
- `packages/app/src/app/context/session-route-sync.ts`
  - Route resume can select a session from `/session/:id`, but it does not reconstruct missing browse scope.
- `packages/app/src/app/app.tsx`
  - `loadOfflineTranscript()` also falls back to active workspace when transcript scope is missing. This is acceptable for best-effort read, but not as a write/send authority.
- `packages/app/src/app/lib/opencode.ts`
  - `normalizeConfigForServerPatchComparison()` now sorts object entries during comparison, so order-only JSON differences do not trigger another patch.

## Follow-Up Runtime Audit Findings (2026-07-09)

Latest inspected run:

- evidence source: split runtime/send-workflow trace files from the `2026-07-09` dev run.
- stale path note: an earlier audit label named `manual-runtime-20260709-022047-pnpm-dev`, but that folder is not present in current `.tmp`; do not treat it as current filesystem evidence.
- observed start timestamp from the trace set: `2026-07-09 02:20:48` Europe/Prague
- `runtime-trace.ndjson`: 731 rows, 0 malformed
- `send-workflow-trace.ui.ndjson`: 968 rows, 0 malformed
- `send-workflow-trace.server.ndjson`: 595 rows, 0 malformed
- `send-workflow-trace.orchestrator.ndjson`: 715 rows, 0 malformed

Baseline conclusions:

- No `MaxListenersExceededWarning`.
- No `spawnSync pnpm.cmd EINVAL`.
- No `invalid_desktop_diagnostics_event`.
- No fatal panic/uncaught runtime failure.
- Shared engine was healthy: `orchestrator:engine-topology` reported `explicit non-sandbox shared engine requested`; the shared engine spawned for `shared-unsandboxed` with `sandboxed:false`, `effectiveSandboxBackend:"none"`, and `sandboxMode:"disabled-by-env"`.
- SSE churn was materially lower: only two `/opencode/event` connections, both closed during shutdown and classified as `shutdown:true` / `nonFatalEngineError:true`.

### Finding 3: MCP runtime status refresh has too many owners

Signal:

- The latest run made 113 `GET /workspace/ws-8df10915b772/opencode/mcp` calls in roughly 2.5 minutes.

Cause chain:

- `packages/app/src/app/lib/workspace-runtime-schedulers.ts`
  - `createMcpAutoRefreshScheduler()` calls `refreshMcpServers()` when reactive runtime dependencies change.
  - There is no stable target fingerprint or short TTL saying "this workspace/runtime/config was already refreshed".
- `packages/app/src/app/lib/mcp-server-refresh.ts`
  - `applyEntries()` updates `mcpLastUpdatedAt(Date.now())` even when auto refresh only re-observes the same logical entries.
- `packages/app/src/app/app.tsx`
  - Session capabilities get `mcpRefreshFingerprint: mcpLastUpdatedAt`.
- `packages/app/src/app/context/session-capabilities-store.ts`
  - A changed fingerprint forces capabilities reload.
  - Capabilities reload can call `runtimeClient.mcp.status({ directory })`.
- `packages/app/src/app/context/global-sync.tsx`
  - Global refresh, child-directory refresh, and `mcp.tools.changed` events can also call `globalSDK.client().mcp.status()`.

Interpretation:

- This is not a crash, but it is ownership pressure. Multiple UI/runtime owners can ask the same shared engine for MCP state, and current traces do not identify the caller. The root cause is missing shared ownership/dedupe for MCP status refresh.

KISS fix:

- First slice: make `applyEntries()` material-change aware.
- Add a stable MCP entries/config hash and only bump the refresh fingerprint when the logical entries actually change.
- Keep `mcpLastUpdatedAt` or its replacement from changing on equivalent re-observation.
- Keep explicit user refresh immediate.
- Add scheduler TTL/debounce only if the material-change fix does not sufficiently reduce calls.
- Add route caller tracing for `/opencode/mcp` only after dedupe if route volume is still unexplained.

### Finding 4: skill registry materialization is degraded but under-instrumented

Signal:

- `workspace-skill-materialization` returned `status:"degraded"`, `synced:false`, and `registryError.code:"skill_registry_not_found"`.
- This happened during boot/warmup and stayed non-blocking.

Cause chain:

- Status reported registry configured and reload required.
- Sync then hit a registry 404 during broader materialization.
- `packages/server/src/skill-registry-client.ts` maps registry HTTP 404 to generic `skill_registry_not_found`.
- `packages/server/src/routes/skill-materialization.ts` can touch multiple registry resources during sync: workspace skill set, package downloads, personal-global installations, rollout policies.
- The current trace does not say which subresource returned 404.
- `packages/app/src/app/context/workspace-skill-materialization.ts` treats degraded-without-reload-required as non-blocking.

Interpretation:

- The non-blocking behavior is correct for app startup/send. The missing piece is diagnostic precision: today a missing optional registry resource and a missing required workspace skill-set can collapse into the same generic 404.

KISS fix:

- First slice: add scrubbed `resource` / `action` / `scope` details to server trace and degraded result details for registry 404s.
- Classify optional registry 404s separately from missing workspace skill set or missing package.
- Keep runtime and send unblocked.
- Surface grouped non-blocking diagnostics in existing runtime logs first. Add new UI surface only if existing diagnostics remain insufficient.

### Finding 5: Managed AI routing/logging still runs too often

Signal:

- Latest UI trace had 50 `apply-gateway-provider-routing:start` and 50 matching `done` events.
- 44 were for active workspace `ws-8df10915b772`.
- 6 were for inactive local workspaces.

Cause chain:

- `packages/app/src/app/context/managed-ai-runtime-config.ts`
   - Broad effects call active sync and inactive heal.
   - Inactive heal lists all local workspaces and formats access config for non-active workspaces.
   - It already has an `inactiveWorkspaceBaseUrlHealedFor` guard keyed by token/base URL, so this phase should extend that owner instead of introducing a second dedupe mechanism.
- `packages/app/src/app/lib/ai-access.ts`
  - `formatManagedAiAccessConfig()` always calls `applyGatewayProviderRouting()`.
- `packages/app/src/app/lib/opencode.ts`
  - `applyGatewayProviderRouting()` logs `start` / `done` for every format pass, even when the caller is only comparing or healing and no patch is needed.
- `packages/app/src/app/context/send-runtime-readiness.ts`
  - Send preflight can also force sync.

Interpretation:

- The key-order comparison fix removed one confirmed false mismatch, but this is a separate noise source: pure formatting/comparison paths are still traced like meaningful route work.

KISS fix:

- Extend the existing inactive-heal guard with a desired-route fingerprint before format/log/write.
- Only run inactive heal when server token, base URL, workspace list, or provider target changes.
- Mark each inactive workspace healed for the current route fingerprint until invalidated.
- Trace actual patch/skip decisions instead of every pure formatting call.

### Finding 6: selected live reads can decline server recovery too early

Signal:

- UI trace contained `conversation-read:server-start-declined` with reason `getTranscriptFromVesloReadApi`, intent `live-read`, and `vesloServerStatus:"disconnected"`.

Cause chain:

- `packages/app/src/app/context/conversation-service.ts`
  - Passive read policy allows server start for `write-follow-up` and `write-control`.
  - `live-read` is declined.

Interpretation:

- This is a good default for background reads. It is weaker for an actively visible selected session, where declining recovery can produce empty/unavailable transcript until a later lifecycle path reconnects.

KISS fix:

- Keep background `live-read` passive.
- Add a failing or characterization test before changing start policy.
- Allow one bounded recovery start only for the active/visible selected session when offline transcript is unavailable.
- Trace the decision explicitly, so future audits can separate intentional passive reads from active-session recovery.

## Non-Causes To Avoid Chasing First

- `workspace-skill-materialization` degraded with `skill_registry_not_found` is currently non-blocking by design. It needs better diagnostics, but it is not a send/startup blocker.
- `orchestrator:proxy-upstream:error` for `/event` during shutdown had `eventStream:true`, `shutdown:true`, and `nonFatalEngineError:true`; treat it as noisy classification, not the send root cause.
- Repeated `apply-gateway-provider-routing` is not the submit root cause. One confirmed source of false churn was key-order-sensitive config comparison, now covered by test.
- Empty assistant part updates can be normal streaming placeholders unless UI actually renders them as user-visible empty messages.
- Explicit UI aborts are not crashes. The latest run had `abortSession:start`, `abortConversation:success`, and server lifecycle reconciliation to `status:"aborted"` / `waitReason:"none"`.

## Confirmed Test-First Findings

### Finding 1: send-time workspace activation skipped valid fallback scope

Failing test added first:

- `packages/app/src/app/tests/context/workspace-send-target.test.ts`
- test: `send-time scoped activation can recover from a missing hydrated browse scope`

Observed failure before fix:

- activation list was `[]`;
- event path included `sendPrompt:scoped-workspace-skipped-no-scope`;
- the send target scope already knew `ws-b`, but `ensureSelectedSessionWorkspaceActiveForSend()` ignored it because `resolveSelectedSessionBrowseScope()` returned `null`.

KISS fix:

- compute `browseScope`;
- compute `sendTargetScope` only when browse scope is missing;
- use `sendTargetScope` for activation only when it points to a non-active workspace;
- keep old behavior for active fallback so active workspace does not masquerade as explicit session scope.

### Finding 2: managed config compare was order-sensitive

Failing test added first:

- `packages/app/src/app/tests/lib/provider-routing.test.ts`
- test: `server-backed managed config comparison ignores JSON object key order`

Observed failure before fix:

- `managedConfigContentsMatchForServerPatch(currentWithDifferentKeyOrder, desired)` returned `false`;
- content was semantically equivalent after parsing and secret normalization.

KISS fix:

- sort object entries inside `normalizeConfigForServerPatchComparison()`;
- keep redacted-token behavior strict, so real scrub/secret repair still patches.

## Implemented Slice

Done:

1. `workspace-send-target.ts`
   - Added browse-scope to send-target-scope fallback for send-time activation.
   - Kept active fallback conservative.

2. `opencode.ts`
   - Added stable object key ordering during managed config comparison.

3. Tests
   - Added focused regression test for missing hydrated browse scope.
   - Added focused regression test for provider config key order.
   - Updated `session-navigation.test.ts` source-contract matcher for the new explicit fallback logic.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/provider-routing.test.ts src/app/tests/context/workspace-send-target.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/context/workspace-session-selection.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts
git diff --check -- packages/app/src/app/lib/opencode.ts packages/app/src/app/context/workspace-send-target.ts packages/app/src/app/tests/lib/provider-routing.test.ts packages/app/src/app/tests/context/workspace-send-target.test.ts packages/app/src/app/tests/pages/session-navigation.test.ts
```

Results:

- 65/65 pass for provider routing, workspace send target, navigation contract, and workspace session selection.
- 44/44 pass for session send workflow.
- `git diff --check` clean except normal CRLF warnings.

## Primary KISS Implementation

This is the only immediate session-flow KISS scope. Phase 0, Phase 1, the Phase 2 MCP material-change and scheduler TTL/debounce slices, the first Phase 3 skill-registry diagnostics slice, the Phase 4 Managed AI inactive-heal guard/reset plus trace-only formatting guard, and the Phase 5 bounded active-visible recovery plus app-level opt-in validation are implemented. Stop here unless a new runtime/test failure proves a narrower follow-up is required.

### Phase 0: Preserve completed scope/config regression slice

Status: done.

Touched files:

- `packages/app/src/app/context/workspace-send-target.ts`
- `packages/app/src/app/lib/opencode.ts`
- `packages/app/src/app/tests/context/workspace-send-target.test.ts`
- `packages/app/src/app/tests/lib/provider-routing.test.ts`
- `packages/app/src/app/tests/pages/session-navigation.test.ts`

Do not reopen this slice unless a regression test fails. It already proves:

- send-time activation can recover from missing hydrated browse scope when authoritative send-target scope exists;
- active workspace fallback is not promoted to explicit session scope;
- managed config comparison ignores JSON key order while keeping secret repair strict.

### Phase 1: Tighten session-scope and transcript observability

Status: done.

Goal: make the remaining scope/read symptoms diagnosable, keep valid send-target fallback behavior, and fail closed only when both hydrated browse scope and authoritative send-target scope are missing.

Touched files:

- `packages/app/src/app/context/workspace-send-target.ts`
- `packages/app/src/app/pages/session.tsx`
- `packages/app/src/app/context/session-selection-controller.ts`
- `packages/app/src/app/tests/context/workspace-send-target.test.ts`
- `packages/app/src/app/tests/pages/session-send-workflow.test.ts`
- `packages/app/src/app/tests/context/session-selection-controller.test.ts`
- `packages/app/src/app/tests/pages/session-navigation.test.ts`

Implementation steps:

1. Expand `sendPrompt:scoped-workspace-skipped-no-scope` payload.

   File targets:

   - `packages/app/src/app/context/workspace-send-target.ts`
   - `packages/app/src/app/pages/session-send-workflow.ts` if submit-side context needs the same fields.

   Include:

   - `sessionId`
   - `selectedSessionId`
   - `activeWorkspaceId`
   - `browseScopeWorkspaceId`
   - `sendTargetWorkspaceId`
   - `hasSendTargetWorkspace`
   - `scopeCandidateCount` when cheaply available

   Note: `uiScopeWorkspaceId` and `uiScopeKey` stay on the higher-level send trace events that already own UI scope context.

2. Add a clear hard-block event only when both hydrated browse scope and authoritative send-target scope are missing for an existing-session send.

   Keep this as a targeted diagnostic/guard. Do not block merely because browse scope is late when send-target scope exists.

3. Replace generic `run-state:reset` reasons.

   File targets:

   - search all `run-state:reset` emitters under `packages/app/src/app`

   Expected reasons:

   - `session-status-idle`
   - `active-session-idle`
   - `idle-grace-expired`
   - `handoff-failure`
   - another concrete local reason if code proves a better name

4. Split transcript fallback taxonomy.

   File targets:

   - `packages/app/src/app/context/session-selection-controller.ts`

   Add a normalized reason classification so future audits can distinguish:

   - DB/browse policy read
   - true client unavailable fallback
   - empty offline transcript
   - active-session recovery

Tests added/updated:

- `packages/app/src/app/tests/context/workspace-send-target.test.ts`
- `packages/app/src/app/tests/pages/session-send-workflow.test.ts`
- `packages/app/src/app/tests/context/session-selection-controller.test.ts`
- `packages/app/src/app/tests/pages/session-navigation.test.ts`

Verification:

- 111/111 pass for `workspace-send-target`, `session-send-workflow`, `session-selection-controller`, and `session-navigation`.
- 47/47 pass for `provider-routing`, `workspace-session-selection`, and `conversation-service`.
- `git diff --check` clean for the Phase 1 files, with only normal CRLF warnings.

## Deferred Follow-Up Workstreams

These are valid findings from the runtime audit, but they are not part of the immediate session-flow KISS fix. Each workstream must be handled as its own change set with a failing or characterization test first.

### Phase 2: Deduplicate MCP status refresh

Status: material-change slice done; scheduler TTL/debounce slice done. Caller tracing remains deferred until runtime logs prove route volume is still unexplained after dedupe.

Goal: reduce repeated `/opencode/mcp` traffic by giving MCP status refresh one stable ownership model.

Implementation steps:

1. Add a stable MCP entries/config fingerprint helper.

   Status: done.

   Candidate file targets:

   - `packages/app/src/app/lib/mcp-server-refresh.ts`
   - or a small helper beside it if tests need direct import

   Implemented fingerprint inputs:

   - workspace id
   - normalized project directory
   - stable hash of MCP entries/config

2. Stop timestamp-only capability churn.

   Status: done in `mcp-server-refresh.ts` without changing the app signal contract.

   File targets:

   - `packages/app/src/app/lib/mcp-server-refresh.ts`
   - `packages/app/src/app/app.tsx`
   - `packages/app/src/app/context/session-capabilities-store.ts`

   Behavior:

   - only update `mcpLastUpdatedAt` or replacement fingerprint when entries materially change;
   - pass a stable `mcpRefreshFingerprint` into session capabilities;
   - do not reload capabilities solely because the same entries were re-applied.

3. Update `createMcpAutoRefreshScheduler()` only after the material-change fix if traces still show repeated calls for the same fingerprint.

   Status: done in `workspace-runtime-schedulers.ts`.

   File target:

   - `packages/app/src/app/lib/workspace-runtime-schedulers.ts`

   Implemented behavior:

   - skip auto refresh when the current workspace/project target equals the last successful auto refresh inside a bounded TTL;
   - coalesce rapid dependency churn with a short debounce;
   - keep explicit/manual refresh outside this skip path;
   - clear pending deferred refresh work on scheduler cleanup.

4. Add caller/source tracing only if needed.

   Status: deferred.

   If route volume still cannot be explained after dedupe, add a scrubbed source label for `/opencode/mcp` callers. Do not add this before dedupe unless tests/logs need it.

Tests to add/update:

- done: `mcp-server-refresh` test proving equivalent entries do not bump refresh fingerprint;
- done: `mcp-server-refresh` test proving target project changes do bump refresh fingerprint;
- done: `mcp-server-refresh` test proving explicit refresh still probes runtime status even when entries are unchanged;
- existing coverage retained: `session-capabilities-store` test proving unchanged context/fingerprint does not force a reload;
- done: scheduler pure tests for stable target fingerprint and TTL/debounce suppression;
- done: source-contract test proving app wiring uses `scheduleAutoRefresh(projectDir)` instead of direct auto-refresh calls.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/mcp-server-refresh.test.ts src/app/tests/context/session-capabilities-store.test.ts src/app/tests/mcp-hub-contract.test.ts src/app/tests/app-send-latency-trace.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/workspace-runtime-schedulers.test.ts
```

Results:

- 57/57 pass for MCP refresh, session capabilities, MCP hub contracts, send-latency/source contracts, and workspace runtime scheduler TTL/debounce helpers in the current combined UI validation.

### Phase 3: Add precise skill-registry degradation diagnostics

Status: first diagnostics slice done. Further UI surfacing or richer grouping remains deferred.

Goal: keep skill-registry 404s non-blocking, but make the failing registry resource/action obvious.

Implementation steps:

1. Preserve scrubbed registry context on client errors.

   Status: done.

   File target:

   - `packages/server/src/skill-registry-client.ts`

   Add fields such as:

   - `registryAction`
   - `registryResource`
   - `registryScope`
   - `status`

   Do not include tokens, full signed URLs, secrets, or local private paths beyond existing safe identifiers.

2. Classify optional vs required 404s in materialization.

   Status: first slice done for workspace skill-set vs required package 404.

   File target:

   - `packages/server/src/routes/skill-materialization.ts`

   Behavior:

   - missing optional registry subresource should return degraded-but-non-blocking with clear detail;
   - missing required workspace skill-set/package should still be distinguishable;
   - do not block app runtime/start/send from degraded skill registry state.

3. Surface grouped non-blocking degraded state.

   Status: route-level payload and existing logs now receive scrubbed action/resource/scope; grouped UI surfacing is deferred.

   File target:

   - `packages/app/src/app/context/workspace-skill-materialization.ts`

   Behavior:

   - keep current non-blocking return path;
   - include scrubbed degradation detail in trace/log payload;
   - avoid repeated noisy identical diagnostics;
   - do not add a new user-facing UI surface in this slice unless it reuses an existing diagnostic outlet.

Tests to add/update:

- done: `skill-registry-client` test for scrubbed workspace skill-set error context;
- done: server route tests for registry 404 returning scrubbed action/resource/scope;
- done: server route test proving workspace skill-set 404 remains degraded/non-blocking;
- done: server route test proving missing required package 404 remains distinguishable and is not masked as workspace unavailable;
- deferred: app context test proving degraded skill registry does not block runtime readiness/send, only if app behavior is changed.

Verification:

```powershell
pnpm --filter veslo-server exec bun test src/tests/skill-registry-client.test.ts src/tests/server.skill-materialization.test.ts
```

Results:

- 53/53 pass for skill registry client and server skill materialization route tests.

### Phase 4: Reduce Managed AI routing/formatting churn

Status: guard/reset slice done; trace-only formatting guard done.

Goal: keep managed routing correct while making no-op format/heal paths quiet and idempotent.

Implementation steps:

1. Add a desired route fingerprint.

   File targets:

   - `packages/app/src/app/context/managed-ai-runtime-config.ts`

   Fingerprint inputs:

   - server base URL
   - server/client token identity hash, not raw token
   - provider id/model list
   - target route base URL

   Status: done for inactive-heal routing/config. The fingerprint intentionally includes only inputs that affect the desired inactive-heal config or authorization boundary; workspace identity stays in the existing `inactiveWorkspaceBaseUrlHealedFor` map key.

2. Extend inactive workspace heal guard.

   File target:

   - `packages/app/src/app/context/managed-ai-runtime-config.ts`

   Behavior:

   - use the existing `inactiveWorkspaceBaseUrlHealedFor` owner and widen its key to the route fingerprint;
   - skip inactive heal when the workspace was already healed for the same route fingerprint;
   - invalidate on server token/baseUrl/provider/workspace-list changes;
   - keep active workspace sync responsive.

   Status: done. The managed access reset effect now separates config tracking reset from auth-prime reset, so profile metadata-only changes no longer clear inactive-heal tracking while auth-prime cache remains conservative.

3. Make routing traces decision-based.

   File target:

   - `packages/app/src/app/lib/opencode.ts`

   Behavior:

   - trace actual patch, skip, repair, or heal decision;
   - avoid `apply-gateway-provider-routing:start/done` for pure formatting where no patch/write can happen;
   - preserve enough detail to audit model headers and route base URL without logging secrets.

   Status: done for pure managed config formatting. `applyGatewayProviderRouting()` keeps trace behavior by default for direct diagnostic use, and `formatManagedAiAccessConfig()` opts out because it is used by compare/heal/generate paths where no write decision has happened yet.

Tests to add/update:

- `packages/app/src/app/tests/context/managed-ai-runtime-config.test.ts`
  - done: managed config runtime test proving inactive heal skips metadata-only managed access refreshes for the same desired config fingerprint;
  - done: regression coverage proving a real model-list change invalidates the guard and heals again.
- `packages/app/src/app/tests/lib/provider-routing.test.ts`
  - existing coverage retained for provider routing output and semantic comparison.
- `packages/app/src/app/tests/lib/ai-access.test.ts`
  - done: trace test proving pure managed config formatting does not emit routing start/done spam.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/managed-ai-runtime-config.test.ts src/app/tests/app-managed-ai-config-sync-contract.test.ts src/app/tests/app-managed-ai-bootstrap-gate.test.ts src/app/tests/lib/ai-access.test.ts src/app/tests/lib/provider-routing.test.ts
```

Results:

- 54/54 pass for the focused AI access plus provider-routing trace/output subset after the trace-only slice.
- Covered by the current 296/296 combined UI validation for Managed AI runtime config, bootstrap/config-sync contracts, AI access, provider routing, and surrounding session-flow contracts.

### Phase 5: Bounded active-session live-read recovery

Status: bounded active-visible recovery slice done; app-level active-visible opt-in validation done.

Goal: keep background reads passive, but avoid blank active sessions when the server is disconnected and offline transcript is unavailable.

Implementation steps:

1. Add explicit read intent policy.

   File target:

   - `packages/app/src/app/context/conversation-service.ts`

   Behavior:

   - `live-read` remains passive for background/non-visible reads;
   - active visible selected session may request one bounded server recovery start;
   - recovery start should be idempotent per session/workspace for a short window.
   - no read path may become write/send authority.

   Status: done in `conversation-service.ts`. The default `live-read` path still declines server startup unless the caller passes an explicit active visible selected-session opt-in.

2. Pass active/visible context from caller.

   Candidate file targets:

   - `packages/app/src/app/app.tsx`
   - `packages/app/src/app/context/session-route-sync.ts`

   Keep the signal narrow: selected session id, workspace id, and whether this is the visible session. Do not infer write authority from this read path.

   Status: done for `loadOfflineTranscript` in `app.tsx`. Passive latest-session DB hydration still calls transcript read without the recovery opt-in.

3. Trace recovery decisions.

   Expected event outcomes:

   - `server-start-declined` for background passive reads;
   - `server-start-recovery-attempt` for active visible selected session;
   - `server-start-recovery-skipped` when bounded/idempotent guard suppresses a repeat.

   Status: done for the first service-level slice.

Tests to add/update:

- `packages/app/src/app/tests/context/conversation-service.test.ts`
- done: default `live-read` does not start the local server without active recovery opt-in;
- done: active visible transcript read can start the local server once;
- done: duplicate active visible recovery attempts are bounded and traced;
- done: existing browse/status passive read tests still prove background reads do not start the server;
- done: app source-contract test proving visible selected-session transcript reads pass the opt-in and background latest-session hydration stays passive.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-send-latency-trace.test.ts
```

Results:

- 30/30 pass for conversation service read/write boundary tests.
- 21/21 pass for app send-latency/source contracts including active-visible transcript recovery opt-in.

## Runtime Validation And Release Portability

Goal: prove each completed slice survives normal dev startup and is not local-machine-only. Run the Phase 0/1 subset for the immediate KISS slice; add Phase 2-5 commands only when that deferred workstream is actively implemented.

Immediate Phase 0/1 commands:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/provider-routing.test.ts src/app/tests/context/workspace-send-target.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/context/workspace-session-selection.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-selection-controller.test.ts src/app/tests/context/conversation-service.test.ts
git diff --check
```

Deferred workstream add-on commands:

```powershell
# Phase 3 only, when skill-registry diagnostics are actively implemented.
pnpm --filter veslo-server test -- skill-materialization

# Phase 2 scheduler slice.
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/workspace-runtime-schedulers.test.ts src/app/tests/app-send-latency-trace.test.ts

# Phase 4 Managed AI routing/heal dedupe and trace-only formatting guard.
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/managed-ai-runtime-config.test.ts src/app/tests/app-managed-ai-config-sync-contract.test.ts src/app/tests/app-managed-ai-bootstrap-gate.test.ts src/app/tests/lib/ai-access.test.ts src/app/tests/lib/provider-routing.test.ts

# Phase 5 bounded active-visible live-read recovery and app opt-in wiring.
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/app-send-latency-trace.test.ts
```

Manual/dev runtime validation:

```powershell
node .\scripts\dev-with-force-sidecars.mjs
```

Post-run log expectations:

- no `MaxListenersExceededWarning`;
- no `spawnSync pnpm.cmd EINVAL`;
- no `invalid_desktop_diagnostics_event`;
- shared non-sandbox engine still selected when requested;
- `/opencode/event` remains low churn and shutdown closes stay nonfatal;
- Phase 1 traces include concrete scope/fallback/reset reasons where applicable.

Deferred post-run expectations:

- Phase 2: `/opencode/mcp` calls are bounded by fingerprint changes and explicit refreshes, not reactive churn.
- Phase 3: `workspace-skill-materialization` degraded events include scrubbed registry action/resource/scope.
- Phase 4: `apply-gateway-provider-routing` traces represent actual decisions, not repeated pure formatting.
- Phase 5: active visible selected-session live-read recovery is visible only when offline transcript is unavailable.

Latest automated validation for this implementation pass:

- 296/296 pass for the combined UI targeted slice covering Phases 1-5.
- 53/53 pass for server skill-registry and skill-materialization diagnostics.
- UI typecheck passed: `pnpm --filter @neatech/veslo-ui exec tsc --noEmit --pretty false`.
- Server typecheck passed: `pnpm --filter veslo-server exec tsc --noEmit --pretty false`.
- Targeted `git diff --check` passed for the touched files, with only normal LF/CRLF warnings.

Release portability check:

- no new required local `.env` keys;
- no machine-specific absolute paths in code/tests/docs except fixture paths;
- behavior lives in tracked source files and tests;
- GitHub Actions build paths do not require developer-local runtime flags.

## Slice Acceptance Criteria

Phase 0 completed criteria:

- Existing-session send with no hydrated browse scope but with explicit non-active send-target scope activates that workspace before server submit.
- Existing-session send with neither browse scope nor send-target scope does not silently treat active workspace as authoritative conversation scope.
- New/pending session send still works through its pending draft or pending sidebar workspace scope.
- Foreign-workspace selected session remains ignored or blocked according to existing send contract; no implicit active-workspace write is introduced.
- Managed config compare no longer reports mismatch only because parsed JSON object key order differs.

Phase 1 acceptance:

- Remaining `sendPrompt:scoped-workspace-skipped-no-scope` events say whether browse scope, send-target scope, active workspace, and selected session were present.
- Hard-block diagnostics appear only when both hydrated browse scope and authoritative send-target scope are missing for an existing-session send.
- Any remaining `run-state:reset` event has a concrete reason.
- Transcript fallback traces distinguish DB/read-policy fallback, true client unavailability, empty offline transcript, and active-session recovery.

Phase 2 acceptance:

- Equivalent MCP entries/config do not bump the app's MCP refresh fingerprint.
- Session capabilities do not reload solely because the same MCP entries were re-applied.
- Explicit user refresh remains immediate and is not skipped by auto-refresh dedupe.
- Auto refresh is coalesced by debounce and suppressed for the same workspace/project target inside a bounded TTL.
- `/opencode/mcp` calls are bounded by material changes, TTL expiry, or explicit refreshes before adding caller tracing.

Phase 3 acceptance:

- Skill registry degraded results identify the scrubbed failing registry action/resource/scope.
- Optional registry 404s stay degraded/non-blocking.
- Required missing workspace skill-set/package failures remain distinguishable.
- No tokens, signed URLs, or private local paths are added to diagnostic payloads.

Phase 4 acceptance:

- Done: Managed AI inactive heal reuses the existing inactive-heal owner and skips already-healed workspaces for the same desired route/config fingerprint.
- Done: metadata-only managed access refreshes do not clear inactive-heal config tracking.
- Done: real model-list changes invalidate the guard and heal again.
- Done: no-op Managed AI formatting does not emit repeated route start/done traces.
- Deferred: dedicated token/baseUrl/provider-change characterization tests.

Phase 5 acceptance:

- Done: characterization tests prove default/background `live-read` remains passive and does not start the server.
- Done: active visible selected-session transcript recovery can start the server at most once per bounded session/workspace/directory window when the read would otherwise decline.
- Done: read-only transcript recovery does not become write/send authority; it only resolves a read client and then performs the existing transcript read path.
- Done: app-level source contract proves visible selected-session transcript reads pass the recovery opt-in and background latest-session hydration remains passive.

## Additional Targeted Test Checklist

Phase 1 session scope and transcript:

- `ensureSelectedSessionWorkspaceActiveForSend()` returns `false` only when both browse scope and authoritative send-target scope are missing.
- existing-session server submit either receives explicit target scope or emits a clear diagnostic before any active-workspace fallback is used.
- first/new session send still uses pending draft/sidebar workspace scope.
- route/sidebar opened sessions still call `setSessionBrowseScope()` before selection.
- `offline-transcript-fallback` trace names distinguish DB read policy from actual client unavailable fallback.

Phase 2 MCP refresh:

- `mcp-server-refresh` proves equivalent entries do not bump refresh fingerprint.
- session capabilities use a stable MCP entries/config fingerprint rather than timestamp churn.
- explicit user refresh bypasses auto-refresh dedupe.
- `workspace-runtime-schedulers` proves auto refresh target keys are stable and same-target refreshes are suppressed inside TTL.

Phase 3 skill registry:

- skill registry 404 degraded state is visible as non-blocking runtime diagnostic.
- skill materialization route includes scrubbed action/resource/scope when registry 404 is converted to degraded.

Phase 4 Managed AI routing:

- Managed AI inactive heal skips already-healed workspaces for the same desired route/config fingerprint.
- metadata-only managed access refresh does not clear inactive-heal config tracking.
- real model-list changes still trigger repair/patch.
- no-op Managed AI formatting does not emit repeated route start/done traces.
- deferred: real token/baseUrl/provider changes have dedicated characterization tests.

Phase 5 active live-read recovery:

- active visible selected-session `live-read` can perform one bounded recovery start when transcript fallback would otherwise be unavailable.
- repeated active visible selected-session `live-read` attempts inside the bounded window do not start duplicate recovery.
- background/non-visible `live-read` still emits the passive decline path.
- app-level source contract keeps recovery opt-in scoped to `loadOfflineTranscript`, not background latest-session hydration.
