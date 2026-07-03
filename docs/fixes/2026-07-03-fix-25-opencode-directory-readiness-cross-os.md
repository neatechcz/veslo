# Fix 25: OpenCode Directory And Readiness Cross-OS

## Problem

The installed desktop runtime could report the OpenCode process as healthy
while the workspace/session API was not yet responding. In the audited runtime
trace, `POST /session` went through the orchestrator in `shared-unsandboxed`
mode with a Windows extended-length directory:

```text
engineDirectory: "\\\\?\\C:\\..."
```

That is risky because Veslo already knows OpenCode stores and filters Windows
sessions by regular drive paths such as `C:\Users\...`, while the orchestrator
direct backend previously passed non-WSL paths through unchanged.

The second gap was observability: a live OpenCode process that accepted a
request but did not return response headers could leave the proxy waiting with
no clear runtime reason.

## Fix

- Added deterministic direct OpenCode directory canonicalization in
  `packages/orchestrator/src/engine-paths.ts`.
- Canonicalization is platform-independent so Windows path inputs are covered
  on every CI OS.
- Direct Windows paths now strip extended-length prefixes:
  - `\\?\C:\Users\me\repo` -> `C:\Users\me\repo`
  - `\\?\UNC\server\share\repo` -> `\\server\share\repo`
- Existing WSL2 `/workspace` mapping remains unchanged.
- Directory canonicalization is applied to:
  - `x-opencode-directory`
  - `directory` query params
  - JSON body `directory` fields
  - runtime trace `engineDirectory`
- Added orchestrator proxy response-header timeout with
  `opencode_proxy_timeout`.
- The timeout clears as soon as upstream response headers arrive, so long-lived
  SSE/model streams are not cut off.
- Wired the orchestrator timeout to `VESLO_OPENCODE_PROXY_HEADERS_TIMEOUT_MS`,
  matching the existing server proxy env contract.
- Added a soft workspace API readiness probe after engine process readiness.
- The probe uses read-only `session.list({ directory, limit: 1 })`, not
  `session.create`.
- The probe is bounded, diagnostic, and does not block first paint or first
  send.
- Sidebar workspace connection messages now show non-error diagnostics such as
  `Waiting for OpenCode workspace API`.

## Plan

The implementation plan is closed in:

```text
docs/plans/2026-07-03-opencode-directory-readiness-cross-os-kiss-plan.md
```

Top-level `done` and ODR00 through ODR04 are marked complete. No external issue
ID was allocated in this repo pass, so the plan keeps `issue: unlinked` with a
completion note instead of inventing a VSLO number.

## Scope Boundaries

- Did not add a hard `/provider` or `/config` gate.
- Did not block app first paint on OpenCode workspace/session readiness.
- Did not use `POST /session` as a readiness probe.
- Did not force `/workspace` paths outside the existing WSL2 sandbox mapping.
- Did not rerun Tauri pilot coverage for this slice.

## Coverage

- `engine-paths.test.ts` covers direct Windows drive path canonicalization,
  extended UNC canonicalization, POSIX passthrough, WSL2 mapping, query rewrite,
  and JSON body directory rewrite.
- `router-proxy.test.ts` covers hanging upstream before response headers and
  verifies `opencode_proxy_timeout`.
- `workspace-engine-warmup.test.ts` covers the bounded, read-only, non-blocking
  workspace API readiness probe.
- `sidebar-connection-message.test.ts` covers visible non-error diagnostic
  messages in the workspace sidebar.

## Verification

Run on 2026-07-03:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/engine-paths.test.ts
pnpm --filter veslo-orchestrator exec bun test src/tests/router-proxy.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-engine-warmup.test.ts src/app/tests/context/workspace-runtime-controller-source.test.ts src/app/tests/components/session/sidebar-connection-message.test.ts
pnpm --filter veslo-orchestrator typecheck
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

Result:

- Orchestrator engine-path tests passed: `7` tests.
- Orchestrator router-proxy tests passed: `24` tests.
- Focused app source/UI tests passed: `7` tests.
- Orchestrator typecheck passed.
- App typecheck passed.
- `git diff --check` passed with Windows LF-to-CRLF warnings only.

## Status

Complete for this KISS checkpoint. Veslo now sends OpenCode canonical direct
Windows directories, bounds silent upstream header waits, and shows a soft
workspace API readiness diagnostic without adding a new hard startup or
first-send gate.
