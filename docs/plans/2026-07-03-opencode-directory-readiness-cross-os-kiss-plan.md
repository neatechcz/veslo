---
title: OpenCode Directory And Readiness Cross-OS KISS Plan
date: 2026-07-03
status: implemented
done: true
issue: unlinked
source_audit: opencode-directory-readiness-cross-os-deep-audit
odr00_issue_link_done: true
odr01_directory_canonicalization_done: true
odr02_orchestrator_proxy_timeout_done: true
odr03_soft_workspace_readiness_done: true
odr04_cross_os_regression_done: true
---

# OpenCode Directory And Readiness Cross-OS KISS Plan

## Goal

Make Veslo start and send reliably across Windows, macOS, and Linux when the
OpenCode process is alive but the workspace/session API is not yet proven ready.

The product rule is:

- Do not block first paint on OpenCode readiness.
- Do not add a hard provider/config gate before every send.
- Do distinguish process health from workspace/session API readiness.
- Do send OpenCode one canonical workspace directory representation.
- Do bound silent upstream waits with a clear runtime error.

## Current Evidence

- OpenCode `/global/health` can return `200` while `POST /session` is still
  stuck or not returning.
- The failed runtime trace sent `POST /session` through the orchestrator with
  `sandboxBackend: "none"` and `engineDirectory: "\\\\?\\C:\\..."`.
- Veslo server already strips Windows extended-length prefixes for OpenCode
  session filtering because OpenCode stores and filters Windows sessions by
  regular drive paths such as `C:\Users\...`.
- Orchestrator path rewriting currently preserves the directory unchanged for
  non-WSL backends, so Windows shared-unsandboxed can pass `\\?\` paths through.
- Server proxy already has a response-header timeout pattern. Orchestrator proxy
  should get the same bounded behavior for non-stream startup waits.

## Non-Goals

- Do not rewrite OpenCode.
- Do not make `/provider` or `/config` a fatal app boot gate.
- Do not block the UI overlay until workspace/session API probes pass.
- Do not force `/workspace` paths outside the WSL2 sandbox mapping.
- Do not require Tauri pilot coverage in this slice unless a later issue asks
  for it explicitly.

## ODR00: Link Issue

done: true

Create or link the Veslo issue that owns this work.

Acceptance:

- `issue:` in frontmatter is updated from `unlinked`.
- The issue references this plan and the runtime evidence.

Completion note 2026-07-03:

- No external VSLO/YouTrack issue was allocated during this repo implementation
  pass.
- The ownership checkpoint is recorded in
  `docs/fixes/2026-07-03-fix-25-opencode-directory-readiness-cross-os.md`.
- If a VSLO issue is created later, update `issue:` and this note without
  reopening the completed code slice.

## ODR01: Canonical OpenCode Directory

done: true

Add one small canonicalization path for directories sent to OpenCode.

Rules:

- The helper must be pure and deterministic. Do not rely on `process.platform`
  for the testable path transformation; pass the path/backend context in.
- Windows direct/shared-unsandboxed: strip `\\?\` and `\\?\UNC\` prefixes.
- Windows WSL2 sandbox: keep the existing `/workspace` mapping behavior.
- macOS/Linux/direct: preserve normal absolute POSIX paths.
- UNC paths: preserve a normal UNC path, not an extended-length UNC path.

Apply the canonical value consistently to:

- `x-opencode-directory`
- `directory` query params
- JSON body `directory` fields
- runtime trace fields

Acceptance:

- No OpenCode request contains mixed `\\?\C:\...` and `C:\...` representations
  for the same workspace.
- `\\?\C:\Users\me\repo` becomes `C:\Users\me\repo` for direct Windows.
- `\\?\UNC\server\share\repo` becomes `\\server\share\repo`.
- Existing WSL2 mapping tests still pass.

## ODR02: Orchestrator Proxy Header Timeout

done: true

Add a bounded timeout while orchestrator proxy waits for upstream response
headers from OpenCode.

Acceptance:

- Timeout clears as soon as upstream headers arrive.
- Streaming/SSE responses are not cut off after headers have arrived.
- Timeout emits a traceable error such as `opencode_proxy_timeout`.
- Behavior matches the existing server proxy timeout shape where practical.

## ODR03: Soft Workspace Readiness

done: true

Represent readiness as two states instead of one:

- `process_ready`: OpenCode process responds to `/global/health`.
- `workspace_api_ready`: a bounded read-only probe succeeds for the canonical
  directory. Prefer `GET /session?directory=<canonical>&limit=1` through the
  existing workspace OpenCode proxy. Do not use `POST /session` as a probe.

Keep this state diagnostic and user-visible, not a hard boot blocker.

Existing `createSessionAndOpen` runtime gating may still block when the process
or routed client is not reachable. ODR03 must not add a new hard block merely
because `workspace_api_ready` is not yet proven. In that case, first send should
join warmup where possible and attempt the real bounded session create.

Acceptance:

- Background engine warmup may report process-ready without claiming full
  workspace/session readiness.
- First send can join warmup and still attempt a bounded session create.
- Probe failure does not keep the app startup overlay open.
- The visible status can explain `waiting for OpenCode workspace API` instead
  of generic running/loading.

## ODR04: Cross-OS Regression Coverage

done: true

Add focused tests around path handling and the bounded proxy wait.

Minimum coverage:

- Windows direct/shared-unsandboxed strips `\\?\C:\...`.
- Windows direct/shared-unsandboxed strips extended UNC.
- Windows WSL2 still maps to `/workspace`.
- macOS/Linux paths remain unchanged.
- Hanging upstream before response headers returns a bounded timeout.
- Process-ready but workspace-probe-timeout is not treated as full ready.

Recommended verification:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/engine-paths.test.ts
pnpm --filter veslo-orchestrator exec bun test src/tests/router-proxy.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-runtime-controller-source.test.ts
```

Add or adjust exact test files as needed, but keep the verification narrow.

Implemented 2026-07-03:

- Added deterministic direct OpenCode directory canonicalization in
  `packages/orchestrator/src/engine-paths.ts`.
- Added orchestrator proxy response-header timeout in
  `packages/orchestrator/src/router-proxy.ts` and wired it from the router
  daemon using `VESLO_OPENCODE_PROXY_HEADERS_TIMEOUT_MS`.
- Added a soft workspace API readiness probe after engine process readiness.
  The probe uses read-only `session.list({ limit: 1 })`, is bounded, and does
  not block first paint or first send.
- Added sidebar rendering for non-error workspace connection messages so the
  user can see `Waiting for OpenCode workspace API`.

Verification run:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/engine-paths.test.ts
pnpm --filter veslo-orchestrator exec bun test src/tests/router-proxy.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-engine-warmup.test.ts src/app/tests/context/workspace-runtime-controller-source.test.ts src/app/tests/components/session/sidebar-connection-message.test.ts
pnpm --filter veslo-orchestrator typecheck
pnpm --filter @neatech/veslo-ui typecheck
```
