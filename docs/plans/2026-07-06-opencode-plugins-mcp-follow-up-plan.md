---
title: OpenCode Plugins and MCP Follow-up KISS Plan
date: 2026-07-06
status: proposed
done: false
issue: unlinked
source_audit: opencode-plugins-mcp-context7-evaluation-2026-07-06
opmcp00_scheduler_reintroduction_guard_done: false
opmcp01_plugin_config_contract_snapshot_done: false
opmcp02_mcp_config_contract_lock_done: false
opmcp03_opencode_1_17_13_upgrade_spike_done: false
opmcp04_regression_bundle_done: false
---

# OpenCode Plugins and MCP Follow-up KISS Plan

## Goal

Bring Veslo's OpenCode plugin and MCP integration back into a clear, testable
contract after the OpenCode `1.17.4` upgrade, without mixing unrelated schema
migration, cold-start remediation, and SDK upgrade work in one change.

The immediate product rule is:

- Veslo must not reintroduce OpenCode plugins that were removed because they
  blocked useful OpenCode startup paths.
- Veslo must keep writing MCP config in the shape accepted by the installed
  OpenCode SDK/runtime.
- Veslo must not migrate from `plugin` to `plugins` only because docs mention a
  newer v2 schema unless the installed/runtime package contract confirms it.
- Future OpenCode package upgrades must happen as an explicit compatibility
  slice across app, orchestrator, router, plugin package pins, and lockfile.

## Current Audit Summary

The current checkout pins:

- `@opencode-ai/sdk@1.17.4`
- `@opencode-ai/plugin@1.17.4`
- managed OpenCode plugin runtime dependency `@opencode-ai/plugin@1.17.4`

NPM latest was checked on 2026-07-06 and returned `1.17.13` for:

- `@opencode-ai/sdk`
- `@opencode-ai/plugin`
- `opencode-ai`

Context7 OpenCode docs show v2 plugin configuration examples using `plugins`,
but the installed `@opencode-ai/plugin@1.17.4` package still types plugin config
as singular `plugin?: Array<string | [string, PluginOptions]>`. Local Veslo
plugin listing and materialization currently read and write singular `plugin`.

Context7 OpenCode/MCP docs and the installed SDK agree on the current MCP config
shape used by Veslo:

- `mcp.<name>.type = "local"` with `command: string[]`
- `mcp.<name>.type = "remote"` with `url: string`
- optional `enabled`, `headers`, `oauth`, `environment`/`env`

The current repo root `opencode.jsonc` contains `plugin: ["opencode-scheduler"]`,
but `docs/fixes/2026-07-03-fix-26-opencode-plugin-autoload-disable.md` states
that the scheduler plugin was removed from the repo root config because it made
OpenCode process health false-green while useful API endpoints timed out. The
platform managed plugin policy still defines `opencode-scheduler` as hidden,
locked-on, and `autoInstall: true`, so managed plugin materialization can
reintroduce it.

## KISS Boundary

Core for this plan:

- Remove the scheduler reintroduction path first.
- Preserve current MCP routes and app workflow unless a contract mismatch is
  proven.
- Capture the local plugin config contract before any schema migration.
- Keep the OpenCode `1.17.13` upgrade as a separate spike.

Out of scope for the first implementation slice:

- Replacing OpenCode as the runtime.
- Migrating all plugin config from `plugin` to `plugins`.
- Reworking the Plugins, Skills, and MCP product surfaces into one system.
- Adding plugin lazy-loading.
- Changing Den connector OAuth architecture.

## OPMCP00: Scheduler Reintroduction Guard

done: false

### Goal

Ensure Veslo no longer seeds, suggests, or materializes `opencode-scheduler`
into active OpenCode config by default.

### Implementation

- Remove `opencode-scheduler` from the repo root `opencode.jsonc`.
- Change `packages/server/src/platform-managed-plugins.ts` so
  `OPENCODE_SCHEDULER_PLATFORM_PLUGIN` cannot auto-materialize by default.
  Prefer the smallest explicit change:
  - set `autoInstall: false`; or
  - remove it from `PLATFORM_PLUGIN_POLICIES` if no runtime path still needs
    the policy record.
- Keep the existing scheduled automation product/API code intact.
- Do not touch Superpowers behavior in this task.

### Acceptance

- Root `opencode.jsonc` no longer contains `opencode-scheduler`.
- A managed plugin materialization sync cannot add `opencode-scheduler` to
  project or user OpenCode config by default.
- Hidden locked policy behavior does not make an unavailable plugin appear as a
  normal user-facing install.

### Verification

```powershell
pnpm --filter veslo-server exec bun test src/tests/server.plugins.test.ts src/plugin-materializer.test.ts
pnpm --filter @neatech/veslo-ui exec bun test src/app/tests/context/extensions-plugin-client-contract.test.ts
git diff --check -- opencode.jsonc packages/server/src/platform-managed-plugins.ts packages/server/src/routes/plugins.ts packages/server/src/plugin-materializer.ts
```

If the exact server test files differ, run the closest focused plugin policy,
plugin materializer, and route tests and record the actual command.

## OPMCP01: Plugin Config Contract Snapshot

done: false

### Goal

Make the `plugin` versus `plugins` decision evidence-based for the installed
OpenCode package family.

### Implementation

- Add a small contract note or test fixture that records the installed
  `@opencode-ai/plugin@1.17.4` type contract:
  - plugin package `Config` still exposes singular `plugin`.
  - tuple entries allow `[spec, options]`.
- Add or extend unit coverage for Veslo plugin config read/write helpers:
  - string plugin entry.
  - array plugin entries.
  - tuple/object entries if Veslo starts preserving them.
  - empty/missing plugin config.
- If Context7 docs continue to show `plugins`, document this as a future-schema
  observation, not as a reason to migrate now.

### Acceptance

- Veslo has a local test or doc note explaining why singular `plugin` remains
  the active write path for `1.17.4`.
- No code path blindly converts user config from `plugin` to `plugins`.
- Any existing unmanaged plugin entries are preserved.

### Verification

```powershell
pnpm --filter veslo-server exec bun test src/tests/server.plugins.test.ts
pnpm --filter @neatech/veslo-ui exec bun test src/app/tests/context/extensions-plugin-client-contract.test.ts
git diff --check -- packages/server/src/plugins.ts packages/server/src/plugin-materializer.ts docs/plans/2026-07-06-opencode-plugins-mcp-follow-up-plan.md
```

## OPMCP02: MCP Config Contract Lock

done: false

### Goal

Lock the current MCP config contract to the installed OpenCode SDK/runtime
shape and prevent accidental drift in hub install, manual add, auth logout, and
runtime token refresh flows.

### Implementation

- Extend focused server tests for `validateMcpConfig` and route behavior:
  - local `command: string[]`.
  - remote `url`.
  - optional `enabled`.
  - optional `headers` with Veslo connector-token allowance only where expected.
  - optional `oauth: boolean | object`.
  - optional `environment` and `env` string records.
- Ensure hub MCP install emits SDK-compatible `McpLocalConfig` or
  `McpRemoteConfig`.
- Ensure runtime token refresh preserves the rest of the remote MCP config.
- Keep `chrome-devtools-mcp --isolated` seeding and legacy npx migration.

### Acceptance

- Project and global MCP listing still read `mcp.<name>` from OpenCode config.
- Manual add and hub install write config accepted by the installed SDK
  `McpLocalConfig | McpRemoteConfig`.
- Runtime status refresh handles the installed SDK status states:
  `connected`, `disabled`, `failed`, `needs_auth`,
  `needs_client_registration`.
- Chrome MCP seed remains `["chrome-devtools-mcp", "--isolated"]`.

### Verification

```powershell
pnpm --filter veslo-server exec bun test src/tests/server.mcp-routes.test.ts src/tests/server.hub-mcp.test.ts
pnpm --filter @neatech/veslo-ui exec bun test src/app/tests/context/mcp-connection-workflow.test.ts src/app/tests/lib/mcp-runtime-status-refresh.test.ts
cargo test workspace::files::tests
git diff --check -- packages/server/src/mcp.ts packages/server/src/routes/mcp.ts packages/server/src/validators.ts packages/app/src/app/context/mcp-connection-workflow.ts packages/desktop/src-tauri/src/workspace/files.rs
```

## OPMCP03: OpenCode 1.17.13 Upgrade Spike

done: false

### Goal

Evaluate the latest stable OpenCode package family separately from the scheduler
and MCP contract fixes.

### Implementation

- In an isolated branch or worktree, temporarily update:
  - `@opencode-ai/sdk`
  - `@opencode-ai/plugin`
  - `opencode-ai` sidecar/runtime references if applicable.
- Keep the version family aligned across app, orchestrator, opencode-router,
  managed dependency manifests, and lockfile.
- Diff installed `.d.ts` files for:
  - plugin config `plugin`/`plugins`.
  - plugin hook signatures.
  - MCP config types and status states.
  - `permission.v2.*` and `question.v2.*` event/reply APIs.
  - `event.subscribe` and any sync event envelope changes.
- Record any required code changes before modifying product logic.

### Acceptance

- The spike answers whether `plugins` is required, optional, or future-only for
  the target package.
- The spike identifies all compile/test failures caused by the package update.
- The spike does not land package upgrades without focused fixes and tests.

### Verification

```powershell
npm view @opencode-ai/sdk version dist-tags --json
npm view @opencode-ai/plugin version dist-tags --json
npm view opencode-ai version dist-tags --json
pnpm list @opencode-ai/sdk @opencode-ai/plugin --depth 0 -r
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-orchestrator typecheck
pnpm --filter opencode-router typecheck
```

## OPMCP04: Regression Bundle

done: false

### Goal

Verify that plugin cold-start behavior, MCP config behavior, and SDK v2 event
compatibility remain stable together after the narrow fixes are complete.

### Implementation

- Run focused plugin, MCP, and SDK v2 compatibility tests.
- Run typechecks for app, server, orchestrator, and opencode-router where
  package/API surfaces are touched.
- Run a local OpenCode smoke without `opencode-scheduler` in active config.
- Update this plan with dated notes and mark task flags only after verification.

### Acceptance

- OpenCode starts without the scheduler plugin in active config.
- `/health`, `/config`, and `/provider` are not blocked by plugin startup in the
  focused smoke window.
- MCP add/list/status/auth flows still work against the installed SDK.
- Plugin config handling remains compatible with existing user config.

### Verification

```powershell
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-orchestrator typecheck
pnpm --filter opencode-router typecheck
git diff --check
```

For installed-app smoke, record the exact binary, config path, endpoint timings,
and whether `opencode-scheduler` appears in the effective config.
