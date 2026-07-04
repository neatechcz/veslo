# Fix 26: OpenCode Plugin Autoload Disable

## Problem

Installed OpenCode cold starts were much slower when Veslo launched OpenCode
with automatic plugin autoload enabled.

The local audit showed a causal difference:

- `veslo-code.exe serve` with `plugin: ["opencode-scheduler"]` reached
  `/health`, but `/project`, `/config`, and `/provider` timed out in a 5s
  smoke window.
- The same binary with `--pure`, or with the scheduler plugin removed from the
  config, returned those endpoints normally.
- Veslo also had a managed `.opencode/plugins/veslo-automations.js` plugin path
  that could add more OpenCode plugin startup work.

This made the installed app vulnerable to a green process health signal while
the useful OpenCode API was still blocked by plugin startup.

## Fix

- Removed `opencode-scheduler` from the repo root `opencode.jsonc`.
- Removed `opencode-scheduler` from the app suggested plugin list.
- Changed server-side internal provisioning so Veslo does not write an active
  `.opencode/plugins/veslo-automations.js` by default.
- Changed desktop/Tauri internal provisioning the same way.
- Existing active `veslo-automations.js` files are renamed out of OpenCode's
  autoload directory into:

```text
.opencode/veslo/disabled-plugins/
```

- No disabled stub is left in `.opencode/plugins`, so OpenCode has no local
  automations plugin file to import.
- An explicit `VESLO_ENABLE_AUTOMATIONS_PLUGIN=1` env flag still does not
  re-enable the OpenCode plugin. This keeps the KISS behavior deterministic.

## Local Config Cleanup

The following known local/workspace/AppData OpenCode config files were cleaned
so they no longer contain `opencode-scheduler` and no longer have an empty
`plugin` property:

```text
C:\Users\jajse\Desktop\test-repo\test-repo1\opencode.jsonc
C:\Users\jajse\Desktop\test-repo\test-repo2\opencode.jsonc
C:\Users\jajse\Desktop\veslo\test-repo3\opencode.jsonc
C:\Users\jajse\AppData\Local\com.neatech.veslo\veslo-orchestrator\opencode-config\shared-unsandboxed\opencode.jsonc
C:\Users\jajse\AppData\Local\com.neatech.veslo\veslo-orchestrator\opencode-config\ws-5251eba6af25\opencode.jsonc
C:\Users\jajse\AppData\Local\com.neatech.veslo.dev\veslo-orchestrator-dev\opencode-config\shared-unsandboxed\opencode.jsonc
C:\Users\jajse\AppData\Local\com.neatech.veslo.dev\veslo-orchestrator-dev\opencode-config\ws-113b3ee2698f\opencode.jsonc
C:\Users\jajse\AppData\Local\com.neatech.veslo.dev\veslo-orchestrator-dev\opencode-config\ws-5251eba6af25\opencode.jsonc
```

Verification of those eight active config files returned:

```text
SchedulerMatches = 0
```

Known WebView cache files still contain historical strings such as
`opencode-scheduler`. Those are browser cache snapshots, not active OpenCode
config inputs, and were intentionally left alone for this KISS fix.

## Scope Boundaries

- Did not remove server-backed scheduled automations.
- Did not remove automations UI routes, stores, or API handlers.
- Did not remove the inert managed platform automations skill contract.
- Did not delete browser/WebView cache.
- Did not add plugin lazy-loading. This fix removes the startup plugin inputs
  instead of introducing a new loading system.

## Coverage

- Server provisioning tests cover:
  - no default `veslo-automations.js` plugin write,
  - renaming an existing active plugin out of autoload,
  - env flags staying disabled for the OpenCode plugin path,
  - platform managed skill materialization staying intact.
- Desktop provisioning tests cover the same default-disable and quarantine
  behavior.
- Desktop workspace file tests cover not seeding the raw scheduler plugin.
- UI scheduled automation tests continue to guard that Veslo does not send users
  through raw `opencode-scheduler` setup.

## Verification

Run on 2026-07-03:

```powershell
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/internal-system.test.ts src/platform-managed-skills.test.ts src/tests/server.skill-materialization.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec bun test src/app/pages/scheduled-automations.test.ts src/app/tests/context/extensions-plugin-client-contract.test.ts
cargo test workspace::internal_provision::tests
cargo test workspace::files::tests
git diff --check -- opencode.jsonc packages/app/src/app/constants.ts packages/server/src/internal-system.ts packages/server/src/tests/internal-system.test.ts packages/desktop/src-tauri/src/workspace/internal_provision.rs
```

Result:

- Server focused tests passed: `45` tests.
- UI focused tests passed: `18` tests.
- Desktop internal provisioning tests passed: `8` tests.
- Desktop workspace file tests passed: `12` tests.
- `git diff --check` passed with Windows LF-to-CRLF warnings only.

Installed binary smoke with:

```text
C:\Program Files\Veslo by Neatech\veslo-code.exe serve
```

returned:

- `/health`: `200`, `16 ms`
- `/project`: `200`, `233 ms`
- `/config`: `200`, `33 ms`
- `/provider`: `200`, `1761 ms`

## Status

Complete for this KISS checkpoint. Veslo no longer seeds or suggests the raw
OpenCode scheduler plugin, and managed automations plugin files are kept out of
OpenCode's autoload path by default.
