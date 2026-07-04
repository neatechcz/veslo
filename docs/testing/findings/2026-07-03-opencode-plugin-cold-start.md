# OpenCode Plugin Cold Start Finding

Date: 2026-07-03

Scope: read-only audit of OpenCode cold starts, plugin loading, Veslo OpenCode
config generation, runtime config mirrors, and the observed `opencode --pure`
speed difference.

## Summary

The `opencode --pure` speed difference is real and points at external
OpenCode plugin/config loading, not at the basic OpenCode server process.

OpenCode `serve` can return `/health` quickly while project bootstrap endpoints
such as `/project`, `/config?directory=...`, and `/provider?directory=...` are
blocked by plugin/config work. Veslo currently treats engine health as the main
cold-start readiness gate, so `/health` alone is not enough evidence that a
workspace is ready to answer.

The strongest local culprit is `opencode-scheduler`:

- Root workspace config `opencode.jsonc` contains `plugin: ["opencode-scheduler"]`.
- Veslo AppData mirrored OpenCode configs also contain `opencode-scheduler`.
- The package was not present in the checked `node_modules`,
  `.opencode/node_modules`, or Veslo AppData config `node_modules` locations.
- Veslo tests and UI copy already say raw `opencode-scheduler` should not be
  auto-installed for scheduled automations.

## OpenCode Behavior

OpenCode documentation says:

- `--pure` runs without external plugins.
- Plugins are loaded from global config, project config, global plugin
  directory, and project plugin directory.
- Local MCP servers are configured in `mcp` with a local command, and enabled
  servers can be part of project readiness.

No official lazy-load plugin mechanism was found. The current practical choices
are to start without the plugin, restart with a plugin when explicitly enabled,
or move the behavior to Veslo server-backed skills/tools that do not require an
OpenCode plugin import during project bootstrap.

Docs checked:

- https://opencode.ai/docs/cli
- https://opencode.ai/docs/plugins
- https://opencode.ai/docs/config
- https://opencode.ai/docs/mcp-servers

## Veslo Current State

Relevant implementation signals:

- `packages/orchestrator/src/cli.ts` starts OpenCode as
  `opencode serve --hostname ... --port ...`; it does not pass `--pure`.
- The orchestrator mirrors workspace `opencode.jsonc` / `opencode.json` into an
  `OPENCODE_CONFIG_DIR` under AppData before spawning the engine.
- `packages/desktop/src-tauri/src/engine/spawn.rs` also starts direct desktop
  OpenCode as `serve --hostname --port --cors *`; it does not pass `--pure`.
- Desktop and server watchers classify `.opencode/plugins` changes as
  `plugins`, but server provisioning routes currently emit mostly `skills` and
  `agents` reload reasons even when provisioning may touch plugin files.

## Local Disk Evidence

Observed configs with `opencode-scheduler`:

- `C:\Users\jajse\Desktop\projekty\veslo\opencode.jsonc`
- `C:\Users\jajse\Desktop\test-repo\test-repo1\opencode.jsonc`
- `C:\Users\jajse\Desktop\test-repo\test-repo2\opencode.jsonc`
- `C:\Users\jajse\Desktop\veslo\test-repo3\opencode.jsonc`
- `C:\Users\jajse\AppData\Local\com.neatech.veslo\veslo-orchestrator\opencode-config\shared-unsandboxed\opencode.jsonc`
- `C:\Users\jajse\AppData\Local\com.neatech.veslo\veslo-orchestrator\opencode-config\ws-5251eba6af25\opencode.jsonc`
- `C:\Users\jajse\AppData\Local\com.neatech.veslo.dev\veslo-orchestrator-dev\opencode-config\shared-unsandboxed\opencode.jsonc`
- `C:\Users\jajse\AppData\Local\com.neatech.veslo.dev\veslo-orchestrator-dev\opencode-config\ws-113b3ee2698f\opencode.jsonc`
- `C:\Users\jajse\AppData\Local\com.neatech.veslo.dev\veslo-orchestrator-dev\opencode-config\ws-5251eba6af25\opencode.jsonc`

Observed missing package checks:

- No `opencode-scheduler` in repo `node_modules`.
- No `opencode-scheduler` in repo `.opencode/node_modules`.
- No `opencode-scheduler` in the inspected Veslo AppData config
  `node_modules` directories.
- Test workspaces had `.opencode/node_modules/@opencode-ai/plugin` and `zod`,
  but not `opencode-scheduler`.

Additional stale plugin risk:

- `test-repo1`, `test-repo2`, and `test-repo3` had active
  `.opencode/plugins/veslo-automations.js` files.
- The file content says it is Veslo-managed and registers automation tools.
- Current provisioning tests expect this plugin to be disabled by default or
  renamed out of autoload, so these files look like stale workspace artifacts.

## Controlled Smoke Result

Binary used:

- `C:\Program Files\Veslo by Neatech\veslo-code.exe`
- Version: `1.17.4`

The smoke test started `veslo-code.exe serve` on a temp workspace, waited for
`/health`, then queried project readiness endpoints.

| Case | Plugin config | Pure | `/health` | `/project` | `/config` | `/provider` |
| --- | --- | --- | --- | --- | --- | --- |
| normal with scheduler | `plugin: ["opencode-scheduler"]` | no | ~1.3s, 200 | timeout after 5s | timeout after 5s | timeout after 5s |
| pure with scheduler | same config | yes | ~1.3s, 200 | 97ms, 200 | 111ms, 200 | ~2.0s, 200 |
| normal without plugin | no plugin entry | no | ~1.3s, 200 | 91ms, 200 | 112ms, 200 | ~1.75s, 200 |

Interpretation:

- The server process can be healthy while project bootstrap is not usable.
- The slowdown/timeout is isolated to the plugin entry, not to provider/config
  probing in general.
- `--pure` bypasses the failing path because it ignores external plugins.

## Tests Run

Server:

```powershell
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/internal-system.test.ts src/tests/server.skill-materialization.test.ts src/platform-managed-skills.test.ts src/tests/jsonc.test.ts
```

Result: 47 pass, 0 fail.

Orchestrator:

```powershell
corepack pnpm@10.27.0 --filter veslo-orchestrator exec bun test src/tests/opencode-managed-dependencies.test.ts src/tests/shared-opencode-engine.test.ts src/tests/engine-paths.test.ts src/tests/router-proxy.test.ts
```

Result: 41 pass, 0 fail.

UI:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec bun test src/app/pages/scheduled-automations.test.ts src/app/tests/context/extensions-plugin-client-contract.test.ts src/app/tests/pages/settings-runtime-preferences.test.ts
```

Result: 20 pass, 0 fail.

Desktop Rust:

```powershell
cargo test workspace::files::tests
cargo test workspace::internal_provision::tests
```

Results: 12 pass, 0 fail; 8 pass, 0 fail.

## KISS Follow-Up

1. Remove or migrate away legacy `opencode-scheduler` entries from
   Veslo-managed/project configs unless the user explicitly installed that raw
   OpenCode plugin.
2. Ensure provisioning cleanup that touches `.opencode/plugins` emits a
   `plugins` reload reason, not only `skills` or `agents`.
3. Add cold-start diagnostics that separately record:
   - `/health` readiness time
   - `/project` readiness time
   - `/config?directory=...` readiness time
   - `/provider?directory=...` readiness time
   - effective plugin list from workspace config and `OPENCODE_CONFIG_DIR`
4. Keep `--pure` as a diagnostic escape hatch, not as the first production fix,
   because it would also disable legitimate user plugins.

## Acceptance Criteria

- A workspace without explicitly user-installed OpenCode plugins should not
  contain `opencode-scheduler` in `opencode.jsonc` or mirrored AppData config.
- OpenCode project readiness should not be considered complete based only on
  `/health`.
- A stale Veslo-managed `.opencode/plugins/veslo-automations.js` is renamed or
  otherwise moved out of plugin autoload when automations plugin mode is not
  explicitly enabled.
- Plugin cleanup triggers a plugin reload notification.
- `opencode --pure` should no longer be materially faster for normal Veslo
  cold starts unless the user has installed third-party plugins.
