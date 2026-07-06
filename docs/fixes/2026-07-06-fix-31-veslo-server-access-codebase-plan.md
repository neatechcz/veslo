# Fix 31: Veslo Server Access Codebase Plan

Date: 2026-07-06

## Scope

Completed the Veslo server access architecture rollout against codebase-only
acceptance.

Source plan:

```text
docs/plans/2026-07-06-veslo-server-access-implementation-plan.md
```

Source audit:

```text
docs/plans/2026-07-04-veslo-server-access-root-causes-and-architecture.md
```

The plan is now marked:

- `status: completed`
- `done: true`
- `vsa13b_installed_runtime_smoke_skipped: true`
- `vsa13_codebase_release_gate_done: true`

## Fix

- Local server adoption is identity-based through per-boot `instanceId`.
- Host token restore is gated by matching instance identity.
- Server startup waits for READY/runtime descriptor before reporting the local
  server as usable.
- Desktop server tokens are delivered through runtime/secrets files instead of
  argv, while manual CLI token flags remain compatible.
- The frontend consumes the Tauri `veslo://server-state` descriptor and avoids
  tokenless local fallback paths.
- Workspace registration is acknowledged, reports
  `workspace_registry_unsynced` on failures, and uses server-acknowledged
  workspace id mapping for server-bound calls.
- Workspace-id golden vectors, dual-id migration, and server-acknowledged
  server-call cutover are covered across desktop, server, app, and
  orchestrator.
- The full engine-config hot-swap API remains deliberately deferred; VSA11A
  diagnostics are the trigger for reopening it.
- E2E/pilot validation is explicitly skipped for this checkpoint and is not
  claimed as acceptance evidence.

## Validation

Codebase-only validation was rerun after marking E2E as skipped:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml workspace::server_client::tests --quiet
pnpm --filter veslo-server exec bun test src/tests/config.runtime-files.test.ts src/tests/server.health-status-routes.test.ts src/tests/workspaces.test.ts src/tests/server.workspaces-crud.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/veslo-server-connection.test.ts src/app/tests/lib/veslo-server.test.ts src/app/tests/context/workspace-server-registry.test.ts
pnpm --filter veslo-orchestrator exec bun test src/tests/workspace-id-golden.test.ts src/tests/workspace-id-mapping.test.ts src/tests/workspace-runtime-migration.test.ts src/tests/run-store.test.ts
```

Results:

- desktop local-server lifecycle tests: `52` passed,
- desktop server command tests: `18` passed,
- desktop workspace server-client tests: `7` passed,
- server runtime/health/workspace tests: `40` passed,
- app descriptor, local auth, and workspace registry tests: `73` passed,
- orchestrator workspace-id/run-store migration tests: `15` passed.

Additional codebase gate already recorded in the plan:

- `pnpm --filter veslo-server test`: `899` passed, `13` skipped, `0` failed,
- app descriptor tests: `68` passed,
- orchestrator workspace/run tests: `15` passed,
- `git diff --check` and `git diff --cached --check` completed without
  whitespace errors, with LF/CRLF warnings only.

## Status

The plan is complete for the codebase-only contract. Installed-runtime E2E and
pilot validation remains skipped by owner decision and should be handled as a
separate release/runtime validation track before claiming installed-runtime
coverage.

## Additional Hardening

Follow-up test hardening added after the codebase checkpoint:

- Desktop live snapshot sanitization now has a regression test proving a
  matching bearer token is not enough to accept a foreign `instanceId`.
- Frontend descriptor events now have a regression test proving a new
  `instanceId` cannot inherit the previous host token even when the server
  reuses the same local `baseUrl`.
- Frontend descriptor events without an `instanceId` also cannot inherit owner
  fields by matching only the local `baseUrl`.
- Frontend workspace registration now rejects `workspace_exists` conflicts
  whose returned path does not match the requested local workspace path.
- Server workspace CRUD tests now assert duplicate `workspace_exists` responses
  include the `details.id` and `details.path` evidence required by the app
  registration contract.
- Server secrets-file config now tests the legacy `token` alias and verifies it
  still takes precedence over environment tokens.
- The plan frontmatter now keeps the E2E-done flag false and records the E2E
  decision through `vsa13_e2e_docs_and_release_gate_skipped: true`, so
  codebase completion cannot be mistaken for installed-runtime E2E validation.
- Plan wording was tightened after review: VSA06 now matches the implemented
  lifecycle states, VSA07 no longer carries stale `done: false` wording, VSA10
  describes a server-acknowledged id mapping rather than a new opaque id
  generator, and VSA13C no longer requires the skipped E2E gate to be marked
  done.
- Follow-up app hardening in Fix 35 removes frontend path/directory,
  `activeId`, and first-listed-workspace inference for server workspace ids;
  local server-bound calls now require an acknowledged `vesloWorkspaceId`
  mapping or fail closed.

Validation:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
pnpm --filter veslo-server exec bun test src/tests/config.runtime-files.test.ts src/tests/server.workspaces-crud.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/veslo-server-connection.test.ts src/app/tests/context/workspace-server-registry.test.ts
```

Results:

- desktop server command tests: `19` passed,
- server runtime/secrets config and workspace CRUD tests: `19` passed,
- app descriptor and workspace registry tests: `16` passed.
