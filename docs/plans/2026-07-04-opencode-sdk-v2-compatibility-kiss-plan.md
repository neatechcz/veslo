---
title: OpenCode SDK v2 Compatibility KISS Plan
date: 2026-07-04
status: proposed
done: false
issue: unlinked
source_audit: opencode-sdk-v2-codebase-compatibility-audit-2026-07-04
depends_on:
  - docs/plans/2026-07-04-opencode-shared-starting-state-and-mcp-cold-path-kiss-plan.md
osdk00_baseline_contract_done: false
osdk01_event_normalization_contract_done: false
osdk02_app_v2_permission_question_events_done: false
osdk03_router_permission_v2_bridge_done: false
osdk04_abortable_sdk_waits_done: false
osdk05_prompt_submit_contract_guard_done: false
osdk06_sdk_upgrade_spike_done: false
osdk07_regression_bundle_done: false
---

# OpenCode SDK v2 Compatibility KISS Plan

## Goal

Make Veslo tolerant of the current OpenCode SDK v2 event/request shapes without
rewriting the runtime integration or blindly migrating to documentation examples
that do not match the installed package exports.

The product rule is:

- A user permission/question request emitted by OpenCode must show up in Veslo.
- Veslo must not drop OpenCode events only because they arrive through a v2 or
  sync envelope.
- Router bridges must answer permission requests through supported APIs where
  available.
- Timeout code must cancel the underlying OpenCode request when possible, not
  only race the caller's promise.
- The existing `prompt_async` conversation handoff stays valid until an upgrade
  spike proves a better OpenCode API path end to end.
- SDK package upgrades happen in one explicit compatibility slice across app,
  orchestrator, router, plugin, and lockfile.

## Current Audit Summary

The current repo pins `@opencode-ai/sdk` and `@opencode-ai/plugin` at `1.17.4`.
NPM stable is newer (`1.17.13` at audit time), but the latest stable package
still exposes `createOpencodeClient()` and `event.subscribe()` from
`@opencode-ai/sdk/v2/client`. Context7 docs show newer generated examples such
as `new Opencode(...)` and event-list style APIs, so package `.d.ts` files must
be treated as the implementation source of truth for now.

Relevant current code:

- `packages/app/src/app/utils/messages.ts` normalizes only `raw.type` and
  `raw.payload.type`.
- `packages/opencode-router/src/events.ts` normalizes only `raw.type` and
  `raw.payload.type`.
- `packages/orchestrator/src/cli.ts` has a local event normalizer with the same
  limitation.
- `packages/app/src/app/context/session-event-stream.ts` refreshes
  permissions/questions only for legacy `permission.*` and `question.*` event
  names.
- `packages/app/src/app/context/session-runtime-prompts.ts` lists and replies to
  pending prompts through top-level legacy-compatible SDK clients.
- `packages/opencode-router/src/bridge.ts` handles only `permission.asked` and
  replies through deprecated `permission.respond`.
- `packages/app/src/app/context/session.ts` and
  `packages/orchestrator/src/cli.ts` contain SDK wait paths that can timeout the
  caller without aborting the SDK request.
- The main Veslo conversation submit path goes through
  `packages/server/src/server.ts` to OpenCode `prompt_async`/`command`/`shell`;
  those shapes still exist in the current SDK package.

## KISS Boundary

Core for this plan:

- Add narrow compatibility support for existing and current v2 event shapes.
- Preserve current runtime ownership and conversation-run architecture.
- Add tests before package upgrades so behavior is visible.
- Prefer small local helpers near existing owners over a new cross-package
  abstraction.
- Add short comments only where SDK behavior is non-obvious.

Not core for this plan:

- Replacing Veslo conversation runs with `client.v2.session.prompt`.
- Rewriting OpenCode router architecture.
- Introducing a new event bus.
- Migrating every OpenCode API call to v2 in one change.
- Changing model/provider routing.
- Changing installed runtime startup behavior covered by cold-start plans.
- Running Tauri pilot as a hard gate for this compatibility slice.

## Implementation Status Contract

Every task starts as `done: false`.

Only mark a task `done: true` after code, focused tests, and listed verification
for that task are complete in the original worktree. Do not mark top-level
`done` complete until OSDK00 through OSDK07 are complete and verified.

If a task is partially implemented, append a dated note under that task and
leave its `done: false` line unchanged.

## Coordination Notes For Agents

This checkout is expected to be dirty. Before implementation, verify whether
this file is tracked and visible to the agent's worktree:

```powershell
git ls-files docs/plans/2026-07-04-opencode-sdk-v2-compatibility-kiss-plan.md
git status --short -- docs/plans/2026-07-04-opencode-sdk-v2-compatibility-kiss-plan.md
```

If this file is untracked, do not assume another worktree can see it. Track or
copy the relevant plan text before delegating implementation.

## OSDK00: Baseline Contract Snapshot

done: false

Goal:

Freeze the OpenCode SDK package contract that the rest of this plan is allowed
to rely on.

Implementation:

- Record the current installed and latest stable SDK versions.
- Inspect local package `.d.ts` files for:
  - `createOpencodeClient`.
  - `event.subscribe`.
  - legacy `permission.*` and `question.*`.
  - v2 `permission.v2.*` and `question.v2.*` event types.
  - `syncEvent` event envelope shape.
  - `session.promptAsync`, `session.command`, and `session.shell`.
- If a real issue exists, update `issue:` in front matter.
- Add a short dated note under this task with the exact SDK versions and docs
  links used.

Acceptance:

- The plan records the SDK version snapshot and whether the latest stable
  package actually exposes the APIs being implemented.
- No implementation step depends only on Context7 docs when the NPM package
  disagrees.

Verification:

```powershell
npm view @opencode-ai/sdk version dist-tags --json
rg -n "createOpencodeClient|event\\.subscribe|permission\\.v2|question\\.v2|syncEvent|promptAsync|class Permission2|class Question2" packages/app/node_modules/@opencode-ai/sdk/dist/v2
```

## OSDK01: Event Normalization Contract

done: false

Goal:

Make Veslo normalize the OpenCode event shapes it already depends on:

- Direct event: `{ type, properties }`.
- Payload event: `{ payload: { type, properties } }`.
- Sync event: `{ type: "sync", syncEvent: { type, data } }`.

Implementation:

- Add focused tests for app event normalization in a new file:
  `packages/app/src/app/tests/utils/messages-normalize-event.test.ts`.
- Extend `packages/app/src/app/utils/messages.ts` to handle `syncEvent`.
- Extend `packages/opencode-router/src/events.ts` to handle `syncEvent`.
- Extend the local normalizer in `packages/orchestrator/src/cli.ts` to handle
  `syncEvent`.
- When normalizing `syncEvent.type`, strip only a trailing numeric event schema
  suffix such as `.1` or `.2`; do not rewrite ordinary dotted event names.
- Preserve existing behavior for direct and payload event shapes.
- Add a short comment near the `syncEvent` branch explaining that OpenCode can
  wrap durable v2 events in a sync envelope.

Acceptance:

- Legacy direct and payload events still normalize exactly as before.
- `syncEvent` envelopes produce a normal event type and properties/data payload.
- Invalid or partial sync envelopes still return `null`.
- No package upgrade is required for this task.

Verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/utils/messages-normalize-event.test.ts
corepack pnpm@10.27.0 --filter veslo-orchestrator exec bun test src/tests/opencode-router-contract.test.ts
corepack pnpm@10.27.0 --filter veslo-code-router exec pnpm typecheck
```

If the orchestrator contract test named above does not exist, add the narrowest
source-level test around the local normalizer or adjust this verification note
to the real new test file.

## OSDK02: App v2 Permission And Question Events

done: false

Goal:

Ensure v2 permission/question OpenCode events trigger the same app refresh path
as legacy events.

Implementation:

- Add small predicate helpers near the session event-stream owner, for example:
  - `isPermissionRefreshEvent(type)`.
  - `isQuestionRefreshEvent(type)`.
- Include both legacy and v2 event names:
  - `permission.asked`.
  - `permission.replied`.
  - `permission.v2.asked`.
  - `permission.v2.replied`.
  - `question.asked`.
  - `question.replied`.
  - `question.rejected`.
  - `question.v2.asked`.
  - `question.v2.replied`.
  - `question.v2.rejected`.
- Use those helpers in both background and active event paths in
  `packages/app/src/app/context/session-event-stream.ts`.
- Extend `packages/app/src/app/tests/context/session-event-stream.test.ts` so
  v2 events cause permission/question refresh exactly once.
- Do not change modal rendering or prompt reply behavior in this task.

Acceptance:

- A v2 permission/question event refreshes the visible pending prompt state.
- Legacy permission/question events still refresh as before.
- Non-prompt events do not trigger extra prompt refreshes.

Verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-event-stream.test.ts
```

## OSDK03: Router Permission v2 Bridge

done: false

Goal:

Make `veslo-code-router` answer current OpenCode permission requests without
depending only on deprecated `permission.respond`.

Implementation:

- In `packages/opencode-router/src/bridge.ts`, support both:
  - legacy `permission.asked`;
  - v2 `permission.v2.asked`.
- Prefer supported reply APIs when request IDs are available:
  - `client.permission.reply({ requestID, reply })` for top-level requests.
  - `client.v2.session.permission.reply({ sessionID, requestID, reply })` for
    session-scoped v2 requests when needed by the request shape.
- Keep `permission.respond({ sessionID, permissionID, response })` only as a
  legacy fallback for old OpenCode servers.
- Add one short comment by the fallback explaining why deprecated `respond`
  remains present.
- Add or extend router bridge tests in `packages/opencode-router/test` for:
  - legacy permission event;
  - v2 permission event;
  - reply API preference;
  - legacy fallback.

Acceptance:

- Router can approve/reject a v2 permission event.
- Legacy router permission behavior still works.
- Deprecated `respond` is not the primary path for new request shapes.
- The implementation does not assume a specific OS path format.

Verification:

```powershell
corepack pnpm@10.27.0 --filter veslo-code-router exec pnpm typecheck
corepack pnpm@10.27.0 --filter veslo-code-router exec pnpm test:unit
```

## OSDK04: Abortable SDK Waits

done: false

Goal:

Prevent short readiness/timeouts from leaving longer OpenCode SDK requests alive
in the background.

Implementation:

- Audit SDK calls wrapped by generic `Promise.race` helpers.
- For app-side SDK requests that already go through `createClient`, prefer
  passing `AbortSignal` request options where the SDK method accepts options.
- For orchestrator SDK health fallback in `packages/orchestrator/src/cli.ts`,
  either:
  - pass an `AbortController.signal` into `client.global.health`, or
  - remove the SDK fallback from paths where raw health is already available.
- Do not change long-running SSE subscriptions; they already use abort signals.
- Add tests for timeout paths where practical; otherwise add a source-contract
  test that verifies an abort signal is passed into the SDK call.

Acceptance:

- A bounded SDK readiness/health call aborts the underlying SDK request.
- Existing lower-level `fetchWithTimeout` behavior in app clients remains.
- SSE stream subscriptions remain cancellable and unchanged.

Verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/utils/promise-timeout.test.ts src/app/tests/context/session-runtime-prompts.test.ts
corepack pnpm@10.27.0 --filter veslo-orchestrator exec bun test src/tests/runtime-engine-state.test.ts
```

Adjust the focused test list to the real files touched by this task.

## OSDK05: Prompt Submit Contract Guard

done: false

Goal:

Document and guard that the current Veslo conversation run handoff to
OpenCode `prompt_async` is intentional and still compatible with SDK v2 package
types.

Implementation:

- Add or update a source-contract test that verifies app send still submits
  `kind: "prompt_async"` through the Veslo conversation API.
- Add or update a server test that verifies the route builds OpenCode
  `/session/:id/prompt_async` with `directory` scoping.
- Verify the run body allowlist includes fields currently emitted by the app:
  `parts`, `model`, `agent`, `system`, `tools`, `mode`, `messageID`, `variant`,
  and related existing fields.
- Do not add a new `session.chat` path in this task.

Acceptance:

- Future agents do not confuse this compatibility work with a requirement to
  rewrite conversation submission.
- The prompt handoff remains covered by focused tests.
- Stale unused allowlist fields may be left alone unless they are proven harmful.

Verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pending-session-send-flow.test.ts
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server-conversations.test.ts src/tests/server.automations.test.ts
```

## OSDK06: SDK Upgrade Spike

done: false

Goal:

Upgrade OpenCode SDK only after the compatibility behavior is covered by tests.

Implementation:

- Upgrade all OpenCode package pins together:
  - `packages/app/package.json`.
  - `packages/orchestrator/package.json` dependency and `opencodeVersion`.
  - `packages/opencode-router/package.json`.
  - any `@opencode-ai/plugin` pin that must match the SDK/runtime version.
  - `pnpm-lock.yaml`.
- Re-run typecheck and focused tests from OSDK01 through OSDK05.
- Inspect generated `.d.ts` diffs for removed or renamed APIs before fixing
  compile errors.
- If latest stable removes or replaces an API, add a dated note here before
  adapting implementation.

Acceptance:

- There is exactly one SDK version family across app, orchestrator, router, and
  plugin dependencies.
- Package lock changes are explained by the OpenCode upgrade only.
- No implementation code imports APIs that exist only in Context7 docs but not
  in the installed package.

Verification:

```powershell
npm view @opencode-ai/sdk version --json
corepack pnpm@10.27.0 install --lockfile-only
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
corepack pnpm@10.27.0 --filter veslo-orchestrator typecheck
corepack pnpm@10.27.0 --filter veslo-code-router typecheck
corepack pnpm@10.27.0 --filter veslo-server typecheck
```

## OSDK07: Regression Bundle And Fix Note

done: false

Goal:

Prove the SDK compatibility slice did not regress runtime behavior and record
what changed for future agents.

Implementation:

- Run the focused verification bundle from completed tasks.
- Run `git diff --check`.
- Add a concise fix note in `docs/fixes` after implementation is complete.
- In the fix note, include:
  - SDK version before/after if upgraded.
  - Whether v2 permission/question events are covered.
  - Whether `syncEvent` envelopes are covered.
  - Whether router still uses deprecated `respond` only as fallback.
  - Verification commands and results.

Acceptance:

- All completed OSDK tasks have tests or a clearly documented reason why a test
  is not practical.
- The fix note is added only after code is complete.
- Top-level front matter is changed to `status: completed` and `done: true`
  only after OSDK00 through OSDK07 are all complete.

Verification:

```powershell
git diff --check
git status --short
rg -n "OSDK0[0-7].*done: true|status: completed|done: true" docs/plans/2026-07-04-opencode-sdk-v2-compatibility-kiss-plan.md
```

