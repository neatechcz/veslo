---
title: MCP API Veslo Catalog And Frontend Audit
date: 2026-07-08
status: implementation-verified
done: true
issue: unlinked
source_audit:
  - mcp-api-veslo-catalog-frontend-audit-2026-07-08
---

# MCP API Veslo Catalog And Frontend Audit

## Scope

Audit the current MCP catalog and install flow around `api.veslo.work`, the
local Veslo server proxy, and the frontend MCP UI/runtime workflow.

This note started as an audit-only plan. The KISS implementation slice has now
landed in the working tree and is covered by targeted tests.

## Executive Summary

The current MCP architecture is split into three planes:

1. Den/API catalog and connector runtime endpoints.
2. Local Veslo server routes that proxy catalog reads and write OpenCode MCP
   config.
3. Frontend state/workflow that renders available apps, installs catalog MCPs,
   starts provider OAuth, and refreshes runtime status.

The split is mostly coherent. The highest-risk gaps are not in the basic
catalog fetch or token injection path, which is covered by tests. The original
implementation risk was contract drift around Den base URL context,
Den-managed logout/status usage, and MCP identity matching for the built-in
Chrome quick connect entry. The KISS slice below fixes those concrete causes
without changing the broader MCP ownership model.

## Implementation Update

Implemented and verified on 2026-07-08:

- MCP Den context now forwards `x-veslo-den-api-base` from the frontend client
  for catalog list, catalog install, runtime-token refresh, and logout.
- Local MCP server routes now prefer the request Den API base over
  `ctx.config.denApiBase`, with invalid request-base validation.
- Veslo-managed MCP logout now resolves catalog metadata and calls
  `authorization.disconnectPath` before the existing OpenCode auth cleanup.
- `GET /hub/mcp` now enriches Veslo-managed catalog items with provider grant
  state from `authorization.statusPath` when Den exposes it.
- The MCP page uses that provider grant state only for auth actions:
  login/logout visibility can follow Den connection state, while runtime health
  badges still come from OpenCode MCP status.
- Logout forces a hub MCP refresh after Den disconnect so the provider grant
  state is re-read.
- Built-in Chrome quick-connect now treats `control-chrome` as an alias for
  `chrome-devtools`.
- Installed MCP owner metadata is preserved in app-side MCP server mappings.
- The app MCP `installHub` response type now matches the server response shape
  `{ ok, name, action }`.

Explicitly kept out of scope:

- Provider grant status does not replace OpenCode runtime health. The two states
  remain separate because "authorized with Google/Microsoft" and "MCP runtime is
  connected" are different contracts.

## Current MCP Catalog

The Den org MCP catalog is served from:

- `GET /v1/orgs/:orgId/mcp/catalog`
- mounted in `services/den/src/index.ts` under `/v1/orgs`
- implemented in `services/den/src/http/org-mcp-catalog.ts`

Current platform catalog items:

- `google-gmail` - Google Gmail
- `google-calendar` - Google Calendar
- `google-drive` - Google Drive
- `microsoft-sharepoint` - Microsoft SharePoint

All four catalog items are remote MCPs with:

- `config.type = "remote"`
- `config.oauth = false`
- non-secret catalog header `X-Veslo-Connector`
- `authorization.type = "veslo-server-oauth"`
- `startPath`, `runtimeTokenPath`, `statusPath`, and `disconnectPath`
- provider metadata (`Google` or `Microsoft`)

Google runtime endpoints proxy MCP JSON-RPC requests to the upstream Google MCP
servers:

- Gmail: `https://gmailmcp.googleapis.com/mcp/v1`
- Calendar: `https://calendarmcp.googleapis.com/mcp/v1`
- Drive: `https://drivemcp.googleapis.com/mcp/v1`

Microsoft SharePoint is implemented inside Den as a read-only MCP dispatcher on
top of Microsoft Graph. It exposes:

- `sharepoint.search`
- `sharepoint.listSites`
- `sharepoint.listDrives`
- `sharepoint.listChildren`
- `sharepoint.getItem`
- `sharepoint.getContent`

The local repo root currently also has a local OpenCode MCP entry:

- `control-chrome` with command `chrome-devtools-mcp --isolated`

That local entry is not part of the Den catalog. It is a configured workspace
MCP in `opencode.jsonc`.

## Server Flow

Relevant local server routes live in `packages/server/src/routes/mcp.ts`.

Catalog read:

- Frontend calls local server `GET /hub/mcp`.
- Local server requires `x-veslo-den-token` and `x-veslo-den-org-id`.
- Local server uses its configured `ctx.config.denApiBase`.
- Local server fetches `${denApiBase}/v1/orgs/:orgId/mcp/catalog`.
- Returned catalog items are validated in `packages/server/src/den-catalog.ts`.

Catalog install:

- Frontend calls `POST /workspace/:id/mcp/hub/:name`.
- Local server fetches the catalog again.
- Local server resolves the item by `id` or `name`.
- For `veslo-server-oauth` items, local server calls the item
  `runtimeTokenPath`.
- The returned runtime token is injected into config as
  `X-Veslo-Connector-Token`.
- The final OpenCode config is written as top-level `mcp.<id>`.
- Server emits an MCP reload event.

Runtime token refresh:

- Frontend runtime-status refresher detects failed remote MCP statuses that
  look like 401/expired-token failures.
- It calls `POST /workspace/:id/mcp/:name/runtime-token/refresh`.
- Server fetches a fresh connector token and rewrites the MCP header.

Config shape:

- Veslo currently reads/writes top-level `mcp.<name>`.
- `mcp.servers` is intentionally ignored/preserved for future compatibility.
- Server and app fallback both understand current disabled tool glob semantics.

## Frontend Flow

Relevant frontend files:

- `packages/app/src/app/context/extensions.ts`
- `packages/app/src/app/context/mcp-connection-workflow.ts`
- `packages/app/src/app/lib/veslo-server-domains/mcp.ts`
- `packages/app/src/app/lib/mcp-server-refresh.ts`
- `packages/app/src/app/lib/mcp-runtime-status-refresh.ts`
- `packages/app/src/app/pages/mcp.tsx`

Catalog display:

- `refreshHubMcp()` reads Den auth from local app state.
- If Den token or org id is missing, the catalog is not fetched and a
  placeholder is shown.
- If local Veslo server supports `hub.mcp.read`, frontend calls
  `vesloClient.mcp.listHub({ denToken, denOrgId })`.
- `hubMcpCards` are rendered in `/mcp` after the built-in quick-connect list.

Install and OAuth:

- `/mcp` passes install clicks to `installHubMcpAndActivate`.
- The server install writes OpenCode config and returns success.
- For `veslo-server-oauth` items, frontend does not use OpenCode OAuth.
- Instead, frontend calls `${denApiBase}${startPath}` directly with Den bearer
  auth and opens the returned browser authorization URL.

Installed MCP list:

- Frontend reads installed MCPs through `vesloClient.mcp.list(workspaceId)` when
  the local server is available.
- Local fallback reads effective OpenCode config directly.
- Runtime status is fetched from OpenCode `mcp.status`.
- Status results are filtered to configured MCP names only.

Session capability surfaces:

- `createSessionCapabilitiesStore` separately reads MCP entries for the active
  session/workspace and projects them into sidebar capability rows.
- Remote workspaces use `vesloClient.mcp.list`.
- Local workspaces can use direct OpenCode config reads.

## Findings

### Finding 1: Den-managed logout/status paths were cataloged but not wired

Severity: medium/high

Implementation status: fixed and verified.

The catalog includes `statusPath` and `disconnectPath`, and Den implements
Google/Microsoft connection status and disconnect endpoints. The current
frontend workflow uses `startPath` for browser OAuth, the server uses
`runtimeTokenPath` for install/refresh, and `GET /hub/mcp` now reads
`statusPath` to attach provider grant state to the catalog response.

Logout for Veslo-managed connector MCPs now calls Den `disconnectPath` before
the existing local OpenCode cleanup:

- `DELETE /workspace/:id/mcp/:name/auth`
- Den `authorization.disconnectPath` for `veslo-server-oauth` catalog entries
- OpenCode `/mcp/:name/disconnect`
- OpenCode `/mcp/:name/auth` delete

The MCP page keeps two states separate:

- provider grant status from Den `statusPath`, used for login/logout action
  visibility
- runtime MCP health from OpenCode status, used for runtime status badges

Expected follow-up:

- Done: provider-managed logout path for `veslo-server-oauth` entries.
- Done: catalog `disconnectPath` is called with Den bearer auth.
- Done: the existing post-logout MCP server refresh path remains in place.
- Done: `statusPath` is used as provider auth state, separate from runtime
  connectivity.
- Out of scope: replacing OpenCode runtime health with provider grant status.

### Finding 2: MCP requests do not forward frontend Den API base

Severity: medium/high

Implementation status: fixed and verified.

The app has an explicit Den API base override in settings. OAuth start uses the
frontend auth state's `denApiBase`. However, the MCP domain client only forwards:

- `x-veslo-den-token`
- `x-veslo-den-org-id`

It does not forward:

- `x-veslo-den-api-base`

The local server MCP route uses `ctx.config.denApiBase`, not a request header.
This differs from several other Den-backed server/client surfaces that do
forward a Den base header.

Risk:

- User signs in against Den base A.
- Local server is configured with Den base B.
- Catalog/install/runtime-token-refresh use B.
- Browser OAuth start uses A.
- The installed MCP URL or runtime token may not match the auth session the UI
  just started.

Expected follow-up:

- Done: MCP client Den context includes `denApiBase`.
- Done: MCP routes accept normalized `x-veslo-den-api-base` and fall back to
  server config only when the request header is absent.
- Done: tests prove list/install/runtime-token-refresh/logout and server route
  behavior use the selected frontend Den base when provided.

### Finding 3: Built-in Chrome quick-connect id does not match seeded config

Severity: low/medium

Implementation status: fixed and verified.

Built-in quick connect uses:

- id: `chrome-devtools`
- name: `Control Chrome`

Current root OpenCode config uses:

- config key: `control-chrome`
- command: `chrome-devtools-mcp --isolated`

The quick-connect status lookup is keyed by `quickConnectEntryKey(entry)`,
which prefers `id`. Installed/runtime status is keyed by configured MCP name.
That means the quick-connect card can look installable/disconnected even while
`control-chrome` is already installed and visible in the installed list.

Expected follow-up:

- Done: kept `chrome-devtools` as the canonical quick-connect id.
- Done: taught status matching that `control-chrome` is an alias.
- Done: added regression coverage for quick-connect alias matching.

### Finding 4: Installed MCP owner metadata is dropped in app mapping

Severity: low

Implementation status: fixed and verified.

The server type includes `owner` on installed MCP items. The app's
`McpServerEntry` type and server-to-app mapping currently keep `name`,
`config`, `source`, and `disabledByTools`, but not `owner`.

This is not currently breaking the MCP page, but it loses useful ownership and
debug information for global vs workspace vs remote owner displays.

Expected follow-up:

- Done: added optional `owner` to `McpServerEntry`.
- Done: preserved it when mapping `VesloMcpItem` responses.
- Done: did not add UI usage in this slice.

### Finding 5: App client installHub response type is wider than server response

Severity: low

Implementation status: fixed and typechecked.

The app MCP client types `installHub` as returning fields like `path`,
`written`, and `skipped`. The server currently returns `{ ok, name, action }`.

The current call sites mostly use success/failure only, so this is not a
runtime break today. It is still contract drift and can mislead future code.

Expected follow-up:

- Done: aligned the app client return type to the current server response.

## Existing Test Coverage

Targeted test run passed on 2026-07-08:

- App MCP/UI workflow:
  - `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm ...`
  - 111 tests passed
- Local server MCP/catalog routes:
  - `pnpm --filter veslo-server exec bun test src/tests/den-catalog.test.ts src/tests/server.hub-mcp.test.ts src/tests/server.mcp-routes.test.ts`
  - 30 tests passed
- Den catalog and Google/Microsoft runtime:
  - `pnpm --filter @neatech/den exec tsx --test test/org-mcp-catalog.test.ts test/google-workspace-oauth.test.ts test/microsoft-connectors.test.ts test/microsoft-sharepoint-mcp.test.ts test/microsoft-oauth-routes.test.ts`
  - 38 tests passed

Important coverage already exists for:

- Den catalog item shape.
- Secret/token material rejection in catalog payloads.
- Google/Microsoft connector metadata.
- Runtime token injection into workspace config.
- Runtime token refresh after auth-like MCP failures.
- SharePoint read-only MCP tools.
- Future `mcp.servers` preservation/ignore behavior.
- Official `tools` false-glob disable handling.

Original important gaps and current status:

- Fixed: `x-veslo-den-api-base` forwarding through MCP client/server routes.
- Fixed: Den-managed `disconnectPath` and `statusPath` are wired and tested,
  with provider grant state kept separate from runtime health.
- Fixed: `control-chrome` vs `chrome-devtools` quick-connect matching.
- Fixed: `owner` metadata preservation in app MCP mapping.
- Fixed by typecheck: app/server response type parity for hub MCP install
  response.

Implementation verification in `veslo-main`:

- `bun test packages/server/src/tests/den-catalog.test.ts packages/server/src/tests/server.hub-mcp.test.ts packages/server/src/tests/server.mcp-routes.test.ts`
  - 36 tests passed.
- `node --import=tsx/esm --test src/app/tests/lib/den-auth.test.ts src/app/tests/lib/veslo-server.test.ts src/app/tests/mcp-hub-contract.test.ts src/app/tests/context/mcp-connection-workflow.test.ts`
  - 117 tests passed from `packages/app`.
- `pnpm --filter @neatech/den exec tsx --test test/org-mcp-catalog.test.ts test/google-workspace-oauth.test.ts test/microsoft-oauth-routes.test.ts`
  - 23 tests passed.
- `pnpm --filter @neatech/veslo-ui typecheck`
  - passed.
- `pnpm --filter veslo-server typecheck`
  - passed.
- `git diff --check`
  - passed with CRLF warnings only.

## Completed KISS Slice

The first fix slice was intentionally kept small:

1. Forward Den API base for MCP catalog/install/runtime-token-refresh.
2. Add request/header tests on the app client and local server route behavior.
3. Add a Den-managed disconnect path for installed `veslo-server-oauth`
   entries.
4. Add a narrow Chrome quick-connect alias/canonical-key regression.
5. Read Den `statusPath` as provider grant state without replacing runtime
   MCP health.

Do not combine this with enterprise MCP provisioning, token broker redesign, or
global MCP policy work. Those are separate larger projects.

Reasonable next follow-up, if needed, is a live Den smoke test against a real
org/session to validate the external `statusPath` payload shape and logout
side effect. The repo-level contract is now covered by targeted tests.

## Current Worktree Note

This note was transferred from the `veslo` worktree to `veslo-main` after the
MCP implementation was validated against the current `veslo-main` code.

At transfer time, `veslo-main` already contained unrelated OpenCode
continuation/session worktree changes. The MCP slice only touches the MCP
client/server paths, focused MCP tests, and this plan note. The unrelated
continuation changes were left intact.
