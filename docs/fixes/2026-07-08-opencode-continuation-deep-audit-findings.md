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

## Main Workflow Typing Follow-up

The app package already has TypeScript `strict: true`, so the useful next step
was not another broad compiler switch. The live weak spots were explicit `any`
and overly broad callback types around the main session/send surfaces.

### Tightened without blocking file sends

Changes applied:

- OpenCode runtime `Part` reads in session status/error handling now go through
  a small typed helper that returns strings or `Record<string, unknown>` instead
  of casting parts to `any`.
- Legacy send workflow dependencies now type `buildPromptParts(...)` and
  `buildCommandFileParts(...)` as OpenCode attachment part inputs rather than
  `unknown[]`.
- Composer and conversation-submit attachment kinds are named unions:
  `"image" | "file"`.
- Server submit parsing now rejects unexpected attachment kinds before upstream
  OpenCode contact.
- Update download callback events use a tolerant `UpdateDownloadEvent` shape
  instead of `any`; unknown event fields remain allowed as `unknown`.

This preserves the existing file attachment path: composer attachments are still
accepted as data URLs, staged into the active session directory, and submitted
with `fileSessionPath` where applicable.

### Remaining deliberate `any`

Some `setStore as any` adapters remain in `context/session.ts`. Those are Solid
store adapter boundaries between the facade and extracted controllers. They are
not part of the send/file shape change and should be cleaned in a separate
controller-typing pass to avoid a broad refactor.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-mutation-workflow.test.ts src/app/tests/pages/session-attachment-staging.test.ts src/app/tests/lib/attachment-prompt-routing.test.ts src/app/tests/system-state-updater-retry.test.ts
pnpm --filter veslo-server exec bun test src/tests/server-conversations.test.ts src/tests/conversation-submit-service.test.ts
```

Results:

- app typecheck: passed,
- app focused workflow/files/updater tests: 76 passed,
- server conversation submit tests: 57 passed.

## Display Typing Follow-up

The next weak layer after send/files was transcript display. Several display
models were reading dynamic OpenCode `Part` objects through local `as any`
casts. Those reads are now routed through a shared tolerant accessor:

- `partRecord(...)`
- `partStringField(...)`
- `partObjectField(...)`
- `partText(...)`
- `toolNameFromPart(...)`
- `toolStateFromPart(...)`
- `toolInputFromPart(...)`

Changed surfaces:

- media evidence extraction for analyzed/created images,
- timeline detail modeling,
- tool step summaries and legacy artifact derivation,
- message grouping exploration-tool detection,
- message-list latest step and message identity helpers,
- part-view rendering for tool diagnostics, structured tool images, inline image
  file parts, and step reason labels.

This keeps the dynamic OpenCode boundary permissive, but centralizes the
unknown-to-typed narrowing instead of scattering `as any` through rendering
logic.

One regression was caught during the refactor: timeline reasoning/text parts can
also carry `state.status`, not only tool parts. The accessor now supports
generic object-field reads, and the existing stale-running reasoning test covers
that behavior.

The part-view image path remains permissive for file sends and tool media:
string `url`, `src`, `data`, and string `source` values are still considered,
and `data + mediaType` still materializes a base64 data URL.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/media-evidence-model.test.ts src/app/tests/components/session/timeline-detail-model.test.ts src/app/tests/utils/tools.test.ts src/app/tests/components/session/message-list-hybrid-timeline.test.ts src/app/tests/components/session/message-list-path-layout.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/message-list-hybrid-timeline.test.ts src/app/tests/components/session/message-list-path-layout.test.ts src/app/tests/components/session/message-list-copy-affordance.test.ts src/app/tests/components/session/message-list-edit-user-message.test.ts src/app/tests/components/session/message-list-subagent-decorations.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/part-view-code-copy.test.ts src/app/tests/components/part-view.path-links.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/media-evidence-model.test.ts src/app/tests/components/session/timeline-detail-model.test.ts src/app/tests/utils/tools.test.ts src/app/tests/components/session/message-list-hybrid-timeline.test.ts src/app/tests/components/session/message-list-path-layout.test.ts src/app/tests/components/session/message-list-copy-affordance.test.ts src/app/tests/components/session/message-list-edit-user-message.test.ts src/app/tests/components/session/message-list-subagent-decorations.test.ts src/app/tests/components/part-view-code-copy.test.ts src/app/tests/components/part-view.path-links.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/utils/messages-grouping.test.ts src/app/tests/components/session/message-list-hybrid-timeline.test.ts
```

Results:

- display/timeline/tool focused tests: 103 passed,
- message-list focused tests: 26 passed,
- part-view focused tests: 15 passed,
- display/timeline/tool/message-list/part-view combined tests: 123 passed,
- message grouping focused tests: 23 passed,
- app typecheck: passed.

## Runtime Debug and Transport Typing Follow-up

The next pass covered runtime/security-adjacent helpers that were still using
explicit `any` while handling intentionally loose browser or runtime data.

Changed surfaces:

- `workspace-runtime-debug-probe.ts` now treats sampled runtime snapshots as
  `Record<string, unknown>` and narrows each nested section before comparing
  app, Tauri, server, orchestrator, routing, and session scope values.
- `utils/paths.ts` now uses local `TauriWindow`, `TauriGlobal`, and
  `NavigatorWithUserAgentData` shapes for desktop/browser platform detection
  instead of casting browser globals to `any`.
- `veslo-server/transport.ts` now parses binary-request error bodies as
  `unknown` and extracts `code`, `message`, and `details` through an object
  narrowing helper.

This keeps the existing tolerant behavior: malformed or partial runtime
snapshots still degrade into empty records, desktop detection still supports
Tauri internals, `window.isTauri`, `globalThis.isTauri`, and
`tauri.localhost`, and transport errors still preserve server-provided
`details`.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-runtime-debug-probe.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/utils/paths.test.ts src/app/tests/utils/paths-tauri-runtime.test.ts src/app/tests/utils/paths-private-workspace.test.ts src/app/tests/utils/session-directory-scoping.test.ts src/app/tests/context/workspace-runtime-debug-probe.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-request-broker.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Results:

- runtime debug probe focused tests: 3 passed,
- paths/runtime debug focused tests: 23 passed,
- Veslo server client and request broker tests: 65 passed,
- app typecheck: passed.

## Shell, Server, and Orchestrator Typing Follow-up

The next pass covered small runtime boundary helpers outside the transcript
display layer.

Changed surfaces:

- `app-shell-environment.ts` now models the shell window/document event targets
  with local event maps instead of `event: any` listeners.
- `orchestrator/security.ts` now sanitizes runtime payloads through
  `Record<string, unknown>` narrowing before redacting OpenCode and Veslo
  secrets.
- `server.ts` now parses OpenCode JSON responses as `unknown`. The automation
  executor explicitly narrows session-like responses before reading `id`.

The server typecheck caught the useful edge here: automation code was relying on
an untyped OpenCode JSON response to expose `id`. That read is now fail-closed
through `isRecordLike(...)`; missing or malformed session ids still produce the
existing `opencode_failed` error.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/app-shell-environment.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-orchestrator exec bun test src/tests/security.test.ts
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-server exec bun test src/tests/server-conversations.test.ts src/tests/server.ai-gateway.test.ts
pnpm --filter veslo-server typecheck
```

Results:

- app shell environment tests: 3 passed,
- app typecheck: passed,
- orchestrator security test: 1 passed,
- orchestrator typecheck: passed,
- server conversation and AI gateway tests: 67 passed,
- server typecheck: passed.

## Server Boundary Typing Follow-up

The next server-side pass covered small dynamic boundaries that still used
explicit `any`, without changing route behavior.

Changed surfaces:

- `skill-hub.ts` now fetches GitHub JSON as `unknown` and narrows directory and
  tree entries before reading `type`, `name`, `path`, or `mode`.
- `routes/soul.ts` now has concrete dependency input/output types for
  `soulReadPayload(...)` and `soulSummary(...)`, including Soul summaries and
  pending edits.
- `routes/file-sessions.ts` now wraps `Bun.file(...)` behind a local typed
  runtime helper instead of casting `Bun` to `any` at each download response.

The Soul route typecheck initially caught that `soulReadPayload(...)` could not
truthfully accept a model with `summary: unknown`. The route dependency model is
now typed to the same summary shape produced by the controller.

### Verification

```powershell
pnpm --filter veslo-server exec bun test src/tests/skill-hub.test.ts src/tests/skill-metadata.test.ts
pnpm --filter veslo-server exec bun test src/tests/soul-controller.test.ts src/tests/soul-routes.test.ts
pnpm --filter veslo-server exec bun test src/tests/file-sessions.test.ts src/tests/server.file-sessions-routes.test.ts
pnpm --filter veslo-server typecheck
```

Results:

- skill hub and metadata tests: 4 passed,
- Soul controller and route tests: 24 passed,
- file session route tests: 3 passed,
- server typecheck: passed.

## Orchestrator CLI JSON Typing Follow-up

The next orchestrator pass covered the shared CLI `fetchJson(...)` helper. This
was still returning `any`, so malformed router/server responses could flow
through workspace, daemon, verification, and TUI identity commands without a
typed checkpoint.

Changed surfaces:

- `cli.ts` now parses `fetchJson(...)` responses as `unknown` and extracts HTTP
  error messages through a record guard.
- Veslo server verification now narrows `/health` and `/workspaces` responses
  before reading `version`, `items`, workspace paths, and OpenCode connection
  fields.
- `runChecks(...)` now fails explicitly if the workspace list is missing a
  string `id`.
- workspace and instance CLI commands now spread only narrowed
  `Record<string, unknown>` responses.
- TUI router identity callbacks now map response items into
  `TuiRouterIdentityItem` instead of returning arbitrary arrays from the
  router payload.

The typecheck caught the useful edge here: once `requestRouter(...)` returned
`unknown`, workspace and instance command output could no longer spread the raw
result. Those call sites now keep the same output behavior for object payloads
while fail-closing non-object payloads into `{ ok: true }`.

### Verification

```powershell
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-orchestrator exec bun test src/tests/router-proxy.test.ts src/tests/workspace-id-mapping.test.ts src/tests/security.test.ts
```

Results:

- orchestrator typecheck: passed,
- router proxy, workspace id mapping, and security tests: 31 passed.

## Composer Fuzzysort Typing Follow-up

The next app pass covered the composer mention and slash-command pickers. Both
paths were mapping `fuzzysort.go(..., { keys })` results through
`(entry: any) => entry.obj`.

Changed surfaces:

- `composer.tsx` now calls `fuzzysort.go<MentionOption>(...)` for file mention
  results.
- `composer.tsx` now calls `fuzzysort.go<SlashCommandOption>(...)` for slash
  command results.

This keeps the same runtime behavior while letting TypeScript track that
`entry.obj` is the original `MentionOption` or `SlashCommandOption`.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/composer-send-intent.test.ts src/app/tests/components/session/composer-screenshot-staging-regression.test.ts src/app/tests/components/session/composer-docx-delegation.test.ts
```

Results:

- app typecheck: passed,
- composer contract test attempt: 14 passed, 4 failed.

The four failures were not caused by the `fuzzysort` typing change. The diff in
`composer.tsx` only changes the two `fuzzysort.go(...)` calls. The failing
assertions are stale regex contracts around the expanded `ComposerSendOptions`
shape and attachment-routing validation code in `session-send-workflow.ts`.

## OpenCode Router Route Typing Follow-up

The next server pass covered the OpenCode Router workspace routes. This file is
security-adjacent because it reads and writes Telegram/Slack identity config and
also consumes live payloads from the local router health server.

Changed surfaces:

- `opencode-router.ts` now uses shared `isPlainRecord`, `arrayField`,
  `recordArrayField`, and `stringField` helpers for dynamic JSON/config reads.
- live router payloads now read `items` from narrowed records instead of
  `(payload as any).items`.
- persisted Telegram `bots` and Slack `apps` arrays now filter object entries
  through `recordArrayField(...)` before reading identity fields.
- token removal no longer casts mutable records to `any`; it deletes known keys
  from `Record<string, unknown>` objects directly.
- Telegram `getMe` JSON is parsed as `unknown` and narrowed before reading
  `ok`, `result.id`, `username`, and `first_name`.

The targeted regression test writes a mixed valid/invalid `opencode-router.json`
with Telegram and Slack identities, forces the route through the config fallback
path, and verifies that only the workspace-scoped normalized entries are
returned.

### Verification

```powershell
pnpm --filter veslo-server exec bun test src/tests/server.opencode-router-routes.test.ts
pnpm --filter veslo-server typecheck
```

Results:

- OpenCode Router route tests: 2 passed,
- server typecheck: passed.

## App Runtime Debug Snapshot Typing Follow-up

The next app pass covered the workspace runtime debug snapshot assembled in
`app.tsx`.

Changed surface:

- `app.tsx` now builds the debug snapshot as `Record<string, unknown>` instead
  of `Record<string, any>`.

This keeps the existing nested snapshot payload intact while preventing the
debug probe boundary from erasing type information for downstream reads.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui typecheck
```

Results:

- app typecheck: passed.

## App Store and Archive Contract Typing Follow-up

The next app pass covered the main workflow stores and the archive/sidebar
contract that surfaced once the app typecheck was run against the current dirty
workspace.

Changed surfaces:

- `config-store.ts` now types startup preference and onboarding setters with
  the app-level `StartupPreference` and `OnboardingStep` contracts.
- `remote-store.ts` now types workspace config, startup preference, and client
  setters with concrete app/runtime types and no longer casts workspace list
  entries through `any`.
- `engine-store.ts` now types the main setter dependency surface with concrete
  `Client`, message, todo, permission, view, startup, and migration result
  types instead of `any`.
- `session-archive-store.ts` now accepts an optional archive target
  (`directory`, `conversationId`, `opencodeSessionId`) and uses it to select the
  exact sidebar session row before archiving.
- `buildArchivedSidebarSessionKey(...)` and
  `archivedSidebarSessionKeyFromRecord(...)` now include the resolved directory
  when one is available, while preserving the legacy workspace/session key for
  compatibility.
- archived sidebar filtering now publishes both the legacy
  `workspaceId + sessionId` key and the directory-scoped key, so old archive
  rows continue to hide while duplicate raw session ids can be distinguished.
- unarchive now sends `directory` only when present instead of serializing an
  explicit `directory: undefined` field into the owner API options.

The useful blocker caught here was a real contract mismatch: current sidebar
code already passes a directory-aware archive target, but the archive store and
key helper still only accepted workspace/session identity. That meant duplicate
raw OpenCode session ids across directories could collapse into the same
sidebar archive key or delete scope.

The targeted regression now creates two sidebar sessions with the same
`sessionId` in different directories, archives both, and then unarchives only
one directory. The remaining archive row must stay visible and the delete call
must include the scoped directory.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/stores/engine-store-start-host-reset.test.ts src/app/tests/context/session-archive-store.test.ts src/app/tests/lib/session-archive-model.test.ts
rg -n "\bany\b|as any|Record<string, any>|Promise<any>" packages/app/src/app/stores/config-store.ts packages/app/src/app/stores/remote-store.ts packages/app/src/app/stores/engine-store.ts packages/app/src/app/context/session-archive-store.ts packages/app/src/app/lib/session-archive-model.ts
```

Results:

- app typecheck: passed,
- engine store, session archive store, and session archive model tests: 19
  passed,
- scoped `any` scan: no explicit `any` types or casts remain in those files;
  only a plain-English comment in `engine-store.ts` contains the word `any`.

## Extensions Store Client Capability Typing Follow-up

The next app pass covered `context/extensions.ts`, focusing on skill and hub
runtime paths that were still using `as any` around Veslo server client
capabilities and raw OpenCode skill responses.

Changed surfaces:

- hub skill refresh now uses the typed `vesloClient.listHubSkills(...)`
  capability instead of `(vesloClient as any).listHubSkills(...)`.
- hub skill install now narrows the install-capable client before calling
  `installHubSkill(...)`.
- OpenCode `/skill` refresh now treats the raw `_client.get(...)` response as
  `unknown` data and maps only record-like entries with string `name` and
  `location` fields.
- skill read and skill-file read paths now call typed `getSkill(...)`,
  `getSkillFiles(...)`, and `getGlobalSkillFiles(...)` methods directly.

This removed all explicit `any` occurrences from `context/extensions.ts`.

The broad app-level typing blocker in `app-view-props.ts` has now been handled
as a separate slice by extracting an explicit deps interface for the
`createAppViewProps(...)` adapter. The fix avoided replacing the old broad
scope alias with `Record<string, unknown>` and exposed two previously masked
adapter contract mismatches: reload callbacks passed to view props now discard
their internal boolean result, and unread session ids keep the stricter
`Record<string, true>` shape.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/extensions-skill-inventory.test.ts src/app/tests/context/extensions-skill-imports.test.ts src/app/tests/context/extensions-skill-transfer-exclusivity.test.ts src/app/tests/context/extensions-skill-registry-invalidation.test.ts
rg -n "\bany\b|as any|Record<string, any>|Promise<any>" packages/app/src/app/context/extensions.ts
```

Results:

- app typecheck: passed,
- extensions skill inventory/import/transfer/registry invalidation tests: 44
  passed,
- scoped `any` scan: no matches in `context/extensions.ts`.

Follow-up app-view props verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-view-props.test.ts
pnpm --filter @neatech/veslo-ui typecheck
rg -n "\bany\b|Record<string, any>|as any|Promise<any>" packages/app/src/app/app-view-props.ts packages/app/src/app/tests/app-view-props.test.ts
```

Results:

- app view props contract tests: 6 passed,
- app typecheck: passed,
- scoped `any` scan: no matches in app view props source or its contract test.

## Scheduled Page Typing Follow-up

The next app typing pass covered `pages/scheduled.tsx`, focusing on the local
automation template icon and locale helper casts.

Changed surfaces:

- automation template icons now use a local Solid component type for the
  lucide icon props used by this page,
- schedule/relative-time/status helpers now accept `Language` instead of
  casting optional locale strings through `any`,
- the scheduled automation contract test now guards the page against explicit
  `any` returning in those local helper surfaces.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/scheduled-automations.test.ts
pnpm --filter @neatech/veslo-ui typecheck
rg -n "Record<string, any>|as any|Promise<any>|:\s*any\b|any\[\]" packages/app/src/app/pages/scheduled.tsx packages/app/src/app/pages/scheduled-automations.test.ts
```

Results:

- scheduled automations contract tests: 17 passed,
- app typecheck: passed,
- scoped explicit `any` scan: no matches in scheduled page source or its
  contract test.

## Identities Page Typing Follow-up

The next app typing pass covered `pages/identities.tsx`, focusing on router
health JSON and Telegram identity mutation responses.

Changed surfaces:

- router health error messages now read through a small string-field narrowing
  helper instead of casting `healthRes.json` through `any`,
- Telegram bot usernames returned from identity upsert now reuse the existing
  `getTelegramUsernameFromResult(...)` narrowing helper,
- the identities contract test now guards the page against explicit `any`
  returning in these router payload paths.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/identities-contract.test.ts
pnpm --filter @neatech/veslo-ui typecheck
rg -n "Record<string, any>|as any|Promise<any>|:\s*any\b|any\[\]" packages/app/src/app/pages/identities.tsx packages/app/src/app/tests/pages/identities-contract.test.ts
```

Results:

- identities contract tests: 3 passed,
- app typecheck: passed,
- scoped explicit `any` scan: no matches in identities page source or its
  contract test.

## Workspace Debug Typing Follow-up

The next app typing pass covered `context/workspace-debug.ts`, focusing on the
activation log field written onto `window`.

Changed surfaces:

- the existing workspace debug window-root type now also owns
  `__wsActivateLog`,
- `wsLog(...)` appends through that typed root instead of casting `window`
  through `any`,
- the workspace source contract test now guards that activation-log writes stay
  typed.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-forget-mode.test.ts
pnpm --filter @neatech/veslo-ui typecheck
rg -n "Record<string, any>|as any|Promise<any>|:\s*any\b|any\[\]" packages/app/src/app/context/workspace-debug.ts packages/app/src/app/tests/context/workspace-forget-mode.test.ts
```

Results:

- workspace source contract tests: 4 passed,
- app typecheck: passed,
- scoped explicit `any` scan: no matches in workspace debug source or its
  contract test.

## App Explicit Any Close-out Follow-up

The final app typing pass removed the remaining production lexical explicit
`any` hits from app sources.

Changed surfaces:

- `components/live-markdown-editor.tsx` now uses CodeMirror's
  `Range<Decoration>[]` for live-preview decoration ranges,
- `pages/proto-v1-ux.tsx` and `pages/proto-workspaces.tsx` now type mock
  lucide icons with a local Solid component type,
- the proto folder mock now types `children` as `JSX.Element`,
- the OpenCode session helper comment no longer creates a false positive in the
  lexical explicit-`any` audit,
- targeted source tests now guard the editor and proto pages against these
  casts and type holes returning.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/shared-typography.test.ts src/app/tests/pages/proto-pages-contract.test.ts src/app/tests/app-view-props.test.ts src/app/pages/scheduled-automations.test.ts src/app/tests/pages/identities-contract.test.ts src/app/tests/context/workspace-forget-mode.test.ts
pnpm --filter @neatech/veslo-ui typecheck
rg -n "Record<string, any>|as any|Promise<any>|:\s*any\b|any\[\]" packages/app/src/app --glob "*.ts" --glob "*.tsx" --glob "!**/*.test.ts" --glob "!**/*.test.tsx" --glob "!**/tests/**"
```

Results:

- combined app source/contract tests: 35 passed,
- app typecheck: passed,
- production explicit `any` scan: no matches.

## Session and Workspace Controller Typing Follow-up

The next app pass covered the main session runtime controllers and workspace
activation/connect workflow.

Changed session surfaces:

- `session-runtime-prompts.ts`, `session-selection-controller.ts`, and
  `session-workspace-cache.ts` now use Solid `SetStoreFunction<...>` for their
  store setters instead of variadic `any[]`.
- `session.ts` now passes the typed `setStore` directly into transcript,
  prompts, selection, event-stream, and workspace-cache controllers instead of
  casting it through `any`.
- the session permission/question v2 fallback path now describes the optional
  v2 prompt APIs explicitly instead of casting the whole client to `any`.

Changed workspace surfaces:

- `remote-store.ts` exports explicit `ResolveVesloHostInput`,
  `ResolveVesloHostResult`, and `CreateRemoteWorkspaceFlowInput` contracts.
- `workspace-activation-local.ts`, `workspace-activation-remote.ts`, and
  `workspace-activation-controller.ts` now use concrete startup preference,
  workspace config, workspace connection state, and locale types.
- `workspace-connection-controller.ts` now commits routed clients through the
  typed `ClientEntry` contract and uses concrete app `Client`, `DashboardTab`,
  and `View` types for its deps.
- `workspace-local-workspaces.ts` now types UI navigation and connection-state
  updates with app contracts.
- `workspace.ts` now types the main message/todo/pending-permission setters,
  default model accessor, view/tab setters, remote-store late-bound ref, and
  migration repair bridge without `any`.
- the workspace connection controller fixture now builds typed fake routed
  `ClientEntry` objects instead of returning partial entries through `as any`.

This keeps the strictness pragmatic: dynamic SDK/test doubles still cross a
single explicit `unknown` boundary in the fixture helper, while production
controller deps no longer erase the store, routing, and activation contracts.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-runtime-prompts.test.ts src/app/tests/context/session-selection-controller.test.ts src/app/tests/context/session-workspace-cache.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/context/session-transcript-controller.test.ts src/app/tests/context/workspace-connection-controller-behavior.test.ts src/app/tests/context/workspace-activate-guard.test.ts src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/context/workspace-runtime-controller-source.test.ts src/app/tests/context/workspace-switch-overlay-state.test.ts
rg -n "\bany\b|as any|Record<string, any>|Promise<any>" packages/app/src/app/context/session-runtime-prompts.ts packages/app/src/app/context/session-selection-controller.ts packages/app/src/app/context/session-workspace-cache.ts packages/app/src/app/context/session-transcript-controller.ts packages/app/src/app/context/session-event-stream.ts packages/app/src/app/context/session.ts packages/app/src/app/context/workspace.ts packages/app/src/app/context/workspace-activation-local.ts packages/app/src/app/context/workspace-activation-remote.ts packages/app/src/app/context/workspace-activation-controller.ts packages/app/src/app/context/workspace-connection-controller.ts packages/app/src/app/context/workspace-local-workspaces.ts packages/app/src/app/stores/remote-store.ts packages/app/src/app/tests/context/workspace-connection-controller-behavior.test.ts
```

Results:

- app typecheck: passed,
- session runtime/selection/cache/event/transcript and workspace
  activation/connection/materialization/overlay tests: 92 passed,
- scoped `any` scan: no explicit `any` types or casts remain in those files;
  only a plain-English comment in `workspace.ts` contains the word `any`.

## Scoped Archive and Transcript Prefetch Follow-up

The follow-up pass extended the same directory-scoped identity fix through the
transcript prefetch path, avoiding a split where archive/unarchive could target
duplicate raw session ids by directory but sidebar transcript warming still
collapsed those ids.

Changed surfaces:

- `WorkspaceSessionList` now passes the scoped sidebar target through
  unarchive actions, matching archive actions.
- `SessionArchiveStore` and the server archive delete route accept directory as
  part of the delete scope, preserving other archive rows that share the same
  raw `sessionId`.
- `VesloSessionTranscriptPrefetchInput` and the conversations route accept
  scoped session refs (`clickedSession`, `selectedSession`,
  `loadedTopLevelSessions`, `expandedSubagentSessions`) in addition to legacy
  raw id arrays.
- `session-transcript-prefetch` queues duplicate raw ids independently when
  their directories differ.

### Verification

```powershell
node --import=tsx/esm --test src/app/tests/context/session-archive-store.test.ts src/app/tests/lib/session-archive-model.test.ts src/app/tests/components/session/workspace-session-list-prefetch-interest.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts
bun test packages/server/src/tests/session-transcript-prefetch.test.ts packages/server/src/tests/server-session-transcript-prefetch.test.ts packages/server/src/tests/session-archives.test.ts packages/server/src/tests/server.session-archives-routes.test.ts packages/server/src/tests/server-session-archives-mounted-route.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server typecheck
git diff --check
```

Results:

- app archive/prefetch targeted tests: 22 passed,
- server archive/prefetch targeted tests: 29 passed,
- app typecheck: passed,
- server typecheck: passed,
- diff check: passed with CRLF warnings only.

## Local Veslo Server / OpenCode Runtime Auth Reconnect Follow-up

The next audit looked at a Mac-reported runtime failure where the first
assistant handshake stopped with local Veslo server auth rejecting the runtime
bearer. The important distinction was that UI/server auth and the pilot pipe
were live; the failing boundary was the OpenCode runtime process talking back
to the local Veslo server.

### Causal Finding

For the orchestrator runtime, `restartWorkspaceRuntime(...)` was not a process
restart. It activated or reattached the orchestrator workspace and then
reconnected the UI route. That is correct for normal browsing attach, but it is
not enough for an auth desync.

The Veslo client token is injected into OpenCode/orchestrator process state at
spawn time through `VESLO_OPENCODE_SERVER_CLIENT_TOKEN` and orchestrator
`--veslo-token`. If the local Veslo server token/auth state changes while an
OpenCode/orchestrator process stays alive, a route-only recovery can report the
runtime as recovered even though the OpenCode process still holds the old
bearer. The next provider/runtime handshake can then fail with
`Invalid bearer token`.

### Fix

The initial tactical fix treated orchestrator `*-runtime-recovery` reasons
differently from normal browse attach:

- normal orchestrator attach still uses `restartWorkspaceRuntime(...)`, which is
  the cheap activate/reattach path,
- orchestrator runtime recovery now uses `startHost(...)`, forcing a fresh
  `engine_start` and token/env injection before reconnecting the route,
- the existing reattach fallback remains for cases where `startHost(...)`
  starts the daemon but does not publish a route yet.

That tactical frontend-side choice is superseded by the backend-owned runtime
prepare follow-up below. The final contract is that
`ensureEngineForWorkspace(...)` passes the original recovery reason to
`runtime_prepare_workspace`, and Rust decides whether to activate/reattach or
fresh-start the runtime.

### Reproduction Test

The new regression test imitates the bug by running
`ensureEngineForWorkspace("ws-a", { reason: "sendPrompt-runtime-recovery",
loadSessions: false })` with `runtime = "veslo-orchestrator"`.

Before the tactical fix, that path called `restartWorkspaceRuntime(...)`,
meaning only workspace activation/reattach. The final regression now expects a
single backend prepare intent with the original `sendPrompt-runtime-recovery`
reason, so the backend can classify it as a fresh runtime start.

### Verification

```powershell
cd packages/app
node --import=tsx/esm --test src/app/tests/context/workspace-runtime-controller-source.test.ts src/app/tests/context/workspace-runtime-controller-folder-access.test.ts src/app/tests/context/send-runtime-readiness.test.ts
```

Results:

- workspace runtime controller and send-runtime readiness targeted tests: 33
  passed.

## Backend-Owned Runtime Prepare Follow-up

The reconnect/auth failure class should not be fixed by having the frontend
choose which engine lifecycle primitive to run. The latest change moves that
decision behind a Rust Tauri command:

- `runtime_prepare_workspace` owns the process decision in
  `packages/desktop/src-tauri/src/commands/engine.rs`.
- Direct runtime always resolves to a fresh backend start.
- Orchestrator `runtime-recovery`, cold-start, host-start, reload, or explicit
  fresh intent resolve to a fresh backend start.
- Normal orchestrator workspace attach first tries
  `orchestrator_workspace_activate`; if that fails, the Rust command falls back
  to `engine_start` inside the backend.
- App-side runtime code now sends a prepare intent and then only synchronizes
  the returned `EngineInfo`/auth/client route.

Important app-side boundaries after the refactor:

- `workspace-runtime-controller.ts` uses one
  `localRuntimeLifecycle.prepareWorkspaceRuntime(...)` call for boot warmup,
  first-send recovery, and runtime recovery.
- `workspace-activation-local.ts` also delegates remote-to-local and
  local-to-local runtime preparation to the same prepare helper.
- `local-runtime-lifecycle.ts` no longer depends on `startEngine`,
  `stopEngine`, `activateOrchestratorWorkspace`, or
  `disposeOrchestratorWorkspace`.

This preserves file/send behavior because the change is below prompt assembly
and attachment staging. The UI still performs client route binding after the
backend returns the prepared engine snapshot.

### Verification

```powershell
node --import=tsx/esm --test src/app/tests/context/workspace-runtime-controller-source.test.ts src/app/tests/context/workspace-runtime-controller-folder-access.test.ts src/app/tests/utils/local-runtime-lifecycle.test.ts src/app/context/workspace-browse-cold-start.test.ts src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/context/workspace-activate-order-sync.test.ts src/app/tests/context/workspace-engine-warmup.test.ts src/app/tests/stores/engine-store-start-host-reset.test.ts
pnpm --filter @neatech/veslo-ui typecheck
cargo test workspace_runtime_prepare_keeps_process_lifecycle_decisions_backend_owned --manifest-path packages\desktop\src-tauri\Cargo.toml
```

Results:

- app targeted runtime/activation/source suites: 62 passed,
- app typecheck: passed,
- Rust runtime prepare decision test: passed.

## Live Sidebar List Guard Follow-up

The sidebar had one remaining confusing degraded path: after a host-first
conversation read returned unavailable, the local workspace sidebar attempted to
fall through to the live OpenCode session list. That live list is intentionally
gated until the send flow has explicitly allowed live reads, but the guard wrote
`live-session-list-not-allowed` as a visible sidebar load error.

That was too strict for a passive sidebar refresh. Browse-only conversation
reads are allowed to be unavailable during cold start, and the live SDK list
must remain gated, but the UI should not end in an error state just because a
passive sidebar refresh skipped the unsafe live path.

The fix keeps the safety boundary and changes only the UI impact:

- live OpenCode sidebar listing is still not enabled broadly,
- the denied live-list path now uses `skipLiveSidebarSessionList(...)`,
- existing rows are preserved,
- stale sidebar read errors are cleared,
- the sidebar records `sidebar:live-session-list:skipped` instead of exposing
  `Sidebar conversation read unavailable: live-session-list-not-allowed`.

### Verification

```powershell
node --import=tsx/esm --test src/app/tests/context/sidebar-workspace-live-list-policy.test.ts src/app/tests/context/sidebar-workspace-history-retry.test.ts src/app/tests/lib/sidebar-session-sync-guard.test.ts src/app/tests/app-send-latency-trace.test.ts

node --import=tsx/esm --test src/app/tests/context/workspace-runtime-controller-source.test.ts src/app/tests/context/workspace-runtime-controller-folder-access.test.ts src/app/tests/utils/local-runtime-lifecycle.test.ts src/app/context/workspace-browse-cold-start.test.ts src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/context/workspace-activate-order-sync.test.ts src/app/tests/context/workspace-engine-warmup.test.ts src/app/tests/stores/engine-store-start-host-reset.test.ts src/app/tests/context/sidebar-workspace-live-list-policy.test.ts src/app/tests/context/sidebar-workspace-history-retry.test.ts src/app/tests/lib/sidebar-session-sync-guard.test.ts src/app/tests/app-send-latency-trace.test.ts

pnpm --filter @neatech/veslo-ui typecheck
git diff --check -- packages/app/src/app/context/sidebar-workspace-sessions.ts packages/app/src/app/tests/context/sidebar-workspace-live-list-policy.test.ts packages/app/src/app/tests/lib/sidebar-session-sync-guard.test.ts packages/app/src/app/tests/app-send-latency-trace.test.ts
```

Results:

- sidebar/live-list targeted suites: 43 passed,
- broader app runtime/sidebar workflow suites: 105 passed,
- app typecheck: passed,
- diff check: passed with CRLF warnings only.

## E2E AppHang Code Audit Follow-up

The E2E evidence points to a Windows `AppHangB1`, not a captured Rust panic or
frontend exception. The runtime accepted `prompt_async` and continued serving
session/transcript reads; the failure window was during live assistant/SSE
activity and trace forwarding.

Current source can still plausibly produce hangs or apparent hangs in two
places:

- `orchestrator_workspace_activate` used an unbounded native HTTP POST to the
  orchestrator daemon during backend-owned runtime prepare. If the orchestrator
  status file says the daemon is running but the daemon accepts a connection and
  never responds, `runtime_prepare_workspace` can wait on activation instead of
  falling back to `engine_start`.
- `setRunHasBegunForSessionKey(...)` emitted `run-state:has-begun` even when
  the stored per-session state was already `true`. With workflow tracing
  enabled by the live-skills E2E scenario, every duplicate update becomes a
  `log_ui_event` IPC, a `stderr` line, a send-workflow trace append, and a debug
  spool append.

Data entering the observed path:

- workspace id: `ws-9dfacb4d8c2a`
- workspace path: `packages/e2e/.tmp-veslo-home/workspaces/visual-workspace`
- OpenCode session id: `ses_0bc7efa20ffeUr2uBi6jSDu07z`
- conversation id: `conv-1ddce6c96e4c4f11968e`
- runtime topology: `shared-unsandboxed`
- engine base url: `http://127.0.0.1:51841`
- Veslo server origin observed by gateway config trace:
  `http://127.0.0.1:56583`
- send path: server-owned submit to
  `/workspace/{workspaceId}/opencode/session/{sessionId}/prompt_async`

The first hardening slice is intentionally small:

- orchestrator workspace activation now uses an explicit native HTTP timeout
  before runtime prepare falls back to fresh backend start,
- duplicate `run-state:has-begun` trace events are suppressed when the state did
  not change.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui exec node --import=tsx/esm --test src/app/tests/pages/session-inline-loading.test.ts src/app/tests/context/workspace-activate-order-sync.test.ts
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml workspace_runtime_prepare_keeps_process_lifecycle_decisions_backend_owned -- --nocapture
```

Results:

- app source-level session/runtime tests: 40 passed,
- Rust runtime prepare decision test: passed.
