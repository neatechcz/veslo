# OpenCode Continuation Deep Audit Findings

Date: 2026-07-08

## Scope

This note records an audit-only checkpoint for OpenCode conversation
continuation in `veslo-main`.

The audit looked at both sides of continuation:

- visible conversation and transcript rendering,
- existing-session follow-up submit,
- legacy OpenCode session identity import,
- host-side transcript persistence,
- run lifecycle and queue wake-up boundaries.

No runtime code was changed for this note.

## Current Verdict

The earlier 2026-07-07 finding that older OpenCode conversations could be
visible but not sendable appears addressed in the current tree.

The current implementation no longer relies on the UI re-enabling a broad
legacy runtime fallback. Instead, the server owns the safe migration boundary:
when a raw OpenCode session id is proven to exist in the requested workspace
directory, it is imported into `conversation_binding` and then submitted through
the same server-owned conversation path as newer sessions.

This is the right direction. The write path remains fail-closed for unknown,
foreign, or wrong-directory ids, while old real OpenCode sessions can still be
materialized.

## Confirmed Findings

### 1. Legacy OpenCode sessions can be imported on read and write

`packages/server/src/conversation-service.ts` now lets
`resolveOpenCodeSessionForRead(...)` attempt a precise source-row lookup when a
raw OpenCode session id has no existing binding.

That import path is covered by focused tests:

- `resolveOpenCodeSessionForRead imports an exact legacy OpenCode session from source rows`
- `loadTranscript returns Veslo identity after importing a legacy raw session`
- `appendTranscript imports a legacy raw session before persisting the host snapshot`
- `POST /workspace/:id/conversations/submit imports verified legacy OpenCode session targets`
- `GET /workspace/:id/sessions/:sessionId/transcript imports legacy OpenCode session identity`

### 2. The app still intentionally avoids unsafe legacy fallback

`packages/app/src/app/pages/session-send-workflow.ts` treats server-owned submit
as authoritative for existing sessions.

If server submit returns a terminal failure, the app reports that failure instead
of silently falling back to the old direct runtime run path. That is intentional:
the server is the only layer that can safely verify workspace, directory, and
conversation binding identity before execution.

### 3. Transcript display is not the main continuation blocker

The message list and timeline layer render the hydrated transcript state; they
do not own conversation identity migration.

The important display boundary is in transcript hydration:

- unavailable snapshots are ignored,
- older snapshots cannot overwrite newer transcript state,
- shorter snapshots are ignored unless explicitly allowed,
- live transcript ingestion persists snapshots back through the server with
  workspace, session, and directory scope.

That keeps UI rendering mostly downstream of the server identity and transcript
contracts.

### 4. Host-side transcript persistence is directory-scoped

Host transcript rows are keyed by workspace, directory, and OpenCode engine
session id. This matters because imported or repeated engine session ids must
not leak across sibling directories.

The current transcript store has scoped tables and compatibility fallback for
legacy unscoped rows.

### 5. Run lifecycle remains a separate failure layer

Continuation can still fail after identity resolution if a stale active run or
queue conflict blocks the new prompt.

That is not the same bug as missing legacy bindings. The current route tests
cover queueing, queue drain, lifecycle watcher wake-up, abort reconciliation, and
stale active run behavior, but live failures should still be classified by layer
before applying a generic send fix.

## Remaining Risks

### Risk 1: No fresh live desktop continuation close-out in this note

This note is source and test evidence only. It does not claim a fresh Tauri
Pilot run, rebuilt sidecars, or a manual desktop send into a legacy OpenCode
conversation after this audit.

### Risk 2: Host-first conversation listing can hide source-only gaps

The service intentionally serves existing host bindings without touching the
sandbox unless an explicit sync path is used. This avoids passive WSL/runtime
side effects, but it means a partially populated host store can omit
source-only OpenCode sessions until an active sync/import path runs.

That is acceptable as a KISS boundary, but if users report missing old sessions,
look at list/sync behavior before changing submit.

### Risk 3: Generic UI errors can still obscure the failed layer

Old-conversation follow-up can still fail for several independent reasons:

- managed-AI runtime authorization prime failure,
- wrong or missing directory,
- unimportable raw OpenCode session id,
- stale active lifecycle row,
- queue drain failure,
- transcript/session scope mismatch.

The next fix should preserve the exact failed layer in traces and UI instead of
collapsing these into a generic send failure.

## Verification Reference

Relevant focused tests in the current tree:

```powershell
pnpm --filter veslo-server exec bun test src/tests/conversation-service.test.ts src/tests/server-conversations.test.ts

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/context/session-transcript-controller.test.ts src/app/tests/components/session/message-list-hybrid-timeline.test.ts
```

These tests passed in the adjacent audit run before this note was written. They
were not re-run in `veslo-main` as part of creating this markdown checkpoint.

## Status

Audit note only.

Current status:

- legacy OpenCode continuation contract: source-covered and directionally fixed,
- transcript display/hydration contract: source-covered,
- runtime desktop continuation close-out: still open,
- Tauri Pilot close-out: still open.

## Runtime `.tmp` Reproduction Follow-up

Later on 2026-07-08, the latest `.tmp` runtime artifacts were checked against
the current codebase and targeted tests were used to imitate the suspicious
runtime errors before deciding what to fix.

### Reproduced: literal `${OPENCODE_SESSION_ID}` auth failure

Runtime evidence:

- `.tmp/manual-pnpm-dev-20260707-235514/send-workflow-trace.ndjson:808`
  recorded `server:ai-gateway:auth-failed` with
  `gateway_runtime_authorization_required`, literal
  `${OPENCODE_SESSION_ID}`, no `workspaceId`, and no `traceId`.

The added server test `server traces unresolved OpenCode placeholder auth
failures without workspace context` imitates that shape with:

- valid Veslo client auth,
- `x-veslo-session-id: ${OPENCODE_SESSION_ID}`,
- `x-session-id: ${OPENCODE_SESSION_ID}`,
- no workspace id,
- no send trace id,
- no runtime ai-access authorization.

Result: the server returns `401 gateway_runtime_authorization_required` and
records the same trace shape. This confirms the runtime line is currently an
expected fail-closed guardrail when OpenCode/provider traffic arrives outside a
runtime-authorized send context. It is not enough evidence for a production fix
unless a fresh runtime shows the same event during an active send with workspace
and trace context.

### Reproduced: OpenCode proxy socket close classification

Runtime evidence:

- `.tmp/manual-pnpm-dev-20260708-005156/send-workflow-trace.ndjson:1116`
  records transient `GET /event` socket close with
  `eventStream: true` and `nonFatalEngineError: true`.
- `.tmp/manual-pnpm-dev-20260708-005156/send-workflow-trace.ndjson:1122`
  records a `POST /session/.../command` socket close with
  `eventStream: false` and `nonFatalEngineError: false`.

Existing orchestrator tests confirm the intended policy:

- transient `GET /event` socket closes are non-fatal,
- non-event socket failures remain fatal during normal runtime,
- non-event socket closes become non-fatal only after orchestrator shutdown has
  started.

Result: the newest runtime shape matches current code. No fix is indicated
without evidence that the POST command close happened only after shutdown had
started but lacked `shutdown: true`.

### Reproduced: skill registry degraded materialization

Runtime evidence:

- `.tmp/ssif04-runtime-smoke-20260707-230800/send-workflow-trace.ndjson:12`
  recorded `failed:configured-sync` with `skill_registry_not_found`.
- newer runs recorded `workspace-skill-materialization` as `degraded`.

Existing app and server tests confirm the current contract:

- configured registry 404 degrades materialization,
- degraded materialization does not block runtime startup,
- the diagnostic is carried through `registryError`.

Result: this is a registry/config or diagnostics condition, not a current send
blocker.

### Reproduced: debug log direct fallback HTTP 400 handling

Runtime evidence:

- latest `pnpm-dev.stderr.log` files contain direct fallback `HTTP 400`
  delivery failures.

Existing Rust tests confirm the intended current behavior:

- HTTP 400 is classified as invalid direct fallback payload,
- response body excerpts are sanitized and truncated,
- direct fallback retries back off instead of replaying invalid payloads
  forever.

Result: the old log line is not by itself a current bug. The fix boundary is
already covered by Rust tests.

### Verification Run

Commands run after adding the AI gateway reproduction test:

```powershell
pnpm --filter veslo-server exec bun test src/tests/server.ai-gateway.test.ts
pnpm --filter veslo-orchestrator exec bun test src/tests/proxy-upstream-health-policy.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-skill-materialization-sync.test.ts
cargo test direct_fallback --manifest-path packages\desktop\src-tauri\Cargo.toml
```

Results:

- server AI gateway suite: 26 passed,
- orchestrator proxy policy suite: 5 passed,
- app skill-materialization suite: 13 passed,
- Rust direct fallback filter: 5 passed.

### Follow-up Verdict

No production runtime fix was identified from the latest `.tmp` artifacts.

The only item worth monitoring is the literal `${OPENCODE_SESSION_ID}` auth
failure. It is expected when no runtime authorization/workspace/trace context is
present, but it should be reclassified if a fresh post-fix runtime shows it
during an active send.

## macOS Skill Registry CORS Follow-up

A macOS user reported Chromium/WebView console failures for:

```text
Request header field x-veslo-den-api-base is not allowed by Access-Control-Allow-Headers.
Fetch API cannot load http://127.0.0.1:8787/v1/skill-registry-events?... due to access control checks.
```

This was reproducible from source review: the app-side registry event listener
can pass `x-veslo-den-api-base` through `extraHeaders`, and the local server
skill-registry routes read that header, but the server CORS allow-list did not
include it. The same route family can also read `x-veslo-den-token`, so the CORS
contract now allows both headers.

Fix:

- `packages/server/src/server.ts` now includes `X-Veslo-Den-Api-Base` and
  `X-Veslo-Den-Token` in `Access-Control-Allow-Headers`.
- `packages/server/src/tests/server.skill-registry-search.test.ts` adds a
  preflight regression test for `/v1/skill-registry-events` with
  `authorization,x-veslo-den-api-base,x-veslo-den-token,x-veslo-den-org-id`.

Verification:

```powershell
pnpm --filter veslo-server exec bun test src/tests/server.skill-registry-search.test.ts
pnpm --filter @neatech/veslo-ui exec node --conditions=browser --test --import=tsx/esm src/app/tests/lib/skill-registry-events.test.ts
```

Results:

- server skill registry suite: 10 passed,
- app skill registry events suite: 6 passed.

### CORS allow-list audit

The local server CORS allow-list was compared against app-side local server
transports and server-side request header reads.

Browser-facing local Veslo server headers are now covered:

- `Authorization`
- `Content-Type`
- `X-Veslo-Host-Token`
- `X-Veslo-Client-Id`
- `X-Veslo-Send-Trace-Id`
- `X-Veslo-Account-Id`
- `X-Veslo-User-Id`
- `X-Veslo-Den-User-Id`
- `X-Veslo-Org-Id`
- `X-Veslo-Den-Org-Id`
- `X-Veslo-Den-Api-Base`
- `X-Veslo-Den-Token`
- `X-Veslo-Gateway-Authorization`
- `X-Veslo-Gateway-Token`
- `X-Veslo-Session-Id`
- `X-Veslo-Workspace-Id`
- `X-OpenCode-Directory` / `X-Opencode-Directory` / `x-opencode-directory`

Headers observed but not added:

- `x-session-id` and `x-session-affinity` are OpenCode/provider local runtime
  headers. They are read by the local AI gateway proxy for session correlation,
  but they are not emitted by app local-server transport code.
- `x-veslo-conversation-run-id` is set by server-side OpenCode proxy code, not
  by browser app requests to the local Veslo server.
- `x-veslo-request-id` is generated server-side for upstream proxy calls.
- `x-veslo-connector-token` appears in validation/redaction helpers, not as a
  known app-to-local-server browser request header.

A broader regression test now covers the known browser-facing custom headers:

```powershell
pnpm --filter veslo-server exec bun test src/tests/server.skill-registry-search.test.ts
```

Latest result after adding the broader allow-list test: 11 passed.

## Additional Browser/Security Blocker Audit

The broader security-layer pass looked at local Veslo server request gates,
desktop/WebView transport behavior, OpenCode proxy headers, CORS preflight,
Private Network Access, and custom response header exposure.

### Fixed: Private Network Access preflight

Chrome/WebView can issue a private-network preflight before allowing a secure
or web origin to call a loopback/private HTTP target such as
`http://127.0.0.1:8787`. The local Veslo server answered normal CORS preflight
but did not answer `Access-Control-Request-Private-Network: true`.

That is a plausible blocker independent of the earlier missing
`x-veslo-den-api-base` allow-header issue.

Fix:

- `packages/server/src/server.ts` now returns
  `Access-Control-Allow-Private-Network: true` when the request preflight asks
  for private-network access.
- The broad CORS regression test now sends
  `Access-Control-Request-Private-Network: true` and asserts the allow response.

### Checked: response header exposure

No app-side code was found reading local Veslo custom response headers such as
`x-veslo-conversation-run-id` through browser `response.headers.get(...)`.

Because the app does not currently depend on reading those headers, missing
`Access-Control-Expose-Headers` is not a confirmed blocker in this pass.

### Checked: OpenCode local runtime headers

`x-session-id` and `x-session-affinity` are read by the AI gateway proxy for
OpenCode session correlation. They are local OpenCode/provider request headers,
not known app WebView-to-local-server fetch headers, so they were not added to
the browser-facing CORS allow-list.

### Checked: Tauri capability/CSP layer

The desktop Tauri capability allows HTTP and HTTPS plugin fetch targets, and the
app transport uses Tauri HTTP in desktop mode to avoid browser CORS where
possible. The packaged app has `csp: null` in `tauri.conf.json`, so no repo-local
CSP directive was found that would block these local Veslo server calls.

### Verification

```powershell
pnpm --filter veslo-server exec bun test src/tests/server.skill-registry-search.test.ts
pnpm --filter @neatech/veslo-ui exec node --conditions=browser --test --import=tsx/esm src/app/tests/lib/skill-registry-events.test.ts src/app/tests/lib/veslo-server.test.ts
```

Results:

- server skill registry/CORS suite: 11 passed,
- app skill registry and Veslo server transport suites: 67 passed.

## Zod Runtime Validation Logging Follow-up

Question checked: can Zod itself write these runtime log entries?

Answer: no. Zod only validates the value through `safeParse(...)` and returns a
success or a `ZodError`. The write happens in Veslo's send-boundary wrapper when
it calls `recordSendTrace(...)` after validation.

### Fixed: stricter validation diagnostics in send runtime traces

The send-boundary validation trace now marks both successful and failed checks
with:

- `validator: "zod"`
- `strict: true | false`
- `validationMode`
- schema name and existing trace/context fields

Failed validation traces now also include sanitized Zod diagnostics:

- total `issueCount`
- `issueCodeCounts`, for example `{ invalid_type: 3, invalid_value: 1 }`
- first 10 `issuePaths`
- `primaryIssue`
- first 10 detailed `issues` with `code`, `expected`, `received`, `message`,
  and path

The trace still avoids raw payload logging. It records only a value shape
summary such as object keys/key count, primitive type, or array length/item
types.

### Reproduced with a strict validation test

The new test `send boundary validation traces strict Zod issue diagnostics
without raw payloads` imitates a malformed runtime preflight result missing:

- `workspaceId`
- `activeWorkspace`
- `recoveryAttempted`
- `reason`

Expected result:

- strict mode blocks the invalid contract,
- runtime trace identifies `validator: "zod"`,
- trace keeps the precise Zod issue distribution,
- trace does not include the raw runtime payload.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-mutation-workflow.test.ts
pnpm --filter veslo-server exec bun test src/tests/server.skill-registry-search.test.ts
```

Results:

- app session send workflow suite: 44 passed,
- app session mutation workflow suite: 11 passed,
- server skill registry/CORS suite: 11 passed.
