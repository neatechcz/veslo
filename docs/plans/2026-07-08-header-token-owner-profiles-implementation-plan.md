---
title: Header Token Owner Profiles Implementation Plan
date: 2026-07-08
status: draft
done: false
issue: unlinked
source_audit: chat:2026-07-08-header-token-owner-deep-audit
repo: veslo-main
htp00_contract_snapshot_done: false
htp01_app_header_profiles_done: false
htp02_app_domain_dedupe_done: false
htp03_server_request_headers_owner_done: false
htp04_cors_allowlist_owner_done: false
htp05_gateway_proxy_strip_profile_done: false
htp06_orchestrator_boundary_inventory_done: false
htp07_verification_done: false
---

# Header Token Owner Profiles Implementation Plan

## Goal

done: false

Make Veslo-owned request headers and token handoff rules changeable from a
small number of explicit owners without blurring trust boundaries.

This is a KISS ownership plan, not a broad transport rewrite. The product
requirement is:

- app callers use shared header profiles for Veslo server auth, Den context,
  and AI gateway caller auth,
- server routes parse the same Veslo-owned headers through one local owner,
- browser CORS allowlists are derived from the same server-owned header names,
- AI gateway proxy forwarding continues to strip internal headers before
  upstream calls,
- OpenCode generated provider routing keeps runtime-only gateway authorization
  and never persists live gateway credentials,
- changing a Veslo-owned header name does not require grepping unrelated
  business logic.

## Current Audit Snapshot

done: false

Targeted audit and tests were run on 2026-07-08 in `veslo-main`.

App verification passed:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/skill-registry-events.test.ts src/app/tests/context/skill-registry-orchestrator.test.ts src/app/tests/lib/provider-routing.test.ts src/app/tests/lib/ai-access.test.ts src/app/tests/context/managed-ai-runtime-config.test.ts
```

Result: 143 passing tests.

Server verification passed:

```powershell
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.skill-registry-search.test.ts src/tests/server.hub-mcp.test.ts src/tests/server.hub-skills.test.ts src/tests/server.mcp-routes.test.ts src/tests/server.ai-gateway.test.ts src/tests/ai-gateway-runtime-owner.test.ts
```

Result: 69 passing tests.

The contracts are currently working. This plan exists because the ownership is
too scattered and header-name drift can reintroduce auth bugs without changing
business logic.

## Review Update 2026-07-08

done: false

A follow-up review found the first draft directionally correct but too broad for
an implementation handoff. This revision narrows the KISS first slice:

- HTP01 is limited to Veslo server transport auth, Den context, and gateway
  caller auth. OpenCode/session/workspace/send-trace header names remain with
  their current owners.
- HTP03 is limited to Den/catalog/skill-registry request header parsing. It
  does not add an archive owner helper unless the archive route is changed in
  the same verified patch.
- HTP04 uses a server-owned CORS allowlist test. Server tests must not import
  app header profiles just to prove CORS coverage.
- HTP05 is explicitly a separate security slice after the KISS app/server
  ownership work.
- HTP00 must record dirty worktree context before the first edit and must keep
  header-owner work separate from unrelated modified files.

## Existing Ownership To Preserve

done: false

Do not collapse all headers into one universal helper. The current system has
several separate trust boundaries and the implementation must keep them
separate.

Preserve these existing boundaries:

- `packages/app/src/app/lib/veslo-server/transport.ts`
  - app-to-local/remote Veslo server HTTP transport,
  - `Authorization: Bearer <server client token>`,
  - `X-Veslo-Host-Token`,
  - JSON and binary/multipart request helpers.
- `packages/app/src/app/lib/opencode.ts`
  - OpenCode SDK/proxy auth,
  - generated provider routing,
  - `VESLO_OPENCODE_SERVER_CLIENT_TOKEN`,
  - `x-veslo-session-id` template injection,
  - scrubbing legacy gateway/workspace headers from config.
- `packages/app/src/app/lib/ai-access.ts`
  - validation and analysis of managed AI provider routing,
  - rejection of legacy workspace-scoped gateway headers.
- `packages/app/src/app/context/managed-ai-runtime-config.ts`
  - runtime authorization priming before sends,
  - short success cache and in-flight join behavior.
- `packages/server/src/ai-gateway-runtime-owner.ts`
  - runtime-only provider authorization storage,
  - stale/legacy gateway-token handling,
  - active run/session correlation.
- `packages/server/src/server.ts`
  - server auth gates,
  - CORS,
  - AI gateway proxy forwarding and internal header stripping.

## Current Duplication And Risk

done: false

The audit found these concrete duplication points:

- App Den context builders exist in:
  - `packages/app/src/app/lib/veslo-server/transport.ts`
  - `packages/app/src/app/lib/veslo-server-domains/skills.ts`
  - `packages/app/src/app/lib/veslo-server-domains/workspace.ts`
  - `packages/app/src/app/lib/veslo-server-domains/soul.ts`
  - `packages/app/src/app/lib/veslo-server-domains/mcp.ts`
- Server Den context parsing exists in:
  - `packages/server/src/routes/mcp.ts`
  - `packages/server/src/routes/skill-registry.ts`
  - `packages/server/src/routes/skill-materialization.ts`
  - `packages/server/src/routes/skill-removals.ts`
  - `packages/server/src/routes/workspace-skills.ts`
  - legacy route bodies still present in `packages/server/src/server.ts`.
- CORS allow headers are a manually maintained string in
  `packages/server/src/server.ts`.
- AI gateway proxy strips internal headers correctly today, but the strip list
  is embedded in proxy code and is easy to drift when new local-only headers
  are introduced.
- App `extraHeaders` can currently override transport auth headers because the
  merge happens after `Authorization` and `X-Veslo-Host-Token` are assigned.
  This plan does not change that behavior in the first slice; it records it as
  an explicit policy decision for a later hardening step.

## Non-Goals

done: false

- Do not create a monorepo shared protocol package in the first slice.
- Do not rewrite Veslo server transport, OpenCode SDK creation, or AI gateway
  runtime authorization.
- Do not change token precedence or auth scopes as part of header dedupe.
- Do not persist managed AI gateway access tokens into `opencode.json` or
  `opencode.jsonc`.
- Do not remove legacy `x-veslo-gateway-token` handling before the runtime-auth
  migration path is audited separately.
- Do not broaden CORS beyond the headers Veslo actually owns.
- Do not centralize external-service headers such as Lettr, Polar, Microsoft
  Graph, Google MCP, Render, or worker-manager auth into the Veslo server
  profile.

## Header Profile Model

done: false

Use small profile builders by boundary:

1. App Veslo server profile
   - owner: `packages/app/src/app/lib/veslo-server/header-profiles.ts`
   - purpose: build app requests to the local/remote Veslo server.
2. App Den context profile
   - owner: same app header profile module for now,
   - purpose: forward Den API base/token/org/user context to local server
     routes.
3. App gateway caller profile
   - owner: same app header profile module for now,
   - purpose: carry the signed-in Den/user bearer to local `/ai-gateway/me/*`
     routes using `X-Veslo-Gateway-Authorization`.
4. Server request header reader
   - owner: `packages/server/src/request-headers.ts`
   - purpose: read, normalize, and require Veslo-owned inbound headers.
5. Server AI gateway proxy strip profile
   - owner: server-side header owner or a dedicated
     `packages/server/src/ai-gateway-proxy-headers.ts`,
   - purpose: define local-only/internal headers that must not be forwarded to
     the managed AI gateway.
6. OpenCode provider routing profile
   - remains owned by `packages/app/src/app/lib/opencode.ts` and
     `packages/app/src/app/lib/ai-access.ts`,
   - keeps first-slice ownership of `x-veslo-session-id`,
     `x-veslo-workspace-id`, generated provider auth, and provider config
     sanitization,
   - can import neutral header-name constants in a later slice, but should keep
     routing and config sanitization logic local.

## HTP00 - Baseline Contract Snapshot

done: false

### Problem

The app and server header contracts are security-sensitive. A later
implementation agent must know whether a failing test is caused by their
header-owner change or by unrelated dirty worktree noise.

### Implementation

- Record the current dirty worktree before editing.
- Record both tracked and staged/untracked context:
  - `git status --short`
  - `git diff --name-only`
  - `git diff --cached --name-only`
- Re-run the focused test set from `Current Audit Snapshot`.
- Confirm no implementation code is changed by this step.
- If any test fails before edits, stop and document the failure before
  changing header ownership.
- Do not mix this work with the existing unrelated dirty continuation/archive
  changes in the checkout.

### Acceptance

- The plan remains `done: false`.
- `htp00_contract_snapshot_done` may be changed to `true` only after the
  focused baseline tests have passed or the pre-existing failure has been
  documented with a concrete reason.
- The baseline note must identify this plan file as the only intended
  header-owner worktree change before implementation starts.

### Verification

```powershell
git status --short
git diff --name-only
git diff --cached --name-only
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/skill-registry-events.test.ts src/app/tests/context/skill-registry-orchestrator.test.ts src/app/tests/lib/provider-routing.test.ts src/app/tests/lib/ai-access.test.ts src/app/tests/context/managed-ai-runtime-config.test.ts
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.skill-registry-search.test.ts src/tests/server.hub-mcp.test.ts src/tests/server.hub-skills.test.ts src/tests/server.mcp-routes.test.ts src/tests/server.ai-gateway.test.ts src/tests/ai-gateway-runtime-owner.test.ts
```

## HTP01 - Add App Header Profiles

done: false

### Problem

`veslo-server/transport.ts` already owns most app-to-server headers, but some
profile concepts are embedded in low-level transport functions and some are
duplicated in domain clients.

### Implementation

- Add `packages/app/src/app/lib/veslo-server/header-profiles.ts`.
- Export only the canonical app-side names needed for the first slice:
  - `AUTHORIZATION_HEADER`
  - `CONTENT_TYPE_HEADER`
  - `ACCEPT_HEADER`
  - `VESLO_HOST_TOKEN_HEADER`
  - `VESLO_DEN_API_BASE_HEADER`
  - `VESLO_DEN_TOKEN_HEADER`
  - `VESLO_DEN_ORG_ID_HEADER`
  - `VESLO_DEN_USER_ID_HEADER`
  - `VESLO_GATEWAY_AUTHORIZATION_HEADER`
- Do not export OpenCode/provider routing names from this module in the first
  slice:
  - `x-veslo-session-id`
  - `x-veslo-workspace-id`
  - `x-veslo-gateway-token`
  - `x-veslo-send-trace-id`
- Move or delegate these helpers from `transport.ts`:
  - `normalizeBearerToken`
  - `buildGatewayCallerHeaders`
  - `buildDenContextHeaders`
- Add explicit profile helpers:
  - `buildVesloServerJsonHeaders`
  - `buildVesloServerAuthHeaders`
  - `buildDenContextHeaders`
  - `buildGatewayCallerHeaders`
- Keep first-slice merge semantics compatible with current behavior:
  `extraHeaders` still override base headers.
- Add a local comment or type-level note that override behavior is intentional
  compatibility and must not be tightened without a separate test-backed
  hardening step.

### Acceptance

- Existing public imports from `transport.ts` keep working or are migrated in
  the same patch.
- No generated OpenCode provider config changes.
- `packages/app/src/app/lib/opencode.ts` remains the owner of generated
  provider auth, `x-veslo-session-id`, and `x-veslo-workspace-id`.
- `requestManagedAiAccessBundle` still sends the Den/user bearer as
  `Authorization`.
- `getMyAiAccess` still sends server auth plus
  `X-Veslo-Gateway-Authorization`.

### Verification

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/provider-routing.test.ts src/app/tests/lib/ai-access.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
```

## HTP02 - Deduplicate App Domain Den Headers

done: false

### Problem

Den context headers are duplicated across Veslo server domain clients. This is
the highest-value KISS cleanup because it directly affects skill registry, MCP,
Soul, and workspace materialization flows.

### Implementation

- Replace local Den header builders in:
  - `packages/app/src/app/lib/veslo-server-domains/skills.ts`
  - `packages/app/src/app/lib/veslo-server-domains/workspace.ts`
  - `packages/app/src/app/lib/veslo-server-domains/soul.ts`
  - `packages/app/src/app/lib/veslo-server-domains/mcp.ts`
- Use the shared app `buildDenContextHeaders` helper.
- Let MCP pass the subset it has today: Den API base, Den token, and Den org id.
  Do not force `denUserId` into MCP requests unless a server consumer actually
  needs it.
- Keep direct Den fetches separate:
  - `packages/app/src/app/context/mcp-connection-workflow.ts`
  - `packages/app/src/app/context/den-desktop-auth-workflow.ts`
  - `packages/app/src/app/lib/den-auth.ts`
- Do not route direct Den OAuth/start calls through Veslo server transport.

### Acceptance

- App tests still observe `x-veslo-den-token` on hub skills, hub MCP, Soul,
  workspace, registry mutation, materialization, and registry event paths.
- No external Den direct fetch loses its `Authorization: Bearer <den token>`.
- The helper accepts optional fields and omits blank values.

### Verification

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/skill-registry-events.test.ts src/app/tests/context/skill-registry-orchestrator.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
```

## HTP03 - Add Server Request Header Owner

done: false

### Problem

Server routes parse the same Den/catalog and skill-registry identity headers
manually in several files. This is drift-prone and makes error message
consistency accidental.

### Implementation

- Add `packages/server/src/request-headers.ts`.
- Export canonical lower-case server header names for inbound lookups.
- Export small readers:
  - `trimmedHeader(request, name)`
  - `readBearerToken(request)`
  - `readVesloClientId(request)`
  - `readVesloHostToken(request)`
  - `readDenContextHeaders(ctx)`
  - `requireDenCatalogContext(ctx)`
  - `readOptionalDenCatalogContext(ctx)`
  - `readSkillRegistryIdentityHeaders(ctx)`
- Do not add `readArchiveOwnerAccountId` in this phase unless
  `resolveArchiveOwnerKey` in `packages/server/src/server.ts` is changed in
  the same patch and covered by archive tests.
- Move only header reading/normalization into this module. Keep route business
  behavior in route files.
- Update these first:
  - `packages/server/src/routes/mcp.ts`
  - `packages/server/src/routes/skill-registry.ts`
  - `packages/server/src/routes/skill-materialization.ts`
  - `packages/server/src/routes/skill-removals.ts`
  - `packages/server/src/routes/workspace-skills.ts`
- Leave large `server.ts` auth-gate extraction as a follow-up unless the
  helper is already needed for CORS or AI gateway proxy work.

### Acceptance

- Existing route status codes and error codes stay unchanged:
  - missing Den token remains `401 den_token_required`,
  - missing Den org remains `400 den_org_required`,
  - invalid Den API base remains `400 den_api_base_invalid`,
  - missing skill registry base remains `503 skill_registry_misconfigured`.
- Tests that assert Den headers and CORS continue to pass.
- The helper has no dependency on app-side code.
- No unused "future helper" exports are introduced.

### Verification

```powershell
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.skill-registry-search.test.ts src/tests/server.hub-mcp.test.ts src/tests/server.hub-skills.test.ts src/tests/server.mcp-routes.test.ts
corepack pnpm@10.27.0 --filter veslo-server typecheck
```

## HTP04 - Derive Server CORS Allowlist From Header Names

done: false

### Problem

`Access-Control-Allow-Headers` is a hand-written string. A new browser-facing
Veslo header can work in Tauri and fail in web mode if the allowlist is not
updated.

### Implementation

- Move the allowlist into a named constant in the server header owner, for
  example `VESLO_ALLOWED_CORS_HEADERS`.
- Build the response value from the constant array instead of a long inline
  string.
- Include only browser-facing request headers:
  - auth headers,
  - host/client/account headers,
  - Den context headers,
  - gateway caller/session/workspace headers,
  - OpenCode directory compatibility headers,
  - send trace header.
- Preserve existing mixed-case compatibility where tests or clients depend on
  it.
- Add or update a server-owned CORS allowlist test in
  `packages/server/src/tests/server.skill-registry-search.test.ts`.
- Do not import app header profiles into server tests just to prove allowlist
  coverage.

### Acceptance

- Existing CORS preflight tests still pass.
- The allowlist remains readable and reviewable.
- Server tests own the expected browser-facing Veslo header list.
- No external-service headers are added just because they contain `x-veslo`.

### Verification

```powershell
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.skill-registry-search.test.ts
corepack pnpm@10.27.0 --filter veslo-server typecheck
```

## HTP05 - Name The AI Gateway Proxy Strip Profile

done: false

### Problem

AI gateway proxy code copies inbound headers and then removes local-only and
internal headers before forwarding upstream. The behavior is correct today, but
the list is security-sensitive and should be owned explicitly.

### Implementation

- Add a named server-side profile for AI gateway proxy headers. Either:
  - keep it in `packages/server/src/request-headers.ts` if small, or
  - create `packages/server/src/ai-gateway-proxy-headers.ts` if it would make
    `request-headers.ts` too broad.
- Keep these concepts explicit:
  - inbound caller auth header,
  - legacy gateway token header,
  - Veslo session header,
  - legacy workspace header,
  - local-only OpenCode session headers,
  - internal headers that must be stripped before upstream,
  - hop-by-hop transport headers.
- Replace ad hoc `headers.delete(...)` literals in the AI gateway proxy with
  the named strip list where it is safe to do so.
- Preserve the current read-before-strip sequence:
  - read incoming gateway caller auth, legacy gateway token, session id,
    OpenCode session id, workspace id, host token, client id, and send trace
    diagnostics before stripping,
  - resolve provider authorization before replacing upstream
    `Authorization`,
  - set upstream `Authorization` to the resolved provider authorization,
  - preserve forwarded `x-veslo-session-id` when session forwarding is
    required,
  - then strip local-only and internal headers before the upstream fetch.
- Preserve current trace fields:
  - `strippedInternalHeaders`,
  - `strippedLocalOnlyHeaders`,
  - `strippedTransportHeaders`,
  - `incomingInternalHeaders`.
- Do not change runtime authorization precedence.
- Do not remove legacy `x-veslo-gateway-token` handling; the runtime owner still
  needs to treat it as legacy input during migration.

### Acceptance

- Provider requests continue to forward upstream `Authorization` as the resolved
  provider authorization, not the local server bearer.
- Upstream requests do not include:
  - `x-veslo-gateway-authorization`,
  - `x-veslo-gateway-token`,
  - `x-veslo-host-token`,
  - `x-veslo-client-id`,
  - `x-veslo-workspace-id`,
  - `x-veslo-send-trace-id`,
  - `x-session-id`,
  - `x-session-affinity`.
- Session id forwarding through `x-veslo-session-id` remains intact.
- Existing AI gateway runtime-owner tests still pass.
- This slice can be implemented after HTP00-HTP04 and should not be mixed into
  the first app/server Den/CORS dedupe patch.

### Verification

```powershell
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.ai-gateway.test.ts src/tests/ai-gateway-runtime-owner.test.ts
corepack pnpm@10.27.0 --filter veslo-server typecheck
```

## HTP06 - Orchestrator Boundary Inventory

done: false

### Problem

The orchestrator has its own header use in a large CLI file. It should not
block app/server header ownership, but it should be inventoried so future
shared constants are not introduced blindly.

### Implementation

- Inventory header use in `packages/orchestrator/src/cli.ts`:
  - `X-Veslo-Orchestrator-Token`,
  - `x-veslo-conversation-run-id`,
  - `Authorization`,
  - `X-Veslo-Host-Token`,
  - `x-opencode-directory`,
  - `x-veslo-workspace-id`,
  - `x-veslo-send-trace-id`.
- Do not refactor the CLI in this plan unless an app/server header change
  breaks it.
- If a small local constants object improves readability without churn, add it
  inside the orchestrator package only.
- Do not make the orchestrator depend on app code.

### Acceptance

- The inventory is recorded in this plan or in a follow-up note.
- No app/server implementation is blocked by orchestrator cleanup.
- Any changed orchestrator behavior has focused tests or smoke validation.

### Verification

```powershell
rg -n "x-veslo|X-Veslo|Authorization|authorization|x-opencode-directory" packages/orchestrator/src/cli.ts
corepack pnpm@10.27.0 --filter veslo-orchestrator test:router
```

Run the orchestrator test only if the implementation changes orchestrator code.

## HTP07 - Final Verification And Plan Sync

done: false

### Problem

Header ownership changes can pass unit tests while still leaving stale plan
flags or missing hygiene checks.

### Implementation

- Run the full focused header/auth verification bundle.
- Run typechecks for touched packages.
- Run `git diff --check` against touched files.
- Update this plan:
  - flip completed `htp*_done` flags only for verified work,
  - keep `done: false` if any intended phase remains open,
  - add a short "Implementation Update" section with exact commands and result.

### Acceptance

- All touched packages typecheck.
- Focused app and server tests pass.
- No whitespace hygiene failures in touched files.
- Plan flags match actual verification.
- Dirty worktree summary distinguishes new header-owner work from pre-existing
  unrelated dirty files.

### Verification

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/skill-registry-events.test.ts src/app/tests/context/skill-registry-orchestrator.test.ts src/app/tests/lib/provider-routing.test.ts src/app/tests/lib/ai-access.test.ts src/app/tests/context/managed-ai-runtime-config.test.ts
corepack pnpm@10.27.0 --filter veslo-server exec bun test src/tests/server.skill-registry-search.test.ts src/tests/server.hub-mcp.test.ts src/tests/server.hub-skills.test.ts src/tests/server.mcp-routes.test.ts src/tests/server.ai-gateway.test.ts src/tests/ai-gateway-runtime-owner.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
corepack pnpm@10.27.0 --filter veslo-server typecheck
git diff --check -- packages/app/src/app/lib/veslo-server packages/app/src/app/lib/veslo-server-domains packages/server/src docs/plans/2026-07-08-header-token-owner-profiles-implementation-plan.md
```

## Later Follow-Ups

done: false

These are intentionally not part of the first implementation:

- Decide whether `extraHeaders` should be prevented from overriding
  `Authorization`, `X-Veslo-Host-Token`, or gateway caller auth.
- Decide whether app and server should share header-name constants through a
  package such as `packages/protocol`.
- Add a lightweight static audit script for newly introduced literal
  `x-veslo-*` strings outside header owner files.
- Revisit orchestrator header constants after app/server ownership has settled.
- Revisit direct Den fetch helpers separately; they are a different trust
  boundary than local Veslo server transport.

## Completion Rules

done: false

- Do not mark top-level `done: true` while any `htp*_done` flag remains false.
- Do not mark a task done after code edits without the task-specific
  verification command passing or an explicit documented reason why it could
  not be run.
- Do not mark decision-gated follow-ups done without an explicit decision.
- Keep code changes KISS: a profile owner is successful if it removes real
  duplicated header names and preserves existing behavior.
