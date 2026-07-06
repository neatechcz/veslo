---
title: OpenCode SDK, Plugins, and MCP Compatibility Implementation Plan
date: 2026-07-06
status: completed
done: true
issue: unlinked
source_plans:
  - docs/plans/2026-07-04-opencode-sdk-v2-compatibility-kiss-plan.md
  - docs/plans/2026-07-06-opencode-plugins-mcp-follow-up-plan.md
external_review_plan: ../veslo-review-fixes-20260706/docs/plans/2026-07-04-opencode-sdk-v2-compatibility-kiss-plan.md
osdkmcp00_scheduler_autoload_guard_done: true
osdkmcp00a_scheduler_deferred_activation_done: true
osdkmcp01_contract_snapshot_done: true
osdkmcp02_event_normalization_done: true
osdkmcp03_permission_question_v2_done: true
osdkmcp04_abortable_sdk_waits_done: true
osdkmcp05_prompt_submit_contract_done: true
osdkmcp06_mcp_config_contract_done: true
osdkmcp07_plugin_config_contract_done: true
osdkmcp08_opencode_1_17_13_upgrade_spike_done: true
osdkmcp09_regression_and_fix_note_done: true
---

# OpenCode SDK, Plugins, and MCP Compatibility Implementation Plan

## Goal

Make Veslo compatible with the OpenCode SDK/config surfaces it already uses,
without reintroducing OpenCode startup plugin autoload risk and without doing a
blind migration to future v2 config shapes.

This plan supersedes the execution order from the two source plans above. Those
plans remain useful background, but this file is the implementation checklist.

## Current Evidence

- Veslo currently pins `@opencode-ai/sdk`, `@opencode-ai/plugin`, and the
  orchestrator `opencodeVersion` to `1.17.4`.
- NPM latest on 2026-07-06 is `1.17.13` for `@opencode-ai/sdk`,
  `@opencode-ai/plugin`, and `opencode-ai`.
- Installed `@opencode-ai/sdk@1.17.4` has multiple generated type surfaces that
  must not be collapsed into one claim:
  - legacy `dist/gen` exposes `plugin?: Array<string>` and top-level `mcp`
    without the v2 tuple and `{ enabled }` sentinel details;
  - `dist/v2/gen` exposes `plugin?: Array<string | [string, options]>` and
    top-level `mcp?: { [name]: McpLocalConfig | McpRemoteConfig | { enabled } }`;
  - `dist/v2/gen` exposes `permission.v2.*`, `question.v2.*`, and `syncEvent`
    event types;
  - `dist/v2/gen` exposes top-level `permission.reply` / `question.reply` plus
    session-scoped v2 `client.v2.session.permission.reply` and
    `client.v2.session.question.reply`.
- Current Veslo plugin parsers are not tuple-safe yet: server plugin parsing,
  plugin materialization parsing, and app plugin utility parsing currently
  filter plugin lists down to string entries.
- Current Veslo MCP parsing treats top-level `mcp` keys as server names; without
  a guard, a future-shape `mcp.servers` config can be misread as a fake server
  named `servers`.
- Context7 OpenCode docs show both current package/docs examples using singular
  `plugin` and v2 config proposals using `plugins`.
- Context7 OpenCode docs show current v1 MCP config as top-level `mcp.<name>`
  and v2 config proposals using `mcp.servers`.
- `docs/fixes/2026-07-03-fix-26-opencode-plugin-autoload-disable.md` records
  that the scheduler plugin was removed because it made OpenCode server health
  falsely green while the useful API was still blocked.
- Before OSDKMCP00, root OpenCode config projected `opencode-scheduler`
  through `plugin`, and the server platform policy still had the scheduler
  plugin as locked-on auto-install. OSDKMCP00 removed that startup projection
  and OSDKMCP00A adds the deferred activation model.
- OpenCode server plugins are startup-loaded from config/plugin directories;
  npm plugin packages are installed/cached during startup. Treat `--pure` as
  a diagnostic signal that the external plugin path is involved, not as a
  production startup mode.
- MCP servers have an explicit `enabled` sentinel, but current server plugins
  do not have an equivalent proven hot-enable contract for the already-running
  OpenCode server process. Do not design around live server-plugin hot-toggle
  unless installed/runtime evidence proves it.
- `opencode-scheduler` is architecturally a better fit for deferred/background
  activation than cold-start activation: its documented model creates job files
  and OS scheduler entries, then the OS scheduler invokes a supervisor to run
  jobs later.
- Veslo already has a managed plugin materialization route:
  `/workspace/:id/plugins/materialization/sync`. Today it materializes all
  active managed policies in one pass; this is the natural place to add a
  startup-safe phase boundary.

## Additional OpenCode Documentation Notes

These notes were checked against Context7 on 2026-07-06 using
`/anomalyco/opencode` and `/anomalyco/opencode-sdk-js`. They are here so later
agents do not need to rediscover the same documentation edge cases.

- Current official OpenCode MCP docs still show active server config under
  top-level `mcp.<name>`, including local servers with `type: "local"`,
  `command`, `environment`, and `enabled`, and remote servers with
  `type: "remote"`, `url`, `headers`, `oauth`, `enabled`, and numeric
  `timeout`.
- Current official OpenCode MCP docs disable MCP tools through the `tools` map,
  for example `tools: { "my-mcp*": false }`, with optional per-agent
  re-enabling through `agent.<name>.tools`. This differs from Veslo's current
  local helper shape that looks for `tools.deny`; OSDKMCP06 must cover the
  official boolean/glob map and can keep `tools.deny` only as a compatibility
  fallback if still needed.
- Current docs use `enabled: false` to disable inherited/current MCP servers.
  Context7 v2 config proposals show `disabled: false` under `mcp.servers`.
  Treat `enabled` versus `disabled` as an explicit OSDKMCP08 upgrade decision,
  not as an automatic rename.
- Current docs show numeric MCP `timeout`. Context7 v2 config proposals also
  show protocol/server timeout objects such as `{ startup, request }`. Treat
  numeric timeout versus object timeout as an OSDKMCP08 compatibility question.
- Current official remote MCP docs use OAuth keys such as `clientId` and
  `clientSecret`; Context7 v2 proposal snippets use `client_id` and
  `client_secret`. Treat OAuth key casing as an upgrade-spike compatibility
  question before writing any migrator.
- Official SDK docs show client-level `timeout` plus request-level `signal`
  support. Veslo's abortable-wait work should prefer request-level abort
  signals for bounded calls instead of only racing promises.
- Official SDK event docs show async event streams where each event has
  `type` and `properties`. Veslo event normalization should continue to key
  from those fields and should verify the installed SDK's exact method names
  before renaming existing event stream code.

## KISS Boundary

Do not:

- migrate all config from `plugin` to `plugins`;
- migrate all MCP config from top-level `mcp.<name>` to `mcp.servers`;
- remove the legacy `permission.respond` fallback before old OpenCode servers
  are proven unsupported;
- upgrade OpenCode packages before compatibility behavior is covered by focused
  tests;
- hot-toggle OpenCode server plugins in a live engine process without a proven
  installed-runtime API;
- keep heavy/background plugin materialization on the interactive engine
  cold-start path;
- use broad manual E2E as acceptance when smaller contract tests cover the
  changed surface.

## Non-Goals

This plan intentionally does not include:

- a broad config migrator from `plugin` to `plugins`;
- a broad MCP schema migrator from top-level `mcp.<name>` to `mcp.servers`;
- a new plugin framework or plugin option UI;
- a full replacement implementation of `opencode-scheduler`;
- a prompt modal UI redesign;
- a combined compatibility-and-upgrade diff.

## Execution Order And Gates

Implementation order is fixed unless a later audit records a concrete reason to
change it:

1. OSDKMCP00 scheduler regression hotfix.
2. OSDKMCP00A scheduler deferred activation model.
3. OSDKMCP01 contract snapshot.
4. OSDKMCP02 and OSDKMCP03 event/reply compatibility.
5. OSDKMCP06 and OSDKMCP07 MCP/plugin config contracts.
6. OSDKMCP04 and OSDKMCP05 timeout and prompt-submit guards.
7. OSDKMCP08 OpenCode `1.17.13` upgrade spike.
8. OSDKMCP09 regression bundle and fix note.

Hard gates:

- Do not start OSDKMCP08 in the same diff as OSDKMCP00 through OSDKMCP07 unless
  OSDKMCP00A is also marked `done: true` and those earlier tasks have listed
  verification recorded.
- Treat Context7 docs and v2 proposals as input evidence, not migration
  authority. Installed package behavior and local tests decide runtime changes.
- If a task cannot get its focused test in the same slice, leave that task
  `done: false` and record the gap instead of green-lighting by narrative.

## Implementation Status Contract

Each task stays `done: false` until code, focused tests, and the listed
verification are complete. If implementation discovers a better file name or a
renamed test, update the verification block before marking the task done.

Coordination note: this plan is a new file until it is added and committed.
Before handing implementation to another worktree or agent, make sure this file
is available there; otherwise they may only see the older source plans.

## OSDKMCP00: Scheduler Autoload Regression Hotfix

done: true

Goal:

Fix the current scheduler reintroduction regression before any SDK or runtime
validation, while preserving the product option to re-enable scheduler through
a deferred/background activation path.

Implementation:

- Remove `opencode-scheduler` from root `opencode.jsonc`; this is not only
  theoretical risk, because the current config contradicts the July 3 fix note.
- Keep root `opencode.json` free of raw scheduler plugin entries.
- Change the platform scheduler policy so startup/default materialization sync
  cannot write `opencode-scheduler` into project or user OpenCode config.
  Prefer keeping the policy record but marking it non-startup/non-default
  materializable so future scheduler work does not need to rediscover policy
  ownership.
- Keep Superpowers behavior out of this task.
- Treat desktop starter seeding as already-covered unless this task touches
  desktop code. The main remaining surfaces are root config and server policy.
- Add or update server tests proving:
  - managed plugin materialization does not add scheduler by default;
  - locked scheduler policy cannot silently reintroduce the plugin;
  - plugin inventory still handles non-scheduler plugins.
- Add a cheap static regression guard proving `opencode-scheduler` is absent
  from active root config and from default materializable policy.

Acceptance:

- `opencode-scheduler` is absent from active root config.
- Default/startup plugin materialization sync does not reintroduce scheduler.
- Scheduler remains represented as a Veslo-managed capability only if it is
  clearly marked non-startup/deferred.
- The old fix note remains true after this task.
- Static checks fail if scheduler returns to root config or default
  materialization.

Verification:

```powershell
if (Select-String -Path opencode.json,opencode.jsonc -Pattern 'opencode-scheduler' -Quiet) { Write-Error 'opencode-scheduler found in root OpenCode config'; exit 1 } else { 'root OpenCode config scheduler check passed' }
rg -n "opencode-scheduler|autoInstall|enabledPolicy|removalPolicy" packages/server/src/platform-managed-plugins.ts packages/server/src/routes/plugins.ts packages/server/src/plugin-materializer.ts packages/server/src/tests
rg -n "opencode-scheduler" docs/fixes/2026-07-03-fix-26-opencode-plugin-autoload-disable.md
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.plugins-routes.test.ts src/tests/plugin-materializer.test.ts src/tests/plugin-policy.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec bun test src/app/tests/context/extensions-plugin-client-contract.test.ts
git diff --check -- opencode.jsonc packages/server/src/platform-managed-plugins.ts packages/server/src/tests/plugin-policy.test.ts packages/server/src/tests/plugin-materializer.test.ts packages/server/src/tests/server.plugins-routes.test.ts
```

Result on 2026-07-06:

- Root config scheduler check passed.
- Server test command passed: 38 passed, 4 symlink-only tests skipped because
  this Windows environment cannot create symlinks, 0 failed.
- App plugin client contract test passed.

## OSDKMCP00A: Scheduler Deferred Activation Model

done: true

Goal:

Keep `opencode-scheduler` available as a future Veslo platform capability
without making the interactive OpenCode engine cold-start depend on scheduler
plugin install/load.

Design Decision:

- Do not use `opencode --pure` as the production startup strategy. It is too
  broad because it disables all external plugins.
- Do not assume OpenCode server plugins can be enabled inside an already-running
  OpenCode server. Current evidence supports startup-load semantics for server
  plugins; live hot-enable remains an upgrade-spike question.
- Use a Veslo-owned desired-state versus runtime-projection split:
  - desired state: scheduler exists as a managed platform capability;
  - startup projection: scheduler is absent from active OpenCode config;
  - post-ready projection: scheduler can be prepared/materialized only after
    the interactive engine reaches a useful ready state;
  - runtime activation: scheduler activation either runs in a separate
    background/scheduler runtime or happens through a controlled restart while
    no prompt/run is active.

Implementation:

- Extend the managed plugin policy model with an activation concept such as:
  - `activationPhase: "startup" | "post-ready" | "on-demand" | "background-runtime"`;
  - `coldStartCritical: boolean`;
  - `requiresEngineRestart: boolean`.
- Classify scheduler as background/deferred, for example:
  - `activationPhase: "background-runtime"`;
  - `coldStartCritical: false`;
  - `requiresEngineRestart: true`;
  - default startup materialization disabled.
- Keep Superpowers and normal user plugins in the startup/default path unless
  a separate performance audit moves them.
- Extend `/workspace/:id/plugins/materialization/sync` to accept or infer a
  phase. Startup sync must materialize only `activationPhase: "startup"`
  policies. Scheduler sync must require an explicit post-ready/on-demand path.
- Add a scheduler prepare path that runs after useful engine readiness, not
  during cold start. At minimum it should:
  - verify OpenCode plugin cache/package availability;
  - verify platform support and OS scheduler command availability;
  - record degraded status instead of blocking the interactive engine.
- If scheduler must be projected into the active OpenCode config, perform it
  only when:
  - the engine is useful-ready;
  - there is no active prompt/run;
  - Veslo can emit a controlled plugin reload/restart event;
  - rollback removes scheduler from active config on activation failure.
- Prefer a longer-term separate scheduler runtime for schedule management. The
  main interactive engine should stay optimized for user prompt latency, while
  scheduler tooling can be warmed, started, or restarted independently.
- Pin scheduler package spec/version in the managed policy once re-enabled.
  Avoid bare latest-style package behavior on the cold or activation path.

Acceptance:

- A fresh Veslo/OpenCode interactive startup does not load or install
  `opencode-scheduler`.
- Scheduler is still represented in debug/platform inventory as deferred or
  background-only, not as an active startup plugin.
- Startup plugin materialization and post-ready scheduler materialization are
  separate code paths with separate tests.
- A failed scheduler prepare/activation cannot make `/health` falsely green
  while `/project`, `/config`, or `/provider` remain blocked.
- Any restart required for scheduler activation is explicit, idle-gated, and
  observable through reload/runtime status.

Verification:

```powershell
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.plugins-routes.test.ts src/tests/plugin-policy.test.ts src/tests/plugin-materializer.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec bun test src/app/tests/context/extensions-plugin-policy.test.ts
rg -n "activationPhase|coldStartCritical|requiresEngineRestart|background-runtime|post-ready|opencode-scheduler" packages/server/src packages/app/src/app docs/plans/2026-07-06-opencode-sdk-plugins-mcp-implementation-plan.md
git diff --check -- packages/server/src/platform-managed-plugins.ts packages/server/src/plugin-policy.ts packages/server/src/routes/plugins.ts packages/server/src/plugin-materializer.ts packages/app/src/app
```

Result on 2026-07-06:

- Server test command passed: 41 passed, 4 symlink-only tests skipped because
  this Windows environment cannot create symlinks, 0 failed.
- App plugin policy test passed: 10 passed, 0 failed.
- Evidence `rg` command passed.
- `git diff --check` for the listed paths passed with line-ending warnings
  only.
- Scheduler prepare is explicitly degraded on Windows because no proven Windows
  OS scheduler command is wired for this package path; the route has a
  regression assertion for the `win32` unsupported status instead of implying
  Windows activation is supported.
- Additional validation passed:
  - `corepack pnpm@10.27.0 --filter veslo-server typecheck`
  - `corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck`

## OSDKMCP01: Contract Snapshot

done: true

Goal:

Freeze the local package contract before changing SDK/event/config behavior.

Implementation:

- Record a dated contract matrix in this task or a short linked note with:
  - installed OpenCode package versions;
  - latest NPM versions;
  - legacy `dist/gen` SDK type evidence;
  - `dist/v2/gen` SDK type evidence;
  - Context7 current docs evidence;
  - Context7 v2 proposal evidence.
- The matrix must explicitly cover events, prompt submission, permission,
  question, MCP, plugin config, and the plugin tuple/options shape.
- Treat installed package `.d.ts` as higher priority than docs when they
  disagree.
- Record that the review plan under `veslo-review-fixes-20260706` is identical
  to the in-repo SDK plan.

Acceptance:

- Later tasks can cite this snapshot rather than rediscovering the same
  contracts.
- Any doc/package disagreement is explicitly categorized as one of:
  - legacy `dist/gen` behavior;
  - `dist/v2/gen` behavior;
  - Context7 current documentation;
  - Context7 v2 proposal / upgrade-spike behavior.

Verification:

```powershell
npm view @opencode-ai/sdk version dist-tags --json
npm view @opencode-ai/plugin version dist-tags --json
npm view opencode-ai version dist-tags --json
rg -n "plugin\\?:|mcp\\?:" packages/app/node_modules/@opencode-ai/sdk/dist/gen packages/app/node_modules/@opencode-ai/sdk/dist/v2/gen
rg -n "McpLocalConfig|McpRemoteConfig|EventPermissionV2Asked|EventQuestionV2Asked|SyncEvent|class Permission2|class Question2|V2SessionQuestionReplyData" packages/app/node_modules/@opencode-ai/sdk/dist/v2/gen
rg -n "function pluginListFromConfig|plugin\\.filter|Array\\.isArray\\(plugin\\)|getMcpConfig" packages/server/src packages/app/src/app
Get-ChildItem node_modules/.pnpm -Directory -Filter "@opencode-ai+plugin@*" | Select-Object -ExpandProperty FullName
```

Result on 2026-07-06:

- Added contract snapshot:
  `docs/dev/2026-07-06-opencode-sdk-plugin-mcp-contract-snapshot.md`
- NPM latest verification passed for `@opencode-ai/sdk`, `@opencode-ai/plugin`,
  and `opencode-ai`: all latest versions were `1.17.13`; npm emitted only
  workspace config warnings.
- Local `.d.ts` evidence commands passed for legacy `dist/gen` and
  `dist/v2/gen`.
- Local Veslo parser evidence command passed.
- Installed `@opencode-ai/plugin@1.17.4` package path was found.
- Review plan SHA256 matched between in-repo and external review locations:
  `BAF4D21F851CB43AA84A4607801CE086260A0B060093EE3199CF23ABEE99808B`.

## OSDKMCP02: Event Normalization

done: true

Goal:

Normalize the OpenCode event envelopes Veslo depends on:

- direct event: `{ type, properties }`
- payload event: `{ payload: { type, properties } }`
- sync event: `{ type: "sync", syncEvent: { type, data } }`

Implementation:

- Extend `packages/app/src/app/utils/messages.ts`.
- Extend `packages/opencode-router/src/events.ts`.
- Extend the local normalizer in `packages/orchestrator/src/cli.ts`.
- Strip only trailing numeric schema suffixes such as `.1` or `.2` from
  `syncEvent.type`; do not rewrite ordinary dotted event names.
- Use `syncEvent.data` as normalized `properties`.
- Add one short code comment at the sync branch explaining why the branch
  exists.

Acceptance:

- Existing direct and payload event behavior is unchanged.
- Sync envelopes produce normal Veslo event objects.
- Partial sync envelopes return `null`.

Verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/utils/messages-normalize-event.test.ts
corepack pnpm@10.27.0 --filter veslo-orchestrator exec bun test src/tests/opencode-event-normalization.test.ts
corepack pnpm@10.27.0 --filter veslo-code-router exec pnpm test:unit
```

Result:

- Added direct, payload, sync envelope normalization coverage in the app,
  router, and orchestrator.
- App focused test passed: 5 pass, 0 fail.
- Orchestrator focused test passed: 5 pass, 0 fail.
- Router focused event test passed with Bun: 5 pass, 0 fail.
- Router build/typecheck passed.
- Orchestrator typecheck passed.
- `veslo-code-router` `pnpm test:unit` now runs the router unit subset and
  passed with 23 pass, 0 fail. Bridge E2E-style tests remain outside this unit
  gate.

## OSDKMCP03: Permission And Question v2 Compatibility

done: true

Goal:

Handle current v2 permission/question events and reply APIs without breaking
legacy OpenCode behavior.

Implementation:

- In `packages/app/src/app/context/session-event-stream.ts`, add small
  predicate helpers for permission/question refresh events.
- Include legacy and v2 event names:
  - `permission.asked`
  - `permission.replied`
  - `permission.v2.asked`
  - `permission.v2.replied`
  - `question.asked`
  - `question.replied`
  - `question.rejected`
  - `question.v2.asked`
  - `question.v2.replied`
  - `question.v2.rejected`
- Use those helpers in both active and background event paths.
- In `packages/opencode-router/src/bridge.ts`, support both legacy
  `permission.asked` and v2 `permission.v2.asked`.
- Prefer `client.permission.reply({ requestID, reply })` for top-level request
  IDs.
- Prefer `client.v2.session.permission.reply({ sessionID, requestID, reply })`
  for session-scoped v2 requests when that shape is present.
- Add an explicit app-side decision test for v2 question replies:
  - use a v2 question fixture with both `sessionID` and `requestID`;
  - assert the actual reply adapter/path, not only prompt-state refresh;
  - prove top-level `question.list` / `question.reply({ requestID, answers })`
    covers v2 question requests; or
  - implement a session-scoped v2 question reply path using
    `client.v2.session.question.reply({ sessionID, requestID, questionV2Reply })`;
    or
  - split question reply compatibility into a follow-up task and leave this
    task incomplete.
- Keep deprecated `permission.respond` only as a legacy fallback and document
  why it remains.
- Do not change modal rendering in this task unless the v2 question reply
  decision proves a small reply-adapter change is required.

Acceptance:

- App v2 permission/question events refresh pending prompt state once.
- App v2 question reply behavior is either proven through top-level APIs or
  implemented through the session-scoped v2 reply API.
- Router can approve/reject v2 permission requests.
- Legacy permission/question behavior remains covered.
- Deprecated `respond` is not the primary path for new request shapes.

Verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-event-stream.test.ts src/app/tests/context/session-runtime-prompts.test.ts
corepack pnpm@10.27.0 --filter veslo-code-router exec pnpm typecheck
corepack pnpm@10.27.0 --filter veslo-code-router exec pnpm test:unit
```

Result:

- Added app permission/question refresh predicates covering legacy and v2 event
  names.
- Active and background event paths now use the same predicates.
- Added session-scoped v2 fallback for app permission, question reply, and
  question reject when top-level reply/reject cannot find the request.
- Router permission handling now accepts both `permission.asked` and
  `permission.v2.asked`.
- Router uses `permission.reply` as the primary legacy path, v2 session
  permission reply for v2 events, and keeps deprecated `permission.respond`
  only as a last-resort legacy fallback.
- App focused test passed: 16 pass, 0 fail.
- Router typecheck passed.
- App typecheck passed.
- Router focused permission/event tests passed: 8 pass, 0 fail.
- `veslo-code-router` `pnpm test:unit` now runs the router unit subset and
  passed with 23 pass, 0 fail. Bridge E2E-style tests remain outside this unit
  gate.

## OSDKMCP04: Abortable SDK Waits

done: true

Goal:

Prevent short Veslo readiness timeouts from leaving longer OpenCode SDK
requests alive in the background.

Implementation:

- Audit SDK calls wrapped by generic `Promise.race` helpers.
- For app-side SDK calls through `createClient`, pass an `AbortSignal` request
  option where the installed SDK method accepts options.
- For orchestrator SDK health fallback in `packages/orchestrator/src/cli.ts`,
  pass an abort signal into `client.global.health` or remove that SDK fallback
  from paths where raw health is already sufficient.
- Do not change long-running SSE subscriptions; they already use abort signals.
- Add focused tests for timeout paths where practical. If a behavior test is
  too heavy, add a source-contract test that verifies an abort signal is passed.

Acceptance:

- Bounded SDK health/readiness calls abort the underlying SDK request.
- Existing raw `fetch` timeout behavior stays unchanged.
- SSE subscriptions remain cancellable and unchanged.

Verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/utils/promise-timeout.test.ts src/app/tests/context/session-runtime-prompts.test.ts
corepack pnpm@10.27.0 --filter veslo-orchestrator exec bun test src/tests/runtime-engine-state.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
corepack pnpm@10.27.0 --filter veslo-orchestrator typecheck
```

Result:

- App `waitForHealthy` now passes an `AbortSignal` into bounded
  `client.global.health` SDK calls and clears the request timer.
- Orchestrator SDK health fallback now aborts the SDK request directly instead
  of racing a timeout promise that leaves the request alive.
- Raw health fetch timeout behavior remains unchanged.
- Long-running SSE subscriptions were not changed.
- App focused tests passed: 11 pass, 0 fail.
- Orchestrator focused test passed: 3 pass, 0 fail.
- App typecheck passed.
- Orchestrator typecheck passed.

## OSDKMCP05: Prompt Submit Contract Guard

done: true

Goal:

Make it explicit that Veslo intentionally submits prompts through its
conversation API to OpenCode `/session/:id/prompt_async`.

Implementation:

- Keep `kind: "prompt_async"` in app conversation handoff tests.
- Keep server route tests for `/session/:id/prompt_async` with directory
  scoping.
- Keep the run body allowlist aligned with app-emitted fields including:
  `parts`, `model`, `agent`, `system`, `tools`, `mode`, `messageID`, and
  `variant`.
- Do not add a new `session.chat` path in this task.

Acceptance:

- Future SDK compatibility work is not mistaken for a prompt submission rewrite.
- `variant` remains part of the guarded prompt contract.
- Server tests still prove OpenCode receives the expected prompt endpoint.

Verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pending-session-send-flow.test.ts
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server-conversations.test.ts src/tests/server.automations.test.ts
```

Result:

- Kept app prompt handoff on `kind: "prompt_async"` and existing
  conversation API.
- Server `prompt_async` body allowlist now preserves app-emitted `mode`.
- Server contract test now guards `parts`, `model`, `agent`, `system`,
  `tools`, `mode`, `messageID`, and `variant` while continuing to drop
  non-OpenCode fields such as `kind`, `directory`, `sessionID`,
  `clientMessageId`, and `origin`.
- No `session.chat` path was added.
- App focused tests passed: 20 pass, 0 fail.
- Server focused tests passed: 38 pass, 0 fail.

## OSDKMCP06: MCP Config Contract

done: true

Goal:

Keep Veslo MCP behavior aligned with installed OpenCode `1.17.4` while
documenting the future `mcp.servers` schema as upgrade-spike-only.

Implementation:

- Keep server reads/writes on top-level `mcp.<name>`.
- Add tests that reject treating `mcp.servers` as the current write target.
- Add read-path guard tests so `mcp.servers` is not listed as a fake MCP server
  named `servers`. Prefer a warning/ignored future-shape branch over silent
  misclassification.
- Preserve local config shape: `type: "local"`, `command: string[]`,
  optional `cwd`, `environment`, `enabled`, and `timeout`.
- Preserve remote config shape: `type: "remote"`, `url`, optional `headers`,
  `oauth`, `enabled`, and `timeout`.
- Cover override-only MCP entries such as `{ enabled: false }` or
  `{ enabled: true }`; these are valid current-doc shapes for disabling or
  re-enabling inherited servers and must not be rejected as malformed full
  server definitions.
- Support the official OpenCode MCP tool-disable shape
  `tools: { "<glob>": false }`, including server-prefix globs such as
  `"my-mcp*": false`. Keep Veslo's existing `tools.deny` reader only if needed
  as a legacy compatibility fallback, and document which shape wins if both are
  present.
- Keep sensitive header validation, with Veslo connector token allowed only on
  the explicit trusted path.
- Keep runtime token refresh for `x-veslo-connector-token`.
- Keep desktop Chrome MCP seeding/migration to
  `["chrome-devtools-mcp", "--isolated"]`.

Acceptance:

- Project and global MCP listings read current OpenCode config correctly.
- A config containing `mcp.servers` does not produce a listed server named
  `servers`.
- Hub MCP install writes top-level `mcp.<name>` entries.
- MCP tool-disable behavior honors official `tools` boolean/glob entries.
- Current-doc override-only MCP entries with `enabled` are handled explicitly.
- `mcp.servers` is documented but not used as the active write target before
  the package upgrade spike.
- Chrome MCP seed remains the installed binary command, not `npx ...@latest`.

Verification:

```powershell
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.mcp-routes.test.ts src/tests/server.hub-mcp.test.ts src/tests/validators.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/mcp-connection-workflow.test.ts src/app/tests/lib/mcp-runtime-status-refresh.test.ts
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --lib workspace::files
git diff --check -- packages/server/src/mcp.ts packages/server/src/routes/mcp.ts packages/server/src/validators.ts packages/app/src/app/context/mcp-connection-workflow.ts packages/app/src/app/lib/mcp-runtime-status-refresh.ts packages/desktop/src-tauri/src/workspace/files.rs
```

Result:

- Server MCP reads remain on current top-level `mcp.<name>` entries.
- Future `mcp.servers` is ignored on the read path instead of being listed as
  a fake MCP named `servers`.
- Future `mcp.servers` is preserved on write paths while Veslo mutates current
  top-level `mcp.<name>` entries for add, remove, and runtime-token refresh.
- Hub MCP install remains top-level `mcp.<name>` and is covered by test.
- Validator accepts override-only `{ enabled: false }` and `{ enabled: true }`
  sentinel entries.
- Validator preserves current local/remote config fields and now accepts local
  `cwd`.
- Tool-disable detection now honors official `tools: { "<glob>": false }`
  entries and legacy `tools.deny`; they are additive and any disabled pattern
  wins.
- Veslo connector runtime token validation and refresh stayed unchanged.
- Desktop Chrome MCP seed/migration stayed on
  `["chrome-devtools-mcp", "--isolated"]`.
- Server focused tests passed: 37 pass, 0 fail.
- App focused tests passed: 12 pass, 0 fail.
- Desktop Rust `workspace::files` tests passed: 12 pass, 0 fail.
- Scoped `git diff --check` passed with CRLF warnings only.

## OSDKMCP07: Plugin Config Contract

done: true

Goal:

Make plugin config tuple-safe for the installed package contract while
preventing future-doc drift from causing a blind `plugin` to `plugins`
migration.

Implementation:

- Keep server plugin reads/writes on singular `plugin` for installed
  `1.17.4`.
- Implement and preserve tuple support for plugin options:
  `["package-name", { "option": "value" }]`.
- Update the server plugin model so string and tuple entries can round-trip
  without being dropped or converted to plain strings.
- Update plugin materialization so managed spec insertion/removal does not
  discard unrelated tuple entries.
- Update app plugin utilities so installed-plugin checks normalize tuple
  package names instead of ignoring them.
- Add round-trip tests for:
  - server list/add/remove with tuple entries already present;
  - materialization with unrelated tuple entries already present;
  - app installed-plugin detection with tuple entries.
- Add a small contract test or source assertion that `plugins` is not treated
  as the current write key.
- Keep managed plugin materialization separate from raw user plugin config.
- Document v2 `plugins` as an upgrade-spike question for `1.17.13`.

Acceptance:

- Veslo does not overwrite user plugin config into a future-only key.
- Existing tuple plugin entries survive list/add/remove/materialization paths.
- Managed materialization still handles current package plugin specs.
- Scheduler remains outside startup managed materialization; explicit scheduler
  prepare behavior is governed by OSDKMCP00A.

Verification:

```powershell
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.plugins-routes.test.ts src/tests/plugin-materializer.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec bun test src/app/tests/context/extensions-plugin-client-contract.test.ts src/app/tests/utils/plugins.test.ts
git diff --check -- packages/server/src/plugins.ts packages/server/src/plugin-materializer.ts packages/server/src/routes/plugins.ts packages/server/src/platform-managed-plugins.ts packages/app/src/app/utils/plugins.ts
```

Result on 2026-07-06:

- Server plugin config parsing now preserves singular `plugin` entries that are
  either strings or installed-contract tuples like
  `["package-name", { "option": "value" }]`.
- Server list/add/remove normalize by the tuple package name but write the
  original tuple entries back unchanged.
- Plugin materialization preserves unrelated tuple entries while inserting and
  removing managed string specs.
- App plugin utilities now normalize tuple package names so installed-plugin
  checks see tuple entries.
- Added round-trip coverage for server list/add/remove, materializer
  insertion/removal, and app installed-plugin detection.
- Added contract assertions that these paths continue to write singular
  `plugin` and do not create a future-only `plugins` key.
- Focused server tests passed:
  `corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.plugins-routes.test.ts src/tests/plugin-materializer.test.ts`
  with 32 pass, 4 skipped symlink tests, 0 fail.
- Focused app tests passed:
  `corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec bun test src/app/tests/context/extensions-plugin-client-contract.test.ts src/app/tests/utils/plugins.test.ts`
  with 3 pass, 0 fail.
- Planned `git diff --check` passed for the OSDKMCP07 files with CRLF warnings
  only.
- Extra server typecheck passed:
  `corepack pnpm@10.27.0 --filter veslo-server typecheck`.
- Extra app typecheck passed after the workspace server registry test double
  was updated to return the current Veslo server client payload shape.

## OSDKMCP08: OpenCode 1.17.13 Upgrade Spike

done: true

Goal:

Upgrade OpenCode packages only after compatibility behavior is covered. This is
a gated compatibility spike, not the hotfix path.

Implementation:

- Refuse to start this task until OSDKMCP00 through OSDKMCP07 are already
  `done: true` with verification recorded.
- Upgrade the OpenCode version family together:
  - `packages/app/package.json`
  - `packages/orchestrator/package.json` dependencies
  - `packages/orchestrator/package.json` `opencodeVersion`
  - `packages/opencode-router/package.json`
  - `packages/desktop/package.json` `opencodeVersion`
  - `@opencode-ai/plugin` pins
  - `pnpm-lock.yaml`
- Re-run typecheck and focused tests from OSDKMCP02 through OSDKMCP07.
- Inspect generated `.d.ts` diffs before adapting compile errors.
- Answer explicitly:
  - whether singular `plugin` is still accepted;
  - whether `plugins` is required, optional, or future-only;
  - whether top-level `mcp.<name>` is still accepted;
  - whether `mcp.servers` is required, optional, or future-only;
  - whether MCP server disabling uses `enabled`, `disabled`, or both;
  - whether MCP timeout remains numeric, accepts `{ startup, request }`, or
    requires a migration;
  - whether remote MCP OAuth keys use `clientId` / `clientSecret`,
    `client_id` / `client_secret`, or both;
  - whether `tools: { "<glob>": false }` remains the supported MCP
    tool-disable shape;
  - whether SDK initialization should use Veslo's current client factory,
    `createOpencode`, `new Opencode`, or another installed package entrypoint;
  - whether event streaming is exposed as `event.list`, `event.subscribe`, or
    another installed SDK method, and whether events still expose `type` and
    `properties`;
  - whether permission/question reply APIs changed.

Acceptance:

- There is exactly one OpenCode version family across Veslo packages.
- OSDKMCP00 through OSDKMCP07 were completed before the package upgrade diff
  began.
- Lockfile changes are explained by the OpenCode upgrade only.
- Any schema migration is backed by installed package behavior, not only docs.

Verification:

```powershell
npm view @opencode-ai/sdk version --json
npm view @opencode-ai/plugin version --json
npm view opencode-ai version --json
corepack pnpm@10.27.0 install --lockfile-only
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
corepack pnpm@10.27.0 --filter veslo-orchestrator typecheck
corepack pnpm@10.27.0 --filter veslo-code-router typecheck
corepack pnpm@10.27.0 --filter veslo-server typecheck
```

Result on 2026-07-06:

- OSDKMCP00 through OSDKMCP07 were already marked complete before this upgrade
  diff began.
- NPM latest verification returned `1.17.13` for `@opencode-ai/sdk`,
  `@opencode-ai/plugin`, and `opencode-ai`.
- Context7 was checked for `/anomalyco/opencode`,
  `/anomalyco/opencode-sdk-js`, and `/websites/opencode_ai_plugins`.
- Upgraded the OpenCode version family from `1.17.4` to `1.17.13` in:
  `packages/app/package.json`, `packages/orchestrator/package.json`,
  `packages/opencode-router/package.json`, `packages/desktop/package.json`,
  and `pnpm-lock.yaml`.
- Ran `corepack pnpm@10.27.0 install --lockfile-only`, then
  `corepack pnpm@10.27.0 install --frozen-lockfile` so installed
  `node_modules` metadata and generated `.d.ts` are also on `1.17.13`.
- Lockfile changes are limited to OpenCode package entries and their direct
  transitive changes: `@opencode-ai/sdk`, `@opencode-ai/plugin`,
  `@ai-sdk/provider@3.0.8`, and `effect@4.0.0-beta.83`.
- Installed `@opencode-ai/sdk@1.17.13` `dist/v2/gen/types.gen.d.ts` still
  exposes singular `plugin?: Array<string | [string, options]>`; `plugins` is
  not an installed-package config key and remains a future/proposal question.
- Installed `@opencode-ai/sdk@1.17.13` still accepts top-level
  `mcp?: { [name]: McpLocalConfig | McpRemoteConfig | { enabled: boolean } }`;
  `mcp.servers` remains a v2 proposal/docs shape, not Veslo's current write
  target.
- Installed MCP server disabling remains `enabled?: boolean` and override-only
  `{ enabled: boolean }`. `disabled` appears in v2 proposal docs but is not the
  installed `1.17.13` contract Veslo writes.
- Installed MCP timeout remains numeric `timeout?: number`; `{ startup,
  request }` timeout objects appear in v2 proposal docs and are not migrated in
  this task.
- Installed remote MCP OAuth config uses camelCase `clientId`,
  `clientSecret`, `callbackPort`, and `redirectUri`; snake_case OAuth keys
  remain proposal-only for Veslo.
- Context7 current MCP docs still support `tools: { "<glob>": false }` for
  tool-disable behavior, matching OSDKMCP06.
- Veslo's current v2 SDK factory remains valid:
  `@opencode-ai/sdk/dist/v2/client.d.ts` exports `createOpencodeClient`.
  Context7 SDK docs also show `new Opencode()`, but Veslo's import surface is
  the installed v2 client factory.
- Installed v2 event streaming remains `event.subscribe(...)`, not
  `event.list(...)`, and events still expose `type` plus `properties`.
  Sync event types remain present.
- Permission/question reply APIs remain compatible: top-level
  `permission.reply`, `question.reply`, and `question.reject` still exist, and
  session-scoped v2 `Permission2.reply`, `Question2.reply`, and
  `Question2.reject` still exist.
- Typechecks passed after the upgrade:
  `@neatech/veslo-ui`, `veslo-orchestrator`, `veslo-code-router`, and
  `veslo-server`.
- Focused tests from OSDKMCP02 through OSDKMCP07 passed after the upgrade:
  app node-test bundle 56 pass; app plugin bundle 3 pass; server bundle 106
  pass with 4 symlink tests skipped; orchestrator bundle 8 pass; router
  targeted bundle 8 pass.
- The router `test:unit` script now runs the stable unit subset with explicit
  file paths and passed with 23 pass, 0 fail; bridge E2E-style router tests
  remain outside this unit gate.
- Fixed an app test double in
  `packages/app/src/app/tests/context/workspace-server-registry.test.ts` so its
  fake `activateWorkspace` returns the current Veslo server client payload
  shape; the focused workspace registry test passed with 7 pass.
- `git diff --check` passed for the OSDKMCP08 and OSDKMCP07 files with CRLF
  warnings only.

## OSDKMCP09: Regression Bundle And Fix Note

done: true

Goal:

Prove the combined SDK/plugin/MCP slice did not regress runtime contracts and
record the result for future agents.

Implementation:

- Run the focused tests from completed tasks.
- Run package typechecks for app, server, orchestrator, and router.
- Run the targeted desktop Rust workspace-file tests.
- Add a concise `docs/fixes/YYYY-MM-DD-...md` note with:
  - package versions before and after;
  - plugin config decision;
  - MCP config decision;
  - scheduler autoload outcome;
  - verification commands and results.
- Mark this plan `status: completed` and `done: true` only after all task flags
  are true.

Acceptance:

- The fix note records the final implementation and verification evidence.
- No source plan remains a better source of truth than this implementation
  plan.
- `git status --short` is explained, including any unrelated pre-existing
  changes.

Verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
corepack pnpm@10.27.0 --filter veslo-server typecheck
corepack pnpm@10.27.0 --filter veslo-orchestrator typecheck
corepack pnpm@10.27.0 --filter veslo-code-router typecheck
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --lib workspace::files
git diff --check
rg -n "osdkmcp0[0-9].*_done: false|status: ready-for-implementation|done: false" docs/plans/2026-07-06-opencode-sdk-plugins-mcp-implementation-plan.md
```

Result on 2026-07-06:

- Added fix note:
  `docs/fixes/2026-07-06-fix-32-opencode-sdk-plugin-mcp-compatibility.md`.
- Package typechecks passed:
  - `corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck`
  - `corepack pnpm@10.27.0 --filter veslo-server typecheck`
  - `corepack pnpm@10.27.0 --filter veslo-orchestrator typecheck`
  - `corepack pnpm@10.27.0 --filter veslo-code-router typecheck`
- Focused regression tests passed after the `1.17.13` upgrade:
  - app event/reply/prompt/MCP node-test bundle: `56` pass;
  - app plugin utility/client bundle: `3` pass;
  - app plugin policy/client bundle: `11` pass;
  - app workspace registry focused test: `7` pass;
  - server conversation/MCP/plugin bundle: `106` pass, `4` symlink tests
    skipped;
  - server scheduler/plugin-policy bundle: `43` pass, `4` symlink tests
    skipped;
  - orchestrator event/runtime bundle: `8` pass;
  - router targeted event/permission bundle: `8` pass;
  - router `test:unit` bundle: `23` pass;
  - desktop workspace-file Rust tests: `12` pass.
- Bridge E2E-style router tests remain outside the router unit gate and were
  not part of this OpenCode SDK/plugin/MCP checkpoint.
- `git diff --check` passed with LF/CRLF warnings only.
- ASCII check for the new fix note, this plan, and new plugin/workspace tests
  passed.
- Current `git status --short` still includes unrelated existing dirty
  E2E/pilot, server-access, and broader desktop/testing changes. This plan's
  OpenCode SDK/plugin/MCP slice is recorded in the new fix note and the
  OSDKMCP task result blocks above.
