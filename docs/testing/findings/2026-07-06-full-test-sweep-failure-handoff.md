# Veslo full test sweep failure handoff - 2026-07-06

This document summarizes the failures found during the broad Veslo test sweep and
the follow-up triage. It is intended as a handoff for another agent or developer
to continue with fixes.

The findings below are grouped by the tests that exposed them. Each item includes
the observed symptom, likely cause, confidence level, suggested fix, and whether
it looks like a product bug, stale test, or environment/harness issue.

## Scope and assumptions

- Target repo: `/Users/vaclavsoukup/AI agent projects/Veslo`
- Authoritative runtime under test: Tauri desktop app under `packages/desktop`
- Authoritative internal desktop E2E path: `packages/e2e` with `tauri-pilot`
- `packages/web` / raw Vite UI-only runtime is out of scope for validation.
- Legacy WebdriverIO UI tests are historical and should not be treated as the
  current desktop gate unless converted to `tauri-pilot`.
- `test:pilot` without explicit scenarios only runs a limited default set
  (`smoke` / `navigation`), not the complete desktop E2E surface.
- Some timeout failures may be caused by running many suites sequentially. They
  should be rerun in isolation before making product changes.

## Executive summary

The failures fall into five broad root-cause groups:

1. Runtime streaming / lifecycle handling
   - Affects OpenCode proxy streaming, AI gateway streaming, model retry flows,
     event subscription cleanup, and likely some Pilot timeouts.
   - This is the highest-risk technical group because it can break real agent
     messaging and streamed responses.

2. Workspace/session context propagation
   - Affects session directory switching, workspace moves, pending session
     isolation, unpublished drafts, and sidebar session retention.
   - Highest-risk concrete bug: commands can write into the old workspace folder
     after a directory switch.

3. Stale source-contract tests after refactor/localization
   - Affects server route count tests, cloud/local UI guard tests, dashboard
     source guards, and possibly auth/onboarding guard tests.
   - Some of these are likely test fixes, not product fixes.

4. Desktop readiness and orchestration
   - Affects `core-platform-skills`, `skills-enabled-state`,
     `startup-sidebar-existing-sessions`, and several timeout-heavy Pilot tests.
   - Needs isolated reruns with stronger readiness markers.

5. Environment / legacy harness issues
   - Affects WDIO, Den integrated Playwright tests, and opencode-router smoke.
   - These should be separated from product bug reporting.

## Severity model used here

- P0: Can corrupt or mutate user work in the wrong place, or break core streamed
  agent execution.
- P1: Can break important runtime flows such as auth, onboarding, permissions,
  skills, sidebar/session state, or desktop E2E workflows.
- P2: User-facing quality issue, stale contract, flaky readiness, or important
  test harness gap.
- P3: Legacy/obsolete/environment-only issue with no current product bug proven.

## Shared root causes

### 1. Streaming and abort semantics are not cleanly separated

Several tests point to a shared issue where streaming request/response bodies are
not treated as long-lived streams. A headers timeout appears to affect the
streamed body, and request-body forwarding appears buffered rather than
incremental.

Likely affected tests:

- `server-test`: OpenCode proxy headers timeout
- `server-test`: AI gateway request body streaming
- `model-stream-retry-no-progress`
- `loopback-request-broker-idle`
- `app-test-events`

Suggested work package:

- Create a minimal Bun streaming reproduction before changing production code.
- Separate "headers did not arrive" timeout from "response body stream is still
  open" lifetime.
- Ensure request bodies passed through AI gateway are not consumed by diagnostic
  code before being forwarded.
- Add tests that assert first upstream chunk arrival before client upload
  completion.

### 2. Workspace/session identity can drift

The strongest evidence is the directory-switch test: after switching the target
directory, a command writes into the old directory. Pilot failures around drafts,
pending sessions, sidebar retention, and workspace moves likely share the same
class of bug.

Likely affected tests:

- `app-test-session-directory-switch`
- `composer-draft-workspace-move`
- `global-unpublished-draft`
- `pending-session-instance-isolation`
- `sidebar-session-retention`
- `startup-sidebar-existing-sessions`

Suggested work package:

- Define one authoritative identity tuple for workspace/session/draft/run.
- Ensure shell/run calls use current workspace directory, not the original
  session directory by accident.
- If OpenCode sessions cannot safely change working directory, create a new
  session/run context when the workspace changes.
- Add invariant tests that verify commands never write into the previous
  workspace after a move/switch.

### 3. Some tests still assert source shape instead of behavior

Multiple guard tests look for raw strings, old helper names, or old route counts.
Those tests are brittle after refactors and localization work.

Likely affected tests:

- `app-test-cloud-policy`
- `app-test-cloud-ui-guards`
- `app-test-local-ui-guards`
- `app-test-desktop-auth-onboarding`
- `app-test-unit` dashboard source guard
- `server-test` skill route contract counts

Suggested work package:

- Convert source-string guards into behavior tests wherever possible.
- Where a source guard is still useful, anchor it on stable exported behavior,
  not nearby unrelated text or exact localized copy.

### 4. Desktop readiness is not explicit enough

Several Pilot failures seem to wait for UI/runtime state that may not be ready or
may never be signaled deterministically.

Likely affected tests:

- `core-platform-skills`
- `skills-enabled-state`
- `google-mcp-connectors`
- `soul-dashboard`
- `soul-den-local`
- `startup-sidebar-existing-sessions`

Suggested work package:

- Add stable readiness/snapshot signals for engine, skills registry, connector
  catalog, sidebar sessions, and Soul runtime availability.
- Make Pilot scenarios wait for those signals instead of indirect UI timing.

## Findings by test suite

## Tauri Pilot desktop E2E

### Broad `.toml` scenario sweep

Observed result:

- 12 scenarios passed.
- 16 scenarios failed.
- 1 scenario skipped.

Failing scenarios:

- `automations`
- `composer-draft-workspace-move`
- `global-unpublished-draft`
- `google-mcp-connectors`
- `loopback-request-broker-idle`
- `message-send-registry-degraded`
- `model-stream-retry-no-progress`
- `pending-session-instance-isolation`
- `sidebar-context-menu`
- `sidebar-session-retention`
- `skills-enabled-state`
- `soul-dashboard`
- `soul-den-local`
- `startup-sidebar-existing-sessions`
- `vslo-235-local-host-no-workspace`
- `vslo-270-stop-reload-reconnect`

#### `automations`

Severity: P1 until isolated.

Type: possible product bug or timeout/orchestration issue.

Observed symptom:

- Scenario failed during the broad Pilot sweep.
- Failure was timeout-heavy, so the product bug is not yet proven.

Likely cause:

- Could be suite pressure from running many Pilot scenarios one after another.
- If it reproduces in isolation, it likely belongs to runtime readiness or
  automation state lifecycle.

Suggested fix:

- Rerun this scenario alone with extended timeout and timestamped trace markers.
- If isolated failure reproduces, inspect automation state transitions and the
  readiness condition the test waits for.

#### `composer-draft-workspace-move`

Severity: P1.

Type: likely product bug.

Observed symptom:

- Scenario failed in the broad Pilot sweep.

Likely cause:

- Belongs to the same family as the concrete directory-switch bug. Draft state
  likely remains attached to the old workspace/session identity after a
  workspace move.

Suggested fix:

- Make draft ownership explicit by workspace id and session id.
- On workspace move, either migrate draft ownership deterministically or clear
  invalid drafts.
- Add assertions that a moved workspace does not show or submit a draft from the
  previous workspace.

#### `global-unpublished-draft`

Severity: P1.

Type: likely product bug if isolated failure reproduces.

Observed symptom:

- Scenario failed during broad Pilot sweep.

Likely cause:

- Unpublished draft state may be global or insufficiently scoped. It may leak
  between workspaces, sessions, or startup restoration boundaries.

Suggested fix:

- Scope unpublished draft state to the active workspace/session identity.
- Add startup/restore tests that prove drafts do not appear in unrelated
  sessions.

#### `google-mcp-connectors`

Severity: P1/P2.

Type: possible product bug, possibly readiness/test fixture drift.

Observed symptom:

- Scenario failed during broad Pilot sweep.

Likely cause:

- Connector catalog or registry fixture may not be available when the UI expects
  it.
- Current working tree had changes in MCP connector workflow and e2e fixtures,
  so this area may already be under active modification.

Suggested fix:

- Rerun isolated with catalog readiness logging.
- Ensure the UI reads from one stable connector capability source.
- Ensure fixtures expose the same shape as production connector catalog data.

#### `loopback-request-broker-idle`

Severity: P1 until isolated.

Type: possible runtime lifecycle bug.

Observed symptom:

- Scenario failed during broad Pilot sweep.

Likely cause:

- Likely related to idle broker lifecycle or request cleanup.
- Could share root with streaming/abort handling.

Suggested fix:

- Rerun isolated with broker state logs.
- Verify idle broker shutdown does not abort active streams and does not leave
  pending promises that block the test.

#### `message-send-registry-degraded`

Severity: P2.

Type: likely Pilot scenario/test bug.

Observed symptom:

- Scenario failed during broad Pilot sweep.
- The scenario eval script appears to contain async logic in a shape Pilot CLI
  may not safely auto-wrap.

Likely cause:

- Test script structure, not necessarily app behavior.

Suggested fix:

- Wrap the whole eval in an explicit async IIFE.
- Prefer moving complex scenario logic into a helper function instead of keeping
  a large inline eval block.

#### `model-stream-retry-no-progress`

Severity: P1.

Type: possible product bug.

Observed symptom:

- Scenario failed during broad Pilot sweep.

Likely cause:

- Likely tied to streaming retry state. If the model stream makes no progress,
  the app may not transition into a retryable or terminal state.
- Shares suspicion with server streaming/abort failures.

Suggested fix:

- Rerun isolated with stream lifecycle markers: stream opened, first chunk,
  no-progress timeout, retry scheduled, retry started, terminal state.
- Fix the state transition that fails to fire.

#### `pending-session-instance-isolation`

Severity: P1.

Type: likely product bug if isolated failure reproduces.

Observed symptom:

- Scenario failed during broad Pilot sweep.

Likely cause:

- Pending sessions may not be isolated by instance/workspace identity.
- Related to workspace/session context drift.

Suggested fix:

- Make pending session identity explicit and include workspace id.
- Add assertions that pending state from one instance cannot appear in another.

#### `sidebar-context-menu`

Severity: P2.

Type: uncertain; current working tree had a deleted TOML scenario and a new Pilot
spec for sidebar context menu.

Observed symptom:

- Scenario failed in broad sweep.
- Current tree shows changes around sidebar context menu test files, suggesting
  the area may already be migrating from `.toml` to Pilot spec.

Likely cause:

- Could be test migration drift or a real sidebar interaction regression.

Suggested fix:

- Decide which test format is authoritative.
- Keep one current sidebar context-menu test and remove/retire the obsolete
  duplicate.
- Rerun the current test alone.

#### `sidebar-session-retention`

Severity: P1/P2.

Type: possible product bug.

Observed symptom:

- Scenario failed during broad Pilot sweep.

Likely cause:

- Sidebar may render before restored sessions are loaded or may not persist
  active session selection correctly.

Suggested fix:

- Add explicit sidebar session-list readiness state.
- Ensure persistence restore runs before the testable "ready" marker.

#### `skills-enabled-state`

Severity: P1/P2.

Type: possible readiness/capability source bug.

Observed symptom:

- Scenario failed during broad Pilot sweep.

Likely cause:

- Skills enabled/disabled state may be read from multiple sources or before the
  authoritative registry is ready.

Suggested fix:

- Use one capability snapshot for skills enabled state.
- Expose a ready marker for Pilot tests.

#### `soul-dashboard`

Severity: P2.

Type: possible readiness/test expectation issue.

Observed symptom:

- Scenario failed during broad Pilot sweep.

Likely cause:

- Soul runtime availability may not be reported consistently to the dashboard.
- There was also a separate app unit source guard failure around dashboard
  runtime availability anchoring.

Suggested fix:

- Verify real dashboard behavior first.
- If behavior is correct, update brittle source guard.
- If behavior is wrong, centralize Soul runtime availability state.

#### `soul-den-local`

Severity: P2.

Type: possible environment/readiness issue.

Observed symptom:

- Scenario failed during broad Pilot sweep.

Likely cause:

- Local Den/Soul runtime availability may not be started or reported
  deterministically.

Suggested fix:

- Add explicit local Den/Soul preflight in the scenario.
- Expose a visible unavailable state rather than waiting indefinitely.

#### `startup-sidebar-existing-sessions`

Severity: P1/P2.

Type: possible product bug or startup race.

Observed symptom:

- Scenario failed during broad Pilot sweep.

Likely cause:

- Existing sessions may not be restored before sidebar assertions run.

Suggested fix:

- Add startup restoration ready marker.
- Ensure sidebar rendering after startup consumes restored sessions from the
  authoritative store.

#### `vslo-235-local-host-no-workspace`

Severity: P2.

Type: likely stale test expectation.

Observed symptom:

- Test expects `/status` `workspaceCount === 0` and `/workspaces` empty.
- Observed runtime reports a scratch/default workspace instead.

Likely cause:

- Product behavior changed: local host now starts with a scratch workspace even
  when no explicit workspace is selected.

Suggested fix:

- Confirm product decision.
- If scratch workspace is correct, rename/update the scenario and assert the new
  scratch fallback.
- If zero workspace is still the desired behavior, prevent scratch autostart in
  this mode.

#### `vslo-270-stop-reload-reconnect`

Severity: P2/P3.

Type: uncertain; likely legacy or scenario-specific.

Observed symptom:

- Scenario failed during broad Pilot sweep.

Likely cause:

- Prior sweep notes classify nearby `vslo-270` relaunch/reconnect coverage as
  legacy/obsolete unless converted to current Pilot runtime expectations.

Suggested fix:

- Re-evaluate whether this scenario still maps to current desktop lifecycle.
- If still relevant, rerun isolated and update it to current Tauri/Pilot startup
  semantics.

### Named Pilot runs

#### `plugins-policy`

Observed result:

- Passed.

Action:

- Do not include as a current bug.

#### `core-platform-skills`

Severity: P1.

Type: possible product readiness bug or test wait-condition issue.

Observed symptom:

- App starts.
- Engine startup reaches `ensure-engine:start-host:start`.
- Then `tauri-pilot --json eval` fails.
- Error included `RPC error (-32603): Eval error: eval timed out after 10s`.

Likely cause:

- Skills/platform inventory readiness is not deterministically exposed to the
  test.
- The UI may be waiting on a background initialization that does not complete
  within the eval window.

Suggested fix:

- Add a stable runtime readiness signal for platform skills.
- Make the test wait for that signal rather than an arbitrary eval timeout.
- If the readiness signal never fires, inspect skills registry initialization.

#### `wsl-direct-fallback`

Severity: P1/P2.

Type: platform-specific product or test issue.

Observed symptom:

- Test failed with no latest snapshot:
  `Engine snapshot did not report direct childKind. Latest=null`.

Likely cause:

- Direct fallback state is not emitted/persisted, or the test is running on a
  platform where WSL-specific behavior is not meaningful.

Suggested fix:

- Gate the test on platform capability if WSL fallback cannot be valid here.
- Otherwise make fallback child kind observable through the same snapshot source
  used by the UI.

## App tests and scripts

### Direct reruns that passed

The following passed when rerun directly and should not be handed off as product
bugs:

- `test:sessions`
- `test:session-switch`
- `test:fs-engine`

Interpretation:

- Any earlier failure for these was likely broad-suite orchestration, resource
  pressure, or timeout contamination.

### `app-test-session-directory-switch`

Severity: P0.

Type: product bug.

Observed symptom:

- Test creates a session in `dirA`.
- Test copies/switches context to `dirB`.
- A shell command is executed with `directory: dirB`.
- Assertion fails because the command writes into the old folder.
- Failure text included:
  `command must not write into the old folder; true !== false`.

Likely cause:

- The shell/session command path ignores the per-command directory override or
  reuses an OpenCode session bound to the original directory.

Why this matters:

- This can mutate user files in the wrong workspace.
- It is the most concrete high-severity bug found.

Suggested fix:

- Ensure all shell/run calls use the current workspace directory at execution
  time.
- If the underlying session cannot safely change directories, create a new
  session/run context for the target workspace.
- Add a regression test that verifies no file appears in the old directory.

### `app-test-unit`

Observed result:

- 7 failures.

#### Pending permission/question modal fallback

Severity: P1.

Type: product bug or partially intentional behavior with unsafe fallback.

Observed symptom:

- Tests expected no permission/question modal when no real session is selected.
- Current logic can still surface pending permission state.

Likely cause:

- Current logic has a special case for active workspace folder access without a
  selected session, then falls through to generic pending permission fallback.

Suggested fix:

- Keep the active folder-access exception only if it is intended.
- Return `null` for all other pending permissions/questions when there is no
  selected session.
- Update tests to encode this distinction.

#### Missing refresh workspace config handler in session view

Severity: P1/P2.

Type: uncertain; possible stale test after refactor.

Observed symptom:

- Test expected session view to receive `refreshWorkspaceConfigForPath`.

Likely cause:

- Handler was moved, renamed, or no longer passed through the same prop path.

Suggested fix:

- Verify actual UI behavior: can the session view still refresh workspace config
  for the active path?
- If yes, convert the test to behavior-level verification.
- If no, restore the handler path.

#### Missing respond permission handler in session view

Severity: P1.

Type: possible product bug.

Observed symptom:

- Test expected `respondPermissionForSessionView` wiring for synthetic E2E folder
  permissions.

Likely cause:

- Permission response handling may have moved or been dropped from the session
  view path.

Suggested fix:

- Verify a real permission prompt can be accepted/denied from the session view.
- Restore handler wiring if behavior is broken.
- Prefer E2E assertion over source-shape assertion.

#### Elapsed run indicator

Severity: P2.

Type: product decision or stale test.

Observed symptom:

- Test expected a session run elapsed-time indicator rendered for users.
- UI did not expose the expected indicator or format.

Likely cause:

- Indicator may be gated by a developer/debug state, changed format, or removed.

Suggested fix:

- Decide whether elapsed run time is a product requirement.
- If yes, render it consistently and localize the label.
- If no, remove or update the test expectation.

#### Session page modularization guard

Severity: P2.

Type: architecture guard drift or real boundary violation.

Observed symptom:

- Test reported unexpected/unplanned modules in session page modularization.

Likely cause:

- Refactor changed module boundaries without updating the guard, or code drifted
  across intended boundaries.

Suggested fix:

- Review current modularization plan.
- Either update the allowlist intentionally or move code back behind the expected
  boundary.

#### Settings sandbox toggle

Severity: P1/P2.

Type: product UX/safety issue.

Observed symptom:

- Test expected a positive `Sandbox` toggle.
- Current UI exposes "Shared unsandboxed engine" style copy and environment
  variable details.

Likely cause:

- Settings model is currently expressed as an inverse unsafe flag rather than a
  positive safety mode.

Suggested fix:

- Present a positive `Sandbox` toggle in UI.
- Internally map the old inverse flag if compatibility is needed.
- Avoid exposing low-level env-var copy in the primary settings UI.

#### Dashboard runtime availability source guard

Severity: P2/P3.

Type: likely stale brittle test.

Observed symptom:

- Test expected a source range anchored near a specific symbol.
- The relevant fallback behavior still appears to return a safe false value, but
  the source anchor no longer exists in the expected place.

Likely cause:

- Source layout changed.

Suggested fix:

- Replace source-range guard with a behavior test for runtime availability.

### `app-test-events`

Severity: P1.

Type: test/runtime lifecycle bug.

Observed symptom:

- Direct rerun hung and had to be interrupted.

Likely cause:

- Event subscription stream may not be canceled.
- OpenCode server/child process may not close after the test.
- Async iterator may keep the event loop alive.

Suggested fix:

- Add explicit subscription cancellation / `AbortSignal`.
- Ensure stream reader is returned/canceled.
- Ensure cleanup kills the full child process group if graceful close does not
  finish.

### `app-test-todos`

Severity: P1/P2.

Type: possible API contract or cleanup bug.

Observed symptom:

- Direct rerun hung and had to be interrupted.

Likely cause:

- Todo endpoint call may never return under current OpenCode API behavior.
- Or the spawned server/child process is not cleaned up.

Suggested fix:

- Add per-request timeout around todo API call.
- Verify current OpenCode todo endpoint contract.
- Reuse the same hardened process cleanup as `app-test-events`.

### `app-test-cloud-policy`

Severity: P1/P2.

Type: possible stale source guard or real policy regression.

Observed symptom:

- Test expected server settings to merge env values through the cloud policy
  helper.
- It no longer found the expected helper name.

Likely cause:

- Helper was renamed/moved, or the merge path was bypassed.

Suggested fix:

- Verify behavior by testing resulting config under local/cloud env conditions.
- If behavior is correct, update the test away from helper-name matching.
- If behavior is wrong, restore the policy merge path.

### `app-test-local-ui-guards`

Severity: P2.

Type: possible stale UI guard or real action regression.

Observed symptom:

- Test expected workspace list to expose the new-session primary action.
- It no longer found the expected localized key/string.

Likely cause:

- The action was renamed, moved, localized differently, or removed.

Suggested fix:

- Verify in real UI that a user can create a new session from the workspace list.
- Update test to assert behavior or localization key, not raw source text.

### `app-test-ui-localization`

Severity: P2.

Type: product quality issue.

Observed symptom:

- 53 production UI literals were reported.
- Examples included:
  - `Sandbox debug details`
  - `Esc`
  - `Engine ready - switching is instant`
  - `Pending permission request`
  - `TEMP UI render source`
  - `Document runtime`
  - `Shared unsandboxed engine`
  - `Sets`
  - `VESLO_DISABLE_SANDBOX`
  - `Runtime sandbox`

Likely cause:

- Some new UI was added without i18n keys.
- Some diagnostic/debug strings are visible to the production scan.
- Some settings copy exposes implementation details.

Suggested fix:

- Remove temporary debug render source text.
- Convert production UI copy to i18n keys.
- Gate developer-only diagnostics explicitly, or add a narrow allowlist with
  justification.

### `app-test-cloud-onboarding`

Severity: P1.

Type: possible product bug.

Observed symptom:

- Router did not enter onboarding route when language step was active.

Likely cause:

- Onboarding route guard no longer considers the language step state, or the
  state shape changed.

Suggested fix:

- Run a focused fresh cloud onboarding flow.
- Restore route guard behavior for active language step if broken.
- Prefer E2E coverage for the full onboarding transition.

### `app-test-cloud-ui-guards`

Severity: P2/P3.

Type: likely stale localization/source guard.

Observed symptom:

- Test expected cloud-only banner copy as raw source text.
- Current source appears to use localized keys for at least part of that copy.

Likely cause:

- Guard was not updated after localization.

Suggested fix:

- Assert the localization key or rendered behavior instead of raw English copy.

### `app-test-desktop-auth-onboarding`

Severity: P1.

Type: possible product bug or stale source guard.

Observed symptom:

- Test expected app wiring to import/use auth complete deep-link parsing.

Likely cause:

- Parser moved/renamed, or desktop auth callback handling is no longer wired.

Suggested fix:

- Verify real desktop auth callback/deep-link completion.
- If broken, restore parser usage in the current auth flow.
- If behavior works, update the test to assert the callback behavior.

## Server tests

Observed result:

- `server-test` failed 5 tests.

### OpenCode proxy headers timeout

Severity: P0/P1.

Type: possible product bug.

Observed symptom:

- Test expected status `200`.
- Actual status was `502`.
- Scenario: upstream sends first SSE chunk immediately, then another chunk after
  the configured headers timeout window.

Likely cause:

- The proxy headers timeout may still be aborting long-lived streamed bodies.
- Implementation comment says the timeout should only cover headers, but runtime
  behavior indicates the abort can still affect the stream.

Suggested fix:

- Reproduce Bun fetch streaming behavior in isolation.
- Clear the headers timer as soon as response headers are available.
- Do not tie response body lifetime to the headers timeout.
- Add regression test for delayed second SSE chunk.

### AI gateway request-body streaming

Severity: P0/P1.

Type: possible product bug.

Observed symptom:

- Test expected upstream to receive the first request-body chunk before the
  client finished upload.
- Actual result showed upstream did not receive the first chunk early.

Likely cause:

- AI gateway proxy may buffer request body before forwarding.
- Diagnostic/model inspection may accidentally consume or delay the stream.
- Bun/fetch behavior may require a different pass-through pattern.

Suggested fix:

- Ensure the original request body is passed through without pre-reading.
- If diagnostics need the body, use a safe tee only when supported and bounded.
- Add a streaming upload regression test.

### User-global skill route contract

Severity: P2.

Type: stale test.

Observed symptom:

- Test expected 6 routes.
- Actual implementation exposes 8 routes.
- Added routes include file-list/read style endpoints for user-global skills.

Likely cause:

- Route contract test was not updated after adding `files` endpoints.

Suggested fix:

- Update expected route list.
- Add auth/permission assertions for the new `files` endpoints.

### Workspace skill route contract

Severity: P2.

Type: stale test.

Observed symptom:

- Test expected 7 routes.
- Actual implementation exposes 8 routes.
- Added route includes workspace skill files endpoint.

Likely cause:

- Contract test drift after adding `files` endpoint.

Suggested fix:

- Update expected contract.
- Verify workspace scoping/auth behavior for the new route.

### Bridge listener

Severity: P2/P3.

Type: platform/test environment issue or expected fallback behavior.

Observed symptom:

- Test used a specific bridge host address and expected `/health` to respond.
- Server code catches bridge listener bind failure, logs it, and keeps primary
  server alive.
- Test timed out waiting for bridge endpoint.

Likely cause:

- The chosen bridge host is not bindable on this platform.
- Product behavior intentionally treats bridge listener failure as non-fatal.

Suggested fix:

- Use a dynamically verified bindable bridge address in the success test.
- Add a separate test for non-fatal bridge bind failure and diagnostics.

## Playwright and other E2E/UI tests

### `den-admin-billing-lifecycle`

Observed result:

- 9 tests passed.

Action:

- Do not include as a bug.

### `den-admin-billing-integrated`

Severity: P3.

Type: environment/precondition issue.

Observed symptom:

- 3 tests failed.
- Failure was connection refused to `127.0.0.1:8788` during health check.

Likely cause:

- Den backend was not running for the integrated Playwright flow.

Suggested fix:

- Add Playwright global setup to start the backend.
- Or mark the suite as requiring an externally running Den service and skip with
  a clear message when missing.

### `den-admin-billing-stripe-live`

Observed result:

- 1 skipped.

Action:

- Not a current bug from this sweep.

### `live-codex-auth-upload`

Observed result:

- 1 skipped.

Action:

- Not a current bug from this sweep.

### `opencode-router-smoke`

Severity: P3.

Type: test harness/precondition issue.

Observed symptom:

- Failed with connection refused to local router health endpoint on port `4096`.

Likely cause:

- Test assumes opencode-router service is already running.

Suggested fix:

- Make the smoke test start the router itself.
- Or skip with an explicit precondition message when the service is absent.

### `test:e2e:ui` / WebdriverIO

Severity: P3 for current product handoff.

Type: legacy/obsolete test harness.

Observed symptom:

- 30 WDIO workers.
- 0 passed.
- All failed because WebDriver server at `127.0.0.1:4445` was unreachable.

Likely cause:

- Legacy WDIO harness was not running and is not the current authoritative
  desktop runtime path.

Suggested fix:

- Do not treat this as an app bug.
- Convert still-relevant WDIO scenarios to Tauri Pilot.
- Remove WDIO from current gate once coverage is converted.

## Tests or coverage that should not be treated as current bugs

### Passed on direct rerun

- `test:sessions`
- `test:session-switch`
- `test:fs-engine`
- `plugins-policy`
- `den-admin-billing-lifecycle`

### Skipped in sweep

- `den-admin-billing-stripe-live`
- `live-codex-auth-upload`

### Legacy or obsolete unless converted

- WebdriverIO `test:e2e:ui`
- `test:update-baselines`
- older `vslo-270` relaunch/reconnect style coverage unless updated to the
  current Tauri/Pilot desktop lifecycle

## Recommended developer work packages

### Work package 1: Streaming/runtime lifecycle

Priority: P0/P1.

Tests to start with:

- `server-test` OpenCode proxy timeout case
- `server-test` AI gateway streaming case
- `model-stream-retry-no-progress`
- `loopback-request-broker-idle`
- `app-test-events`

Goal:

- Streaming request and response bodies must be passed through incrementally and
  must not be aborted by headers-only timeouts.

Exit criteria:

- SSE response with delayed second chunk stays alive.
- AI gateway upstream receives first request-body chunk before client upload
  finishes.
- Event subscription test exits cleanly.

### Work package 2: Workspace/session context ownership

Priority: P0/P1.

Tests to start with:

- `app-test-session-directory-switch`
- `composer-draft-workspace-move`
- `global-unpublished-draft`
- `pending-session-instance-isolation`
- `sidebar-session-retention`

Goal:

- No command, draft, permission, pending session, or sidebar selection can leak
  across workspace/session identity boundaries.

Exit criteria:

- Commands after directory switch only write to the new directory.
- Drafts and pending sessions are scoped to the intended workspace/session.
- Sidebar restore does not show stale sessions.

### Work package 3: Desktop readiness and registry snapshots

Priority: P1/P2.

Tests to start with:

- `core-platform-skills`
- `wsl-direct-fallback`
- `skills-enabled-state`
- `google-mcp-connectors`
- `soul-dashboard`
- `soul-den-local`

Goal:

- Desktop runtime exposes stable readiness and capability snapshots.

Exit criteria:

- Pilot tests wait on explicit readiness markers.
- Skills/connector/Soul states have one authoritative source.
- Platform-specific tests are gated correctly.

### Work package 4: Source-contract and localization cleanup

Priority: P2.

Tests to start with:

- `app-test-ui-localization`
- `app-test-cloud-policy`
- `app-test-local-ui-guards`
- `app-test-cloud-ui-guards`
- `app-test-desktop-auth-onboarding`
- server route contract tests

Goal:

- Tests assert durable behavior instead of fragile source strings where possible.
- Production UI has no accidental debug text or untranslated literals.

Exit criteria:

- Localization test no longer reports production literals except explicit
  allowlisted diagnostics.
- Route contract tests match current intended routes.
- Auth/onboarding/policy behavior is covered by focused behavior tests.

### Work package 5: Harness/environment cleanup

Priority: P3.

Tests to start with:

- `opencode-router-smoke`
- `den-admin-billing-integrated`
- WebdriverIO `test:e2e:ui`

Goal:

- Environment-dependent suites either start their dependencies or skip with clear
  precondition messages.
- Legacy WDIO coverage is not reported as current desktop E2E failure.

Exit criteria:

- Den integrated tests start/check their backend deterministically.
- opencode-router smoke does not fail with raw connection refused.
- Remaining relevant WDIO scenarios are converted to Tauri Pilot.

## Open questions for developers

1. Should local host with no explicit workspace create a scratch/default
   workspace, or should workspace count remain zero?
2. Is the positive `Sandbox` toggle the intended product language, replacing
   "Shared unsandboxed engine"?
3. Should active workspace folder-access permission be shown when no real
   session is selected?
4. Are `files` skill endpoints now part of the stable public server contract?
5. Should WSL direct fallback tests run on non-Windows/macOS development
   machines, or be platform-gated?
6. Which `vslo-270` reconnect/reload coverage is still valid under current
   Tauri/Pilot lifecycle?

## Suggested next verification order

1. Rerun `app-test-session-directory-switch` and fix first if still failing.
2. Rerun the two failing `server-test` streaming cases and build a minimal Bun
   streaming reproduction.
3. Rerun `app-test-events` and `app-test-todos` with process cleanup tracing.
4. Rerun isolated Pilot scenarios from the workspace/session group.
5. Update stale route/source-contract tests only after confirming behavior.
6. Clean up environment-only failures separately so they stop polluting product
   bug reports.
