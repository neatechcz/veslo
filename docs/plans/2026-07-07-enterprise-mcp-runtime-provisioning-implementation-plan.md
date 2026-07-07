---
title: Enterprise MCP Runtime Provisioning Implementation Plan
date: 2026-07-07
status: proposed
done: false
issue: unlinked
source_audit:
  - mcp-current-runtime-audit-2026-07-07
  - context7-opencode-mcp-docs-2026-07-07
  - context7-mcp-lifecycle-docs-2026-07-07
  - mcp-plan-evaluation-hardening-2026-07-07
emcp00_baseline_contract_done: false
emcp01_inventory_and_policy_model_done: false
emcp01a_provenance_and_migration_guardrails_done: false
emcp02_runtime_config_migration_done: false
emcp03_enterprise_local_mcp_packaging_done: false
emcp04_remote_mcp_first_class_path_done: false
emcp05_activation_state_machine_done: false
emcp06_status_diagnostics_done: false
emcp07_global_config_isolation_done: false
emcp08_cross_os_install_readiness_done: false
emcp09_security_and_governance_done: false
emcp10_e2e_and_pilot_coverage_done: false
emcp11_rollout_and_rollback_done: false
emcp12_docs_and_support_runbooks_done: false
kiss_phase0_audit_done: false
kiss_phase1_chrome_runtime_hygiene_done: false
kiss_phase2_enterprise_expansion_done: false
---

# Enterprise MCP Runtime Provisioning Implementation Plan

## Goal

Make Veslo's MCP integration deterministic, fast, cross-platform, and safe
enough for larger company deployments.

The target product rule:

- Default workspace startup must not depend on `npx`, `npm exec`, package
  registry availability, shell profile state, or user-global MCP config.
- User-visible MCP installation must separate config write, runtime activation,
  authentication, and tool availability.
- Veslo-managed MCPs must have a deterministic install/readiness model on
  Windows, macOS, and Linux.
- Remote MCP must be the default enterprise answer for SaaS connectors where
  local execution is not required.
- Local MCP must be used only for local capabilities such as browser/device,
  filesystem, developer tooling, or explicitly approved user workflows.
- Enterprise admins must be able to review, allow, deny, pin, update, and audit
  MCP servers before they affect users.
- No long-lived OAuth, connector, gateway, or runtime token may be persisted in
  user-authored workspace config.
- The implementation must remain compatible with the installed OpenCode
  package contract while preserving future `mcp.servers` config without
  mutating it accidentally.

## Documentation And Contract Notes

Context7 OpenCode docs show two relevant config families:

- Current/public docs use top-level `mcp.<name>` entries and `tools` boolean
  globs such as `{ "my-mcp*": false }`.
- OpenCode v2/spec docs show a future/proposal shape with `mcp.servers`,
  `disabled`, and object timeout budgets `{ startup, request }`.
- OpenCode v2/spec docs distinguish startup timeout from request timeout.
  Veslo should model both internally even while the installed runtime accepts
  only the current config shape.

Veslo must keep writing the installed runtime shape until the installed SDK and
sidecar OpenCode package prove otherwise. The current repo already preserves
proposal-shape `mcp.servers` and rejects `servers` as an MCP name; keep that.

MCP protocol optimization boundary:

- MCP startup cannot skip protocol initialization. A client must connect,
  send `initialize`, receive capabilities, send `notifications/initialized`,
  and list tools when tools are supported.
- Preinstalling MCP packages only removes command/package bootstrap cost. It
  does not remove MCP handshake, tool discovery, auth, network, or browser
  startup cost.
- Therefore "download MCPs" is necessary for local MCPs, but not sufficient.

## Current Evidence To Preserve

Current source-side behavior:

- Repo root `opencode.jsonc` uses `chrome-devtools-mcp --isolated`.
- Chrome DevTools MCP sidecar is now vendored-first through
  `chrome-devtools-mcp-package`, not `npm exec`.
- Workspace seeding removes legacy `opencode-scheduler` and migrates
  `npx -y chrome-devtools-mcp@latest --isolated`.
- App MCP auto refresh does not probe runtime status by default.
- Runtime status errors are recorded without clearing last-known statuses.
- MCP connection already preserves written config when runtime activation
  fails.
- OpenCode is currently launched with Veslo sidecar paths prepended to `PATH`.
  That makes `chrome-devtools-mcp` work, but enterprise readiness still needs a
  verified command-resolution invariant so a missing sidecar cannot fall back to
  user-global `npm`, `bun`, or shell shims.
- Hub remote MCP runtime tokens are currently represented as MCP headers in
  workspace config. Treat literal connector-token-at-rest as enterprise
  credential debt, not as a desired steady-state contract.

Current runtime drift to fix:

- Existing AppData OpenCode runtime config mirrors still contain stale
  `npx -y chrome-devtools-mcp@latest --isolated`.
- One dev shared-unsandboxed runtime config also contains
  `npx -y @playwright/mcp@latest`.
- One stale dev workspace runtime config still contains a literal legacy
  gateway header. Treat that as config hygiene debt in the same migration, not
  as an MCP feature requirement.

## Target Architecture

Use five distinct planes and do not blur them:

1. Config plane
   - Lists, writes, removes, and audits MCP configuration.
   - Owns compatibility between current OpenCode config and future config
     shapes.
   - Never claims runtime availability.

2. Provenance and policy plane
   - Records whether an MCP entry is Veslo-generated, hub-installed,
     admin-managed, inherited global, user-authored project config, or runtime
     mirror output.
   - Decides allowed/blocked/prompt/provision-required before activation.
   - Is the only plane allowed to classify something as safe to migrate.

3. Credential plane
   - Owns OAuth, connector runtime tokens, gateway tokens, and token refresh.
   - Injects tokens through env interpolation, memory-only runtime headers, or
     generated runtime overlays.
   - Never stores long-lived literal secrets in user-authored OpenCode config.

4. Provisioning plane
   - Installs, verifies, pins, updates, and removes local MCP runtime packages
     or sidecars.
   - Runs before activation and can be retried independently.
   - Owns OS-specific binary/package checks.

5. Runtime activation plane
   - Starts/connects MCP servers through OpenCode.
   - Performs MCP initialize/tool discovery indirectly through OpenCode.
   - Reports activation/auth/tool availability state.
   - Never rewrites config just to retry a failed activation.

## Best Possible Solution

Use a curated, policy-first architecture:

- Enterprise SaaS integrations should be remote MCPs by default. They are
  easier to govern, audit, tenant-bind, and revoke, and they do not require
  local package managers or local executable trust.
- Browser/device/local-developer integrations should be bundled or managed
  local MCPs. They must be pinned, shipped, preflighted, and activated only
  through Veslo-controlled command resolution.
- User-provided local MCPs stay supported, but they are never cold-start
  critical and enterprise mode treats them as untrusted executable config until
  an admin/user explicitly allows them.
- Generated runtime config mirrors are disposable artifacts. User-authored
  project/global configs are durable user data. Migration rules must be much
  more aggressive for generated mirrors than for user-authored files.
- OpenCode config writes remain current-shape compatible. Veslo can model
  `mcp.servers`, startup/request timeouts, and disabled states internally, but
  it should not emit future-shape config until the installed OpenCode runtime
  proves support.
- The first production fix should remove hidden startup blockers. The durable
  enterprise solution then adds provenance, credential isolation, packaged
  local runtime, policy, diagnostics, and E2E gates in that order.

Cold-start target:

- Config/provenance scan: p95 under 250 ms for normal workspaces.
- Local MCP provisioning preflight: p95 under 1.5 s when already provisioned.
- No automatic MCP activation may delay provider submit by more than 500 ms.
- MCP startup timeout must be classified before the generic provider-start
  timeout path.

## KISS Implementation Boundary

This document is an enterprise master plan, but implementation must start with
a smaller KISS slice. Do not implement all planes at once.

### KISS Phase 0: Audit-Only Baseline

done: false

Goal: make the current drift visible without changing runtime behavior.

Scope:

- Add a redacted scanner for source config, generated runtime mirrors, and
  AppData OpenCode config mirrors.
- Report only:
  - legacy Chrome MCP commands,
  - `npx`, `npm exec`, `bun x`, `@latest`,
  - literal Veslo gateway/connector token headers,
  - whether the file appears generated/runtime or user-authored.
- Do not write, delete, disable, quarantine, or migrate anything.
- Do not introduce full provenance ledger, policy engine, token broker, or UI.

Acceptance:

- The scanner output is safe to paste into a support issue.
- It separates repo source config from generated/runtime mirrors.
- Unknown/user-authored MCP entries are reported only.

Verification:

```powershell
corepack pnpm@10.27.0 --filter veslo-orchestrator exec bun test src/tests/opencode-config-sanitizer.test.ts
git diff --check -- packages/orchestrator/src docs
```

### KISS Phase 1: Chrome Runtime Hygiene

done: false

Goal: remove the current known MCP startup blocker without building the full
enterprise policy system.

Scope:

- Migrate only exact known Chrome aliases:
  - `chrome-devtools`,
  - `control-chrome`.
- Migrate only exact known legacy commands:
  - `npx -y chrome-devtools-mcp@latest --isolated`,
  - `npx --yes chrome-devtools-mcp@latest --isolated`,
  - `npm exec --yes chrome-devtools-mcp@<version> -- --isolated`.
- Rewrite those commands to `chrome-devtools-mcp --isolated`.
- Apply automatic writes only to generated/runtime mirrors or exact known
  workspace Chrome aliases.
- Never delete unknown MCP entries.
- Never edit user-global OpenCode config.
- Keep `mcp.servers` untouched.
- Add or extend tests for:
  - JSON and BOM-prefixed generated config,
  - future `mcp.servers` preservation,
  - non-Chrome `@playwright/mcp@latest` remains untouched and reported,
  - credential-like headers are redacted in diagnostics.
- Add a narrow sidecar resolution check for Chrome MCP:
  - expected sidecar package exists,
  - command can resolve through the Veslo controlled path,
  - missing sidecar is classified instead of falling back silently to user
    package managers.
- Add an explicit desktop path-resolution regression check:
  - cover `sidecar_path_candidates` / `prepended_path_env` behavior or the
    nearest existing desktop test owner,
  - prove Veslo sidecar/resource directories are ordered before common/user
    tool paths,
  - prove a missing Veslo Chrome sidecar produces a deterministic diagnostic
    instead of silently resolving `chrome-devtools-mcp` from global npm/bun/PATH.
- Keep provider-start correlation out of Phase 1. Phase 1 may classify
  Chrome MCP preflight/runtime hygiene before activation or during explicit MCP
  status checks, but it must not refactor the AI-gateway provider-start
  watchdog.

Out of scope for Phase 1:

- Full MCP inventory type.
- Full provenance/install ledger.
- Full enterprise policy engine.
- Full remote MCP token broker.
- UI state-machine redesign.
- Cross-OS release certification beyond documenting required follow-up gates.
- Migrating OpenCode config writes to `mcp.servers`.

Acceptance:

- Generated/default Veslo config no longer contains legacy Chrome `npx` or
  `npm exec` commands.
- Unknown/user MCP config is not deleted or rewritten.
- Literal token headers are redacted in scan/report output.
- Chrome MCP missing-runtime or command-resolution failures are classified by
  the Chrome MCP preflight/runtime hygiene path before activation or explicit
  MCP status reporting.
- Phase 1 does not change AI-gateway provider-start watchdog semantics.
- Existing app/server MCP behavior remains compatible with current clients.

Verification:

```powershell
corepack pnpm@10.27.0 --filter veslo-orchestrator exec bun test src/tests/opencode-config-sanitizer.test.ts src/tests/local-opencode-url.test.ts
node --test packages/desktop/scripts/chrome-devtools-mcp-shim.test.mjs
node --test packages/desktop/scripts/tauri-config.test.mjs
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.mcp-routes.test.ts
git diff --check
```

### KISS Phase 2: Enterprise Expansion

done: false

Start Phase 2 only after Phase 1 is verified in a real runtime. Phase 2 is where
the broader EMCP plan begins: provenance ledger, token broker, policy engine,
global inheritance controls, richer diagnostics, cross-OS CI gates, and pilot
coverage.

## MCP Classes

### Class A: Veslo-Bundled Local MCP

Examples:

- Chrome DevTools MCP.

Rules:

- Must be pinned in package manifests and sidecar version manifests.
- Must be shipped as a deterministic executable or deterministic vendored
  package resolved by a Veslo sidecar.
- Must not use `npx`, `npm exec`, `bun x`, `@latest`, shell aliases, or user
  PATH.
- Must resolve to an approved Veslo-owned absolute executable path or to a
  Veslo runner whose resolved path is verified before activation.
- Must pass a local preflight before install or activation is shown as ready.
- Must support Windows, macOS, and Linux as either:
  - target-specific sidecar binaries, or
  - a Node/package runtime vendored into the app resources with a known Node
    runtime.

### Class B: Veslo-Managed Local MCP

Examples:

- Future local MCPs that are useful but not core enough to bundle always.

Rules:

- Must be installed into a Veslo-managed runtime store, not user global npm.
- Must be pinned by exact package name, version, integrity, bin name, and
  supported OS/arch matrix.
- Must use a generated stable shim command owned by Veslo, for example:
  `veslo-mcp-run <server-id>`.
- The shim must fail closed if its resolved package/binary is outside the
  Veslo-managed runtime store.
- Must be disabled until provisioning passes.
- Must expose install/readiness status separately from OpenCode MCP status.

### Class C: Remote MCP

Examples:

- Notion, Sentry, managed Google/Microsoft connectors, org-hosted MCPs.

Rules:

- Prefer remote MCP for enterprise SaaS integrations where auth, tenant, audit,
  and network policy matter more than local execution.
- Store no user OAuth tokens in workspace config.
- Store no literal connector runtime tokens in user-authored workspace config.
- Use org-scoped runtime token headers only through a Den/Veslo token broker,
  env interpolation, memory-only runtime overlay, or generated runtime mirror
  that is explicitly marked as disposable and secret-bearing.
- Support OAuth and runtime-token refresh as first-class states.
- Validate URL, auth mode, scopes, headers, and tenant ownership before install.

### Class D: User-Provided Local MCP

Rules:

- Allowed only behind explicit user/admin consent.
- Mark as "network command" or "local command" risk when it uses `npx`, `bun x`,
  `uvx`, `docker run`, shell scripts, or unpinned package specs.
- Do not include in default cold start.
- In enterprise mode, require admin policy allowlist or workspace-owner
  approval before activation.

## Non-Goals

- Do not migrate Veslo writes to `mcp.servers` until installed OpenCode SDK and
  sidecar runtime require it.
- Do not remove support for user-owned MCP config.
- Do not delete user global OpenCode config.
- Do not use `--pure` as a production fix.
- Do not make every MCP warm at app startup. Warm only explicit or policy-pinned
  MCPs.

## EMCP00: Baseline Contract And Runtime Drift Capture

done: false

### Goal

Freeze the current source/runtime contract before changing behavior.

### Implementation

- Add or update a contract snapshot doc under `docs/dev/` recording:
  - installed `@opencode-ai/sdk` version,
  - installed OpenCode sidecar version,
  - current app/server MCP config shape,
  - current AppData runtime config drift findings,
  - current sidecar version manifest.
- Add a redacted config inspection script or test helper that can scan:
  - repo root `opencode.jsonc`,
  - global OpenCode config,
  - AppData `opencode-config/**/opencode.jsonc`,
  - shared-unsandboxed config,
  - per-workspace config mirrors.
- Redact tokens and credential-like headers in all output.

### Acceptance

- The current drift is reproducible without exposing credentials.
- The report distinguishes source config from generated/runtime mirrors.
- The report records whether any MCP command contains `npx`, `npm exec`,
  `bun x`, `@latest`, or shell-specific launchers.
- The report records whether any user-authored or generated config contains
  literal Veslo gateway or connector runtime token headers, with values
  redacted.
- The report records whether local MCP commands resolve inside Veslo-owned
  paths or through user PATH.

### Verification

```powershell
corepack pnpm@10.27.0 --filter veslo-orchestrator exec bun test src/tests/opencode-config-sanitizer.test.ts
git diff --check -- docs/dev packages/orchestrator/src
```

## EMCP01: MCP Inventory And Enterprise Policy Model

done: false

### Goal

Introduce a single inventory model that can represent local, remote, bundled,
managed, inherited, and user-provided MCPs.

### Implementation

- Add a shared MCP inventory type near existing app/server MCP types.
- Include fields:
  - `id`, `name`, `source`, `owner`, `configSource`,
  - `provenance`: `veslo-generated`, `hub-installed`, `admin-managed`,
    `user-project`, `user-global`, `runtime-mirror`, `unknown`,
  - `configMutability`: `user-authored`, `generated`, `runtime-overlay`,
  - `kind`: `bundled-local`, `managed-local`, `remote`, `user-local`,
  - `activationMode`: `manual`, `on-demand`, `startup`,
  - `provisioningStatus`,
  - `runtimeStatus`,
  - `authStatus`,
  - `riskLevel`,
  - `supportedOs`,
  - `requiresNetworkAtRuntime`,
  - `requiresNetworkAtInstall`,
  - `pinnedVersion`,
  - `effectiveCommand`,
  - `resolvedExecutablePath`,
  - `resolvedExecutableTrust`: `veslo-sidecar`, `veslo-store`, `user-path`,
    `unknown`,
  - `credentialMode`: `none`, `env`, `memory-overlay`,
    `generated-runtime-header`, `literal-user-config`,
  - `disabledByTools`,
  - `policyDecision`.
- Extend server MCP listing responses without breaking current clients.
- Keep current `McpItem` fields stable and add optional details.
- Add policy decisions:
  - `allowed`,
  - `blocked_by_admin`,
  - `requires_approval`,
  - `requires_local_provisioning`,
  - `unsupported_on_device`,
  - `disabled_in_config`.

### Acceptance

- UI can show inherited/global MCPs separately from project MCPs.
- UI can show whether a local MCP is deterministic or network-resolved.
- UI can show whether a local MCP resolves inside a Veslo-owned path or through
  user PATH.
- UI can show whether a remote MCP has literal credentials in user-authored
  config.
- Enterprise policy can block activation without deleting config.
- Existing list/add/remove routes remain backward-compatible.

### Verification

```powershell
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.mcp-routes.test.ts src/tests/server.hub-mcp.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/mcp-server-refresh.test.ts
```

## EMCP01A: Provenance And Migration Guardrails

done: false

### Goal

Make runtime config migration safe before any cleanup can delete, disable, or
rewrite ambiguous MCP entries.

### Implementation

- Add an MCP provenance classifier shared by server/orchestrator/desktop:
  - exact Veslo generated Chrome aliases,
  - hub-installed remote MCPs,
  - admin-managed policy MCPs,
  - generated runtime mirrors,
  - user-authored project config,
  - inherited user-global config,
  - unknown.
- Add generated-runtime markers to Veslo-owned OpenCode config mirrors:
  - app/build version,
  - workspace id,
  - generated timestamp,
  - migration version,
  - non-secret hash of managed MCP entries.
- Add an install ledger for hub/admin MCP installs. It should store MCP id,
  source, owner, config hash, credential mode, and timestamp, but no token
  values.
- Define migration permissions:
  - generated runtime mirrors may be rewritten after backup;
  - exact known Veslo Chrome legacy commands may be rewritten in project config;
  - user-authored unknown local MCPs may be classified and disabled by policy,
    but not deleted;
  - user-global config is read-only unless the user explicitly edits it;
  - literal secret-bearing generated mirrors are rotated and quarantined.
- Add rollback backups only for generated/runtime files. Do not back up
  secrets into general support archives.

### Acceptance

- EMCP02 can determine whether a file is generated or user-authored before
  modifying it.
- Every destructive or disabling migration has a provenance decision recorded.
- Unknown MCP entries are never deleted by automatic migration.
- Literal token values are redacted from ledger, logs, backup metadata, and
  diagnostics.

### Verification

```powershell
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.mcp-routes.test.ts src/tests/server.hub-mcp.test.ts
corepack pnpm@10.27.0 --filter veslo-orchestrator exec bun test src/tests/opencode-config-sanitizer.test.ts
git diff --check -- packages/server/src packages/orchestrator/src docs
```

## EMCP02: Runtime Config Migration And Hygiene

done: false

### Goal

Migrate stale generated/runtime OpenCode config mirrors so fixed source code is
actually reflected in the next runtime start.

### Implementation

- Add an idempotent runtime config migration owner in orchestrator or desktop
  startup.
- Require EMCP01A provenance before any migration that deletes, disables, or
  rewrites non-Chrome MCP entries.
- Migrate known legacy Chrome commands:
  - `["npx", "-y", "chrome-devtools-mcp@latest", "--isolated"]`
  - `["npx", "--yes", "chrome-devtools-mcp@latest", "--isolated"]`
  - `["npm", "exec", "--yes", "chrome-devtools-mcp@<version>", "--", "--isolated"]`
  - to `["chrome-devtools-mcp", "--isolated"]`.
- Remove or disable Veslo-owned stale browser MCPs from generated shared config
  if they were never explicitly user-installed.
- For user-owned or unknown local MCPs with `npx`/`@latest`, do not delete
  them. Mark them as network-resolved, not startup-critical, and subject to
  policy prompt/block.
- Remove legacy gateway credential headers from generated provider config and
  force regeneration to `{env:VESLO_OPENCODE_SERVER_CLIENT_TOKEN}`.
- Remove literal `X-Veslo-Connector-Token` values from user-authored MCP config
  after the credential plane can supply runtime tokens through env/overlay.
  Generated runtime mirrors may keep short-lived runtime headers only when
  marked secret-bearing and excluded from support export.
- Preserve user comments where practical. If the runtime mirror is generated
  JSON rather than user-authored JSONC, pretty-print JSON is acceptable.
- Emit migration audit events with redacted before/after command summaries.
- Quarantine ambiguous generated config instead of silently deleting it.

### Acceptance

- Existing AppData runtime configs no longer contain Veslo-owned
  `chrome-devtools-mcp@latest`.
- Generated shared runtime config does not contain `@playwright/mcp@latest`
  unless an explicit user/admin install record exists.
- User-authored MCP entries with `@playwright/mcp@latest`, `npx`, `npm exec`,
  `bun x`, `uvx`, or `docker run` are classified and policy-gated, not deleted.
- User-authored config does not contain literal `X-Veslo-Connector-Token`,
  `x-veslo-gateway-token`, or equivalent long-lived token headers after
  migration.
- Runtime config migration is safe to run repeatedly.
- No user global config is modified.
- No credential values are logged.

### Verification

```powershell
corepack pnpm@10.27.0 --filter veslo-orchestrator exec bun test src/tests/opencode-config-sanitizer.test.ts src/tests/local-opencode-url.test.ts
rg -n "chrome-devtools-mcp@latest|@playwright/mcp@latest|X-Veslo-Connector-Token|x-veslo-gateway-token" "$env:LOCALAPPDATA\com.neatech.veslo*\**\opencode.jsonc"
git diff --check
```

Use a PowerShell-safe targeted scan in tests; the `rg` line is manual
acceptance evidence, not a required portable test command.

## EMCP03: Enterprise Local MCP Packaging

done: false

### Goal

Make local MCP startup deterministic without relying on user package managers.

### Implementation

- Extend the existing managed dependency manifest concept to MCP runtime
  packages.
- Define a manifest schema:
  - `schemaVersion`,
  - `mcpServers[]`,
  - server `id`, `version`, `packageName`,
  - `bin`,
  - `resolvedCommandMode`: `absolute-sidecar`, `veslo-runner`,
    `controlled-path`,
  - `target` or vendored package path,
  - files with integrity hashes,
  - supported OS/arch,
  - minimum Node/runtime requirement,
  - default args,
  - preflight probes.
- Keep Chrome DevTools MCP as the first fully bundled local MCP.
- For each bundled/managed local MCP, generate a stable shim command:
  - Windows: signed `.exe` sidecar or `.cmd` only if OpenCode launches through
    a controlled shell-free path.
  - macOS: signed/notarized sidecar where applicable.
  - Linux: executable sidecar or vendored Node entrypoint with execute bits.
- Prefer a generated runtime overlay with either an absolute sidecar path or
  `veslo-mcp-run <server-id>`. Do not write app-resource absolute paths into
  user-authored project config.
- Before activation, resolve the effective command and assert it is inside an
  approved Veslo sidecar/resource/runtime-store directory.
- If OpenCode must receive a bare command for compatibility, launch OpenCode
  with a controlled path contract and record the resolved executable path in
  diagnostics. Missing Veslo sidecar must fail closed instead of falling
  through to user-global `npm`, `bun`, or shell shims.
- Add provisioning into the same startup phase that already ensures OpenCode
  managed plugin/provider dependencies.
- Fail closed: if provisioning fails, config can remain installed but runtime
  activation is blocked with a specific reason.

### Acceptance

- No Veslo-bundled local MCP uses `npx`, `npm exec`, `bun x`, `@latest`, or
  user PATH.
- A missing Veslo sidecar cannot resolve to a user-global executable with the
  same name.
- The effective resolved executable path is visible in redacted diagnostics.
- Missing package files produce `mcp_provisioning_missing_runtime`, not generic
  MCP failure.
- Version mismatch produces `mcp_provisioning_version_mismatch`.
- Provisioning works from packaged app resources on Windows, macOS, and Linux.

### Verification

```powershell
corepack pnpm@10.27.0 --filter veslo-orchestrator exec bun test src/tests/opencode-managed-dependencies.test.ts
node --test packages/desktop/scripts/chrome-devtools-mcp-shim.test.mjs
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml manifest
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml sidecar
```

Add Linux/macOS CI equivalents before marking this done.

## EMCP04: Remote MCP First-Class Enterprise Path

done: false

### Goal

Make remote MCP the preferred enterprise path for SaaS connectors and org-wide
integrations.

### Implementation

- Extend Den/org MCP catalog entries with:
  - auth owner,
  - tenant binding,
  - scopes,
  - data classification,
  - admin approval status,
  - credential storage mode,
  - token TTL and refresh grace window,
  - runtime token path,
  - disconnect path,
  - health/status path,
  - allowed workspace/org scopes.
- Keep runtime tokens out of user-authored config.
- Prefer OpenCode header env interpolation when supported by the installed
  runtime. Otherwise use a generated runtime mirror/overlay that is marked
  secret-bearing, short-lived, excluded from support export, and recreated from
  the token broker.
- Add a token refresh policy:
  - refresh on auth-like MCP status failures,
  - bounded retry count,
  - jittered backoff,
  - per-connector circuit breaker,
  - audit event for refresh success/failure,
  - no token body in logs.
- Add remote MCP preflight:
  - URL scheme and host validation,
  - optional org allowlist,
  - status endpoint,
  - auth readiness,
  - tenant ownership,
  - TLS and proxy classification.
- Add a disconnect/revoke path that clears broker state and regenerates the
  runtime mirror without secret headers.

### Acceptance

- Enterprise SaaS MCPs can be installed without local package managers.
- OAuth/token state is visible independently from config state.
- Token refresh cannot loop indefinitely.
- No literal connector runtime token remains in user-authored project/global
  config.
- Generated runtime mirrors containing short-lived connector headers are marked
  secret-bearing and excluded from support export.
- Admin can disable a remote MCP without deleting workspace config.

### Verification

```powershell
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.hub-mcp.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/mcp-connection-workflow.test.ts src/app/tests/lib/mcp-runtime-status-refresh.test.ts
```

## EMCP05: Activation State Machine

done: false

### Goal

Make MCP installation and activation understandable and retryable.

### Implementation

- Introduce explicit states:
  - `not_configured`,
  - `configured`,
  - `provisioning_required`,
  - `provisioning`,
  - `provisioning_failed`,
  - `activation_pending`,
  - `runtime_connecting`,
  - `runtime_connected`,
  - `runtime_failed`,
  - `credential_required`,
  - `credential_refreshing`,
  - `credential_refresh_failed`,
  - `auth_required`,
  - `auth_in_progress`,
  - `policy_blocked`,
  - `unsupported_on_device`,
  - `disabled`.
- Preserve existing behavior where config write success survives runtime
  activation failure.
- Add "Retry activation" that only calls runtime activation/status, not config
  rewrite.
- Add "Repair install" that only reruns provisioning.
- Add "Refresh credentials" that only calls the credential plane and then
  retries activation with bounded retry rules.
- Add "Disable in this workspace" through supported config/tool policy.
- Add bounded activation timeouts and classify:
  - command missing,
  - command resolved outside Veslo-owned path,
  - startup timeout,
  - auth required,
  - credential expired,
  - credential missing,
  - remote 401/403,
  - TLS/network failure,
  - unsupported OS.

### Acceptance

- A failed runtime activation no longer looks like failed install.
- Retrying activation does not duplicate config entries.
- Users can see whether action is needed by admin, local device, OAuth, or
  runtime.
- Credential refresh failure does not duplicate or rewrite MCP config entries.
- Active conversation sends are not interrupted by automatic MCP activation.

### Verification

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/mcp-connection-workflow.test.ts src/app/tests/lib/mcp-runtime-status-refresh.test.ts
```

## EMCP06: Status Diagnostics And Performance Telemetry

done: false

### Goal

Make MCP startup/status delays diagnosable before they appear as unrelated
30-second provider-start failures.

### Implementation

- Add structured timings for:
  - config read,
  - provenance classification,
  - policy evaluation,
  - provisioning preflight,
  - runtime `mcp.add`,
  - runtime `mcp.status`,
  - OAuth start/callback,
  - token refresh,
  - OpenCode provider-start watch.
- Record effective MCP entries with source and risk classification.
- Add correlation IDs linking:
  - MCP activation/status,
  - OpenCode session/run,
  - provider-start watch.
- Preserve last-known status on transient failures.
- Add developer diagnostics route or export:
  - redacted effective config,
  - MCP inventory,
  - provenance decisions,
  - policy decisions,
  - credential mode without token values,
  - resolved executable path and trust class,
  - runtime status map,
  - recent activation errors,
  - sidecar/provisioning status.
- Add SLO checks:
  - config/provenance scan p95 under 250 ms,
  - already-provisioned local MCP preflight p95 under 1.5 s,
  - automatic MCP work adds under 500 ms to provider submit path,
  - MCP startup timeout is classified before generic provider-start timeout.

### Acceptance

- A local MCP command timeout is reported as MCP startup timeout, not only
  "provider request did not start".
- Diagnostics show whether OpenCode was blocked before provider call.
- Redacted diagnostics are safe to attach to support tickets.
- A regression over the MCP startup SLO fails tests or pilot acceptance instead
  of being treated as cosmetic telemetry.

### Verification

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/mcp-runtime-status-refresh.test.ts src/app/tests/app-send-latency-trace.test.ts
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.opencode-proxy-timeout.test.ts
```

## EMCP07: Global Config Isolation For Managed Runtime

done: false

### Goal

Prevent user-global MCP config from silently becoming enterprise runtime
startup behavior.

### Implementation

- Keep listing global MCP entries for transparency.
- In Veslo-managed/shared runtime config, do not auto-activate inherited global
  local MCPs unless policy allows it.
- Add a config overlay or tool disable pattern for inherited MCPs when running
  managed enterprise mode.
- Surface inherited entries as:
  - `source: config.global`,
  - `provenance: user-global`,
  - `policyDecision: requires_approval` or `blocked_by_admin`,
  - risk label for local command/network command.
- In managed enterprise mode, inherited global local MCPs default to
  not-startup-critical even if OpenCode would normally inherit them.
- Never edit `~/.config/opencode/opencode.jsonc` without explicit user action.

### Acceptance

- Enterprise managed runtime is not affected by hidden user-global `npx` MCPs.
- Users can still see and explicitly enable inherited MCPs where policy allows.
- Project config can intentionally override global entries.
- A hidden global MCP cannot delay default workspace provider submit.

### Verification

```powershell
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.mcp-routes.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/mcp-server-refresh.test.ts
```

## EMCP08: Cross-OS Install Readiness

done: false

### Goal

Make the same MCP policy work predictably on Windows, macOS, and Linux.

### Implementation

- Add OS/arch readiness probes:
  - executable exists,
  - executable bit or Windows executable format,
  - binary hash matches sidecar/version manifest,
  - sidecar directory present in controlled PATH,
  - resolved command path is inside an approved Veslo directory,
  - Node/runtime availability if needed,
  - browser availability for browser MCPs,
  - sandbox/shared engine compatibility.
- Windows:
  - avoid PowerShell/cmd shell dependency for managed commands;
  - use direct executable sidecars where possible;
  - verify long paths and spaces in user profile paths;
  - verify `.cmd` is not used unless the launch path is explicitly controlled;
  - verify hidden sidecar launch does not flash a console window.
- macOS:
  - verify signed/notarized sidecars or documented quarantine handling;
  - verify app translocation/resource path behavior;
  - verify executable permissions survive packaging and auto-update.
- Linux:
  - verify AppImage/deb/rpm resource path;
  - verify executable bits after packaging;
  - verify headless/browser availability classification;
  - verify no distro-global package manager is required at runtime.
- WSL:
  - do not route Windows-only browser MCP commands into WSL sandbox unless
    explicitly supported.

### Acceptance

- Each managed local MCP reports unsupported OS before activation.
- Install readiness can be run without starting OpenCode.
- CI or release verification covers all packaged resource names.
- Chrome MCP deterministic packaging is verified on Windows, macOS, and Linux
  before broader inventory/state-machine UI can be marked complete.
- The same test fixture covers paths with spaces on all supported OSes.

### Verification

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo run prepare:sidecar
node scripts/release/verify-bundled-versions.mjs
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml runtime_preferences
```

Add macOS/Linux release verification jobs before marking complete.

## EMCP09: Security And Governance

done: false

### Goal

Make MCP safe for large organizations with admin policy, auditability, and
clear trust boundaries.

### Implementation

- Add org/workspace MCP policy:
  - allowed remote hosts,
  - allowed local MCP package IDs,
  - blocked command launchers,
  - required approval for local command MCP,
  - default local executable policy for enterprise mode,
  - max startup timeout,
  - max request timeout,
  - data classification labels,
  - allowed workspace scopes.
- Block generated/default config from using:
  - `@latest`,
  - `npx`,
  - `npm exec`,
  - `bun x`,
  - shell scripts,
  - commands resolved outside approved Veslo roots,
  - literal token headers in user-authored config,
  - unreviewed remote URLs.
- For user-provided local MCPs, show command, cwd, env names, package/version,
  and risk label before activation.
- Enterprise managed mode defaults:
  - curated remote MCPs are allowed by catalog/policy;
  - Veslo-bundled local MCPs are allowed after provisioning;
  - admin-managed local MCPs require allowlist and exact pin;
  - user-provided local MCPs require explicit approval;
  - inherited global local MCPs are blocked or prompted, never silent startup.
- Add audit events:
  - install,
  - remove,
  - enable/disable,
  - provisioning,
  - activation,
  - auth start/callback,
  - token refresh,
  - credential injection mode change,
  - command-resolution trust change,
  - policy block.
- Redact all token-like config values.

### Acceptance

- Admin can prevent local executable MCPs entirely.
- Admin can allow curated remote MCPs without allowing arbitrary remote MCPs.
- All MCP config mutations are auditable.
- All MCP activation decisions are auditable, including policy pass/block and
  resolved executable trust class.
- Logs and support exports contain no secrets.

### Verification

```powershell
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.mcp-routes.test.ts src/tests/server.hub-mcp.test.ts src/tests/validators.test.ts
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/audit.test.ts
```

Use the nearest existing audit tests if `src/tests/audit.test.ts` does not
exist yet.

## EMCP10: E2E And Pilot Coverage

done: false

### Goal

Verify real runtime behavior, not just config rows.

### Implementation

- Add a Control Chrome smoke:
  - install/enable explicit Chrome MCP,
  - run runtime status,
  - verify status is connected or classified failure,
  - verify no `npx` command in effective config,
  - verify resolved executable path is Veslo-owned,
  - verify fallback to user-global executable is impossible when sidecar is
    missing.
- Add a remote managed connector smoke:
  - install from hub,
  - auth required path,
  - token refresh path,
  - runtime status classified,
  - verify no literal connector token is written to user-authored config.
- Add a send-with-MCP scenario:
  - ensure OpenCode submit starts,
  - ensure provider-start watch is not blocked by hidden MCP startup,
  - if MCP fails, failure is classified before provider timeout.
- Add a migration smoke for stale AppData config.
- Add policy smoke:
  - inherited global `npx` MCP is listed,
  - it is blocked/prompted in enterprise mode,
  - it does not affect default send latency.

### Acceptance

- E2E proves real OpenCode MCP runtime status, not only UI cards.
- E2E proves a prompt can still reach provider path with MCP configured.
- E2E proves stale `npx chrome-devtools-mcp@latest` config is migrated.
- E2E proves no automatic MCP activation exceeds the provider-submit SLO.
- E2E proves secret-bearing runtime mirrors are excluded from diagnostics
  export.

### Verification

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-e2e test:pilot -- --scenario extensions-mcp
corepack pnpm@10.27.0 --filter @neatech/veslo-e2e test:pilot -- --scenario google-mcp-connectors
corepack pnpm@10.27.0 --filter @neatech/veslo-e2e test:pilot -- --scenario sharepoint-mcp-connectors
```

If live Den auth is unavailable, mark those scenarios skipped with a concrete
reason and do not count them as acceptance evidence.

## EMCP11: Rollout And Rollback

done: false

### Goal

Roll out the change without blocking existing users or enterprise deployments.

### Implementation

- Add feature flags:
  - `VESLO_MCP_MANAGED_LOCAL_RUNTIME=1`,
  - `VESLO_MCP_REMOTE_TOKEN_BROKER=1`,
  - `VESLO_MCP_GLOBAL_LOCAL_INHERITANCE=allow|block|prompt`,
  - `VESLO_MCP_USER_LOCAL_POLICY=allow|block|prompt`,
  - `VESLO_MCP_RUNTIME_CONFIG_MIGRATION=1`.
- Default:
  - migration on,
  - provenance ledger on,
  - remote token broker on for hub-installed MCPs,
  - bundled Chrome deterministic command on,
  - arbitrary inherited global local MCP activation prompt/block in managed
    enterprise mode,
  - user-owned project MCP config visible but not silently startup-critical.
- Add rollback:
  - disable managed local runtime,
  - disable token broker and fall back only for non-enterprise/dev mode,
  - disable migration,
  - restore previous config from backup for generated runtime mirrors only.
- Store migration backups for generated AppData config with redacted audit
  summaries.
- Roll out in rings:
  - dev/selfhost AppData migration,
  - internal Windows packaged app,
  - internal macOS/Linux packaged app,
  - small enterprise pilot with remote MCP only,
  - enterprise pilot with Chrome bundled local MCP,
  - general release.

### Acceptance

- Enterprise admin can opt out during rollout.
- Generated config migration can be rolled back.
- User-authored project/global config is not silently destroyed.
- Existing remote MCP connectors continue working.
- Token broker rollback does not leave literal connector tokens in
  user-authored config in enterprise mode.
- Ring promotion requires redacted diagnostics from at least one successful
  send-with-MCP scenario.

### Verification

```powershell
corepack pnpm@10.27.0 --filter veslo-orchestrator exec bun test src/tests/opencode-config-sanitizer.test.ts src/tests/shared-opencode-engine.test.ts
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.mcp-routes.test.ts src/tests/server.hub-mcp.test.ts
git diff --check
```

## EMCP12: Docs And Support Runbooks

done: false

### Goal

Make MCP behavior supportable by engineering, admins, and end users.

### Implementation

- Update docs:
  - `docs/features/extensions-and-integrations.md`,
  - `docs/features/session-runtime.md`,
  - `docs/dev/state-and-config-reference.md`,
  - release notes or `docs/fixes`.
- Add support runbook:
  - how to inspect effective MCP config,
  - how to inspect provenance and policy decisions,
  - how to identify `npx`/`@latest` startup blockers,
  - how to identify user-PATH command resolution,
  - how to repair provisioning,
  - how to disable inherited global MCP,
  - how to rotate or revoke remote MCP runtime credentials,
  - how to collect redacted diagnostics,
  - how to verify sidecar versions.
- Add enterprise admin guidance:
  - local MCP risk model,
  - remote MCP preferred path,
  - allowlist examples,
  - token storage boundaries,
  - rollout flags and rollback scope.

### Acceptance

- A support engineer can classify MCP issues without reading source.
- Admins understand why local MCPs need approval/provisioning.
- Users understand why config can be installed while activation still fails.
- Support can prove whether a command came from Veslo sidecar/runtime store or
  user PATH without exposing secrets.

### Verification

```powershell
rg -n "MCP|managed local|global|npx|provision" docs/features docs/dev docs/fixes
git diff --check -- docs
```

## Suggested Implementation Order

### KISS Order For Today

1. KISS Phase 0: redacted audit-only scanner.
2. KISS Phase 1: exact Chrome runtime hygiene.
3. Run the focused verification bundle.
4. Inspect generated AppData runtime config again.
5. Stop and report remaining MCP drift instead of expanding scope.

Do not start with broad UI redesign, full policy, full token broker, or
cross-OS release certification. The first production blocker is stale and
non-deterministic Chrome MCP runtime config. Fix that known blocker first.

### Enterprise Expansion Order

Start this only after the KISS slice is verified in a real runtime.

1. EMCP00: Baseline contract and drift capture.
2. EMCP01A: Provenance and migration guardrails.
3. EMCP02: Runtime config migration and credential hygiene.
4. EMCP03 + EMCP08: Chrome-first deterministic local packaging on all OSes.
5. EMCP04: Remote MCP token broker and enterprise catalog hardening.
6. EMCP01: Full inventory and enterprise policy model.
7. EMCP07: Global config isolation.
8. EMCP05: Activation state machine UI/API cleanup.
9. EMCP06: Diagnostics, telemetry, and SLO gates.
10. EMCP09: Security/governance policy.
11. EMCP10: E2E/Pilot.
12. EMCP11: Rollout/rollback.
13. EMCP12: Docs/runbooks.

The enterprise order keeps the long-term architecture intact, but it is not the
first implementation slice.

## Final Acceptance

### KISS Acceptance

The first implementation slice is complete when:

- The redacted scanner can reproduce current MCP drift without exposing
  credentials.
- Exact known Chrome legacy commands are migrated in generated/runtime mirrors.
- Unknown/user-authored MCP entries are reported, not deleted.
- User-global OpenCode config is not modified.
- `mcp.servers` is preserved.
- Chrome MCP missing-runtime or command-resolution failure is classified by the
  Chrome MCP preflight/runtime hygiene path.
- AI-gateway provider-start watchdog behavior is unchanged in the KISS slice.
- The focused KISS verification bundle passes.

### Enterprise Acceptance

The enterprise master plan is complete only when:

- No Veslo-generated/default MCP config contains `npx`, `npm exec`, `bun x`,
  or `@latest`.
- Existing stale AppData runtime config mirrors are migrated or quarantined.
- Automatic migration never deletes unknown/user-authored MCP entries.
- User-authored OpenCode config contains no literal Veslo gateway or connector
  runtime tokens.
- Chrome MCP activation uses deterministic packaged runtime on Windows, macOS,
  and Linux.
- Chrome MCP effective command resolves inside Veslo-owned sidecar/runtime
  directories and cannot silently fall back to user-global PATH.
- Remote MCP remains the preferred enterprise SaaS connector path.
- Remote MCP token refresh is brokered, bounded, auditable, and free of token
  values in logs/support exports.
- User/global local MCP inheritance is visible and policy-controlled.
- MCP install, provisioning, auth, activation, and runtime status are separate
  observable states.
- Config/provenance scan, provisioning preflight, provider-submit, and MCP
  startup classifications meet documented SLOs.
- Real runtime smoke proves MCP status and at least one MCP-enabled send path.
- Enterprise policy can block unreviewed local executable MCPs.
- Redacted diagnostics can prove whether a 30s failure is MCP startup,
  OpenCode readiness, or provider-start/gateway behavior.
