# Fix 32: OpenCode SDK Plugin MCP Compatibility

Date: 2026-07-06

## Scope

Completed the OpenCode SDK, plugin, and MCP compatibility rollout from:

```text
docs/plans/2026-07-06-opencode-sdk-plugins-mcp-implementation-plan.md
```

This checkpoint keeps Veslo on installed package behavior instead of migrating
to proposal-only config shapes.

## Version Change

- `@opencode-ai/sdk`: `1.17.4` -> `1.17.13`
- `@opencode-ai/plugin`: `1.17.4` -> `1.17.13`
- orchestrator `opencodeVersion`: `1.17.4` -> `1.17.13`
- desktop `opencodeVersion`: `1.17.4` -> `1.17.13`
- `opencode-ai` npm latest was verified as `1.17.13`

The lockfile update is limited to those OpenCode packages and their direct
transitive changes: `@ai-sdk/provider@3.0.8` and `effect@4.0.0-beta.83`.

## Plugin Config Decision

- Veslo continues to read and write singular `plugin`.
- Installed `@opencode-ai/sdk@1.17.13` still exposes
  `plugin?: Array<string | [string, options]>`.
- Veslo now preserves tuple plugin entries like
  `["package-name", { "option": "value" }]` through server list/add/remove,
  managed plugin materialization, and app installed-plugin detection.
- `plugins` remains a future/proposal question, not a Veslo write target.

## MCP Config Decision

- Veslo continues to read and write top-level `mcp.<name>` entries.
- Installed `@opencode-ai/sdk@1.17.13` still exposes top-level
  `mcp?: { [name]: McpLocalConfig | McpRemoteConfig | { enabled: boolean } }`.
- `mcp.servers`, `disabled`, object timeout budgets, and snake_case OAuth keys
  are proposal/docs shapes, not the installed package contract Veslo writes.
- Existing `mcp.servers` proposal-shape config is preserved on Veslo write
  paths while adding, removing, or refreshing current top-level `mcp.<name>`
  entries.
- The reserved MCP name `servers` is rejected on current write paths so
  proposal-shape `mcp.servers` cannot be overwritten by a current
  `mcp.<name>` mutation.
- Veslo accepts installed `enabled` sentinels and keeps
  `tools: { "<glob>": false }` support for MCP tool disabling.

## Scheduler Outcome

- Root `opencode.jsonc` no longer projects `opencode-scheduler`.
- Scheduler remains hidden, locked-on, non-startup, and `autoInstall: false`.
- Startup materialization skips scheduler; explicit background prepare reports
  deferred activation without mutating active OpenCode config.
- Windows scheduler prepare is explicitly unsupported/degraded until a proven
  Windows OS scheduler command path is added.
- This checkpoint does not implement Windows OS scheduler activation; that
  remains a separate scheduler follow-up.

## SDK/Event Outcome

- Veslo's v2 SDK import surface remains valid:
  `@opencode-ai/sdk/v2/client` exports `createOpencodeClient`.
- Installed v2 event streaming remains `event.subscribe(...)`.
- Event normalization handles direct, payload, and sync envelopes.
- Top-level permission/question replies remain available, and v2 session-scoped
  permission/question replies remain available as fallbacks.

## Verification

Run on 2026-07-06:

```powershell
npm view @opencode-ai/sdk version dist-tags --json
npm view @opencode-ai/plugin version dist-tags --json
npm view opencode-ai version dist-tags --json
corepack pnpm@10.27.0 install --lockfile-only
corepack pnpm@10.27.0 install --frozen-lockfile
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
corepack pnpm@10.27.0 --filter veslo-orchestrator typecheck
corepack pnpm@10.27.0 --filter veslo-code-router typecheck
corepack pnpm@10.27.0 --filter veslo-server typecheck
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/utils/messages-normalize-event.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/context/session-runtime-prompts.test.ts src/app/tests/utils/promise-timeout.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pending-session-send-flow.test.ts src/app/tests/context/mcp-connection-workflow.test.ts src/app/tests/lib/mcp-runtime-status-refresh.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec bun test src/app/tests/context/extensions-plugin-client-contract.test.ts src/app/tests/utils/plugins.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec bun test src/app/tests/context/extensions-plugin-policy.test.ts src/app/tests/context/extensions-plugin-client-contract.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-server-registry.test.ts
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server-conversations.test.ts src/tests/server.automations.test.ts src/tests/server.mcp-routes.test.ts src/tests/server.hub-mcp.test.ts src/tests/validators.test.ts src/tests/server.plugins-routes.test.ts src/tests/plugin-materializer.test.ts
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/plugin-policy.test.ts src/tests/server.plugins-routes.test.ts src/tests/plugin-materializer.test.ts
corepack pnpm@10.27.0 --filter veslo-orchestrator exec bun test src/tests/opencode-event-normalization.test.ts src/tests/runtime-engine-state.test.ts
corepack pnpm@10.27.0 --filter veslo-code-router exec bun test test/events.test.js test/permission-reply.test.js
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --lib workspace::files
git diff --check
```

Results:

- NPM latest was `1.17.13` for all three OpenCode packages.
- All four package typechecks passed.
- App node-test bundle: `56` passed.
- App plugin policy/client bundle: `11` passed.
- App plugin utility bundle: `3` passed.
- App workspace registry focused test: `7` passed.
- Server conversation/MCP/plugin bundle: `106` passed, `4` symlink tests
  skipped.
- Server scheduler/plugin-policy bundle: `43` passed, `4` symlink tests
  skipped.
- Orchestrator event/runtime bundle: `8` passed.
- Router targeted event/permission bundle: `8` passed.
- Router `test:unit` bundle: `23` passed.
- Desktop workspace-file Rust tests: `12` passed.
- `git diff --check` passed with LF/CRLF warnings only.

Router boundary:

- Bridge E2E-style router tests remain outside the router unit gate and were
  not part of this OpenCode SDK/plugin/MCP checkpoint.

## Post-Review Closure

After the final plan evaluation, the remaining non-E2E issues were closed:

- MCP write paths now preserve existing proposal-shape `mcp.servers` config
  while mutating only current top-level `mcp.<name>` entries.
- Router `test:unit` now runs a Windows-safe unit runner that includes all
  non-bridge `test/*.test.js` files instead of the Windows/Bun-sensitive
  shell glob.
- Live Pilot source/scenario changes remain outside the SDK/plugin/MCP
  checkpoint acceptance and require their own live Den auth run before being
  treated as end-to-end complete.
- Scheduler prepare has an explicit Windows degraded assertion, making Windows
  scheduler OS activation unsupported by product decision until a proven
  Windows scheduler command path is added.
- The app typecheck blocker from the workspace server registry test double is
  resolved.

Post-review verification on 2026-07-06:

```powershell
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.mcp-routes.test.ts src/tests/server.hub-mcp.test.ts src/tests/validators.test.ts src/tests/server.plugins-routes.test.ts
corepack pnpm@10.27.0 --filter veslo-code-router exec pnpm test:unit
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
corepack pnpm@10.27.0 --filter veslo-server typecheck
git diff --check
```

Results:

- Server MCP/plugin focused bundle: `52` passed.
- Router `test:unit`: `23` passed.
- App and server typechecks passed.
- `git diff --check` passed with LF/CRLF warnings only.
- Live Pilot managed-AI acceptance was not run in this checkpoint because it
  requires the live Den auth/Pilot environment; E2E/pilot source changes remain
  outside this SDK/plugin/MCP checkpoint.

Post-audit verification:

- Reserved MCP name regression bundle:
  `corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.mcp-routes.test.ts src/tests/validators.test.ts`
  passed with `30` pass.
- Router dynamic unit runner:
  `corepack pnpm@10.27.0 --filter veslo-code-router exec pnpm test:unit`
  passed with `23` pass.
- Current dirty app managed-AI/runtime readiness focused bundle passed with
  `51` pass.
- Current E2E Pilot runner unit tests passed with `33` pass.
- Live Pilot was still not run because the live Den/Pilot auth environment
  variables were not present in this shell.

Continuation audit fixes:

- Local Veslo server ensure now keeps independent in-flight entries per
  readiness mode, so a server-only materialization startup cannot break
  deduplication for an overlapping runtime-chain ensure.
- Live managed-AI Pilot acceptance now rejects bracketed IPv6 localhost gateway
  overrides such as `http://[::1]:8788`, matching the existing IPv4 loopback
  guard.
- Desktop/orchestrator managed dependency manifests now expect the upgraded
  OpenCode plugin package version `1.17.13`.
- Changed Pilot TOML scenarios parsed through `tomllib`, and their embedded
  eval scripts parsed as async JavaScript before a live Pilot run.
- Targeted native manifest tests passed via `cargo test manifest`.

## Worktree Note

The current worktree also contains unrelated existing dirty E2E/pilot,
server-access, and documentation changes. They were not reverted or folded into
this fix note.

## Status

Complete for the SDK/plugin/MCP compatibility checkpoint.
