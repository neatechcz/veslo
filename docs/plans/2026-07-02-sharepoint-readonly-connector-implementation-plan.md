# Microsoft SharePoint Read-Only Connector Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Microsoft SharePoint as a read-only platform MCP connector in Napojení.

**Architecture:** Follow the existing Google Workspace platform MCP connector pattern. Den owns Microsoft OAuth, encrypted grants, runtime token issuance, and the MCP proxy/tool endpoint; the local Veslo server installs only secret-free remote MCP config; the app surfaces SharePoint through the existing Napojení MCP catalog/auth/status model.

**Tech Stack:** TypeScript, Express, Drizzle, Bun test, Node test with tsx, SolidJS, Tauri Pilot, Microsoft identity platform OAuth 2.0 authorization code flow, Microsoft Graph.

---

## Required References

- `docs/plans/2026-07-02-sharepoint-readonly-connector-design.md`
- `docs/features/extensions-and-integrations.md`
- `docs/dev/state-and-config-reference.md`
- `docs/dev/veslo-server-app-contract.md`
- `docs/dev/testing-playbook.md`
- Microsoft Graph permissions reference: `https://learn.microsoft.com/en-us/graph/permissions-reference`
- Microsoft identity platform authorization code flow: `https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow`
- Microsoft identity platform scopes: `https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc`
- Microsoft Graph site resource: `https://learn.microsoft.com/en-us/graph/api/resources/site?view=graph-rest-1.0`
- Microsoft Graph list site drives: `https://learn.microsoft.com/en-us/graph/api/drive-list?view=graph-rest-1.0`
- Microsoft Graph list drive children: `https://learn.microsoft.com/en-us/graph/api/driveitem-list-children?view=graph-rest-1.0`
- Microsoft Graph download drive item content: `https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0`
- Microsoft Search for OneDrive and SharePoint: `https://learn.microsoft.com/en-us/graph/search-concept-files`

## Scope Rules

- MVP is read-only.
- Use delegated Microsoft user auth.
- Do not add write scopes or write MCP tools.
- Do not store Microsoft client secrets, access tokens, or refresh tokens in local OpenCode config.
- Use `pnpm@10.27.0` from the repo package manager. Prefer `npx -y pnpm@10.27.0 ...` when the environment may have another pnpm version.
- If `packages/server/src` changes, run `pnpm --filter veslo-server build:bin` before relying on orchestrator-backed flows.
- Desktop behavior must be verified with the real Tauri runtime via `packages/e2e` Tauri Pilot, not raw Vite.

## Suggested Branch

Create a dedicated branch before implementation:

```bash
git switch -c codex/sharepoint-readonly-connector
```

The current worktree may contain unrelated staged and unstaged changes. Before staging each task, run:

```bash
git status --short
git diff --cached --name-only
```

Only stage files listed in that task.

## Task 1: Add Microsoft Connector Definitions

**Files:**

- Create: `services/den/src/microsoft/connectors.ts`
- Test: `services/den/test/microsoft-connectors.test.ts`

**Step 1: Write the failing connector test**

Create `services/den/test/microsoft-connectors.test.ts`:

```ts
import test from "node:test"
import assert from "node:assert/strict"

import {
  MicrosoftConnectorIds,
  MicrosoftConnectors,
  getMicrosoftConnector,
  isMicrosoftConnectorId,
} from "../src/microsoft/connectors.js"

test("Microsoft connector definitions include read-only SharePoint", () => {
  assert.deepEqual(MicrosoftConnectorIds, ["microsoft-sharepoint"])
  const connector = getMicrosoftConnector("microsoft-sharepoint")
  assert.ok(connector)
  assert.equal(connector.name, "Microsoft SharePoint")
  assert.equal(connector.id, "microsoft-sharepoint")
  assert.equal(connector.mcpUrl, "https://graph.microsoft.com/v1.0")
  assert.ok(connector.scopes.includes("openid"))
  assert.ok(connector.scopes.includes("profile"))
  assert.ok(connector.scopes.includes("offline_access"))
  assert.ok(connector.scopes.includes("https://graph.microsoft.com/Files.Read.All"))
  assert.ok(connector.scopes.includes("https://graph.microsoft.com/Sites.Read.All"))
  assert.ok(!connector.scopes.some((scope) => scope.toLowerCase().includes("readwrite")))
  assert.ok(!connector.scopes.some((scope) => scope.toLowerCase().includes("write")))
})

test("Microsoft connector id helpers reject unknown ids", () => {
  assert.equal(isMicrosoftConnectorId("microsoft-sharepoint"), true)
  assert.equal(isMicrosoftConnectorId("google-drive"), false)
  assert.equal(getMicrosoftConnector("google-drive"), null)
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/microsoft-connectors.test.ts
```

Expected: FAIL because `services/den/src/microsoft/connectors.ts` does not exist.

**Step 3: Implement the connector definition**

Create `services/den/src/microsoft/connectors.ts`:

```ts
export const MicrosoftConnectorIds = ["microsoft-sharepoint"] as const

export type MicrosoftConnectorId = (typeof MicrosoftConnectorIds)[number]

export type MicrosoftConnectorDefinition = {
  id: MicrosoftConnectorId
  name: string
  scopes: string[]
  mcpUrl: string
}

export const MicrosoftConnectors: MicrosoftConnectorDefinition[] = [
  {
    id: "microsoft-sharepoint",
    name: "Microsoft SharePoint",
    scopes: [
      "openid",
      "profile",
      "offline_access",
      "https://graph.microsoft.com/Files.Read.All",
      "https://graph.microsoft.com/Sites.Read.All",
    ],
    mcpUrl: "https://graph.microsoft.com/v1.0",
  },
]

export function isMicrosoftConnectorId(value: string): value is MicrosoftConnectorId {
  return (MicrosoftConnectorIds as readonly string[]).includes(value)
}

export function getMicrosoftConnector(value: string): MicrosoftConnectorDefinition | null {
  return MicrosoftConnectors.find((connector) => connector.id === value) ?? null
}
```

**Step 4: Run the test to verify it passes**

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/microsoft-connectors.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/microsoft/connectors.ts services/den/test/microsoft-connectors.test.ts
git commit -m "feat(den): add Microsoft SharePoint connector definition"
```

## Task 2: Add Microsoft OAuth Client

**Files:**

- Create: `services/den/src/microsoft/oauth.ts`
- Test: `services/den/test/microsoft-oauth.test.ts`

**Step 1: Write the failing OAuth tests**

Create `services/den/test/microsoft-oauth.test.ts`:

```ts
import test from "node:test"
import assert from "node:assert/strict"

import { DefaultMicrosoftOAuthClient } from "../src/microsoft/oauth.js"

test("Microsoft OAuth startAuthorization builds an organizations authorize URL", async () => {
  const client = new DefaultMicrosoftOAuthClient({
    clientId: "client-id",
    clientSecret: "client-secret",
  })

  const result = await client.startAuthorization({
    state: "state-123",
    scopes: ["openid", "offline_access", "https://graph.microsoft.com/Sites.Read.All"],
    redirectUri: "https://api.example/v1/integrations/microsoft/oauth/callback",
    connectorId: "microsoft-sharepoint",
  })

  const url = new URL(result.authorizeUrl)
  assert.equal(url.origin, "https://login.microsoftonline.com")
  assert.equal(url.pathname, "/organizations/oauth2/v2.0/authorize")
  assert.equal(url.searchParams.get("client_id"), "client-id")
  assert.equal(url.searchParams.get("response_type"), "code")
  assert.equal(url.searchParams.get("redirect_uri"), "https://api.example/v1/integrations/microsoft/oauth/callback")
  assert.equal(url.searchParams.get("state"), "state-123")
  assert.equal(url.searchParams.get("response_mode"), "query")
  assert.equal(url.searchParams.get("prompt"), "consent")
  assert.equal(url.searchParams.get("scope"), "openid offline_access https://graph.microsoft.com/Sites.Read.All")
})

test("Microsoft OAuth exchangeCode parses token responses", async () => {
  const client = new DefaultMicrosoftOAuthClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    now: () => new Date("2026-07-02T12:00:00.000Z"),
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://login.microsoftonline.com/organizations/oauth2/v2.0/token")
      assert.equal(init?.method, "POST")
      const body = init?.body as URLSearchParams
      assert.equal(body.get("grant_type"), "authorization_code")
      assert.equal(body.get("client_id"), "client-id")
      assert.equal(body.get("client_secret"), "client-secret")
      assert.equal(body.get("code"), "code-123")
      return new Response(JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "Sites.Read.All Files.Read.All",
      }), { status: 200, headers: { "content-type": "application/json" } })
    },
  })

  const grant = await client.exchangeCode({
    code: "code-123",
    redirectUri: "https://api.example/callback",
    connectorId: "microsoft-sharepoint",
    scopes: ["https://graph.microsoft.com/Sites.Read.All"],
  })

  assert.deepEqual(grant, {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: "2026-07-02T13:00:00.000Z",
    scope: "Sites.Read.All Files.Read.All",
  })
})

test("Microsoft OAuth refresh preserves existing refresh token when response omits one", async () => {
  const client = new DefaultMicrosoftOAuthClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    now: () => new Date("2026-07-02T12:00:00.000Z"),
    fetchImpl: async () => new Response(JSON.stringify({
      access_token: "new-access-token",
      expires_in: 1800,
    }), { status: 200, headers: { "content-type": "application/json" } }),
  })

  const grant = await client.refreshToken({
    refreshToken: "existing-refresh-token",
    connectorId: "microsoft-sharepoint",
  })

  assert.equal(grant.accessToken, "new-access-token")
  assert.equal(grant.refreshToken, "existing-refresh-token")
  assert.equal(grant.expiresAt, "2026-07-02T12:30:00.000Z")
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/microsoft-oauth.test.ts
```

Expected: FAIL because `services/den/src/microsoft/oauth.ts` does not exist.

**Step 3: Implement the OAuth client**

Create `services/den/src/microsoft/oauth.ts` by adapting `services/den/src/google-workspace/oauth.ts`. Use these provider-specific endpoints:

```ts
const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com/organizations/oauth2/v2.0"
const MICROSOFT_AUTHORIZE_URL = `${MICROSOFT_AUTHORITY}/authorize`
const MICROSOFT_TOKEN_URL = `${MICROSOFT_AUTHORITY}/token`
```

Expose:

```ts
export type StartMicrosoftAuthorizationInput = {
  state: string
  scopes: string[]
  redirectUri: string
  connectorId: MicrosoftConnectorId
}

export type StartMicrosoftAuthorizationResult = {
  authorizeUrl: string
}

export type MicrosoftOAuthGrant = {
  accessToken: string
  refreshToken: string
  expiresAt: string
  scope?: string
}

export type ExchangeMicrosoftCodeInput = {
  code: string
  redirectUri: string
  connectorId: MicrosoftConnectorId
  scopes: string[]
}

export type RefreshMicrosoftTokenInput = {
  refreshToken: string
  connectorId: MicrosoftConnectorId
}

export interface MicrosoftOAuthClient {
  startAuthorization(input: StartMicrosoftAuthorizationInput): Promise<StartMicrosoftAuthorizationResult>
  exchangeCode(input: ExchangeMicrosoftCodeInput): Promise<MicrosoftOAuthGrant>
  refreshToken(input: RefreshMicrosoftTokenInput): Promise<MicrosoftOAuthGrant>
  revokeToken(refreshToken: string): Promise<void>
}
```

Implementation details:

- `startAuthorization` sets `response_type=code`, `response_mode=query`, `client_id`, `redirect_uri`, `scope`, `state`, and `prompt=consent`.
- `exchangeCode` posts `grant_type=authorization_code`, `code`, `client_id`, `client_secret`, and `redirect_uri`.
- `refreshToken` posts `grant_type=refresh_token`, `refresh_token`, `client_id`, and `client_secret`.
- `refreshToken` keeps the old refresh token when Microsoft does not return a new one.
- `revokeToken` can be a no-op for MVP unless a Microsoft revocation endpoint is validated; disconnect must still mark the grant revoked in Veslo storage.
- Parse errors into short provider-specific messages such as `microsoft_oauth_exchange_failed`.

**Step 4: Run the test to verify it passes**

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/microsoft-oauth.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/microsoft/oauth.ts services/den/test/microsoft-oauth.test.ts
git commit -m "feat(den): add Microsoft OAuth client"
```

## Task 3: Add Microsoft Connection Store And State Tokens

**Files:**

- Create: `services/den/src/microsoft/store.ts`
- Create: `services/den/src/microsoft/state.ts`
- Modify: `services/den/src/db/schema.ts`
- Add migration under: `services/den/drizzle/`
- Test: `services/den/test/microsoft-store.test.ts`
- Test: `services/den/test/microsoft-state.test.ts`

**Step 1: Write state token tests**

Create `services/den/test/microsoft-state.test.ts` mirroring `services/den/test/google-workspace-oauth.test.ts` state coverage. Assert:

- OAuth state verifies with org id, user id, connector id, and redirect URI.
- OAuth state fails with wrong secret.
- Runtime token verifies with org id, user id, connector id, and expiry.
- Runtime token fails after expiry.

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/microsoft-state.test.ts
```

Expected: FAIL because `services/den/src/microsoft/state.ts` does not exist.

**Step 2: Implement `state.ts`**

Copy the structure of `services/den/src/google-workspace/state.ts`, rename types and errors to Microsoft:

- `createSignedMicrosoftOAuthState`
- `verifySignedMicrosoftOAuthState`
- `createSignedMicrosoftRuntimeToken`
- `verifySignedMicrosoftRuntimeToken`

Use `MicrosoftConnectorId`.

**Step 3: Write store tests**

Create `services/den/test/microsoft-store.test.ts`. Cover:

- in-memory upsert/list/getGrant/disconnect
- AES-GCM encrypt/decrypt round trip
- disconnected rows return `state: "revoked"` and no usable grant

Use the Google Workspace store tests as the local pattern if they exist; otherwise mirror assertions from `services/den/src/google-workspace/store.ts`.

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/microsoft-store.test.ts
```

Expected: FAIL because `services/den/src/microsoft/store.ts` does not exist.

**Step 4: Implement `store.ts`**

Copy the Google Workspace store structure with Microsoft names:

- `MicrosoftConnectionState`
- `MicrosoftConnection`
- `EncryptedMicrosoftGrant`
- `MicrosoftConnectionStore`
- `createMicrosoftGrantEncryptionKey`
- `encryptMicrosoftGrant`
- `decryptMicrosoftGrant`
- `InMemoryMicrosoftConnectionStore`
- `UnavailableMicrosoftConnectionStore`
- `DbMicrosoftConnectionStore`

Use a new schema table `MicrosoftConnectionTable` with columns equivalent to `GoogleWorkspaceConnectionTable`, but with provider-specific names.

**Step 5: Add DB schema and migration**

Modify `services/den/src/db/schema.ts` to add `MicrosoftConnectionTable`.

Generate migration:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den db:generate
```

Expected: a new migration appears under `services/den/drizzle/`.

Inspect the migration and ensure it creates a unique key on organization id, user id, and connector id.

**Step 6: Run state and store tests**

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/microsoft-state.test.ts test/microsoft-store.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add services/den/src/microsoft/state.ts services/den/src/microsoft/store.ts services/den/src/db/schema.ts services/den/drizzle services/den/test/microsoft-state.test.ts services/den/test/microsoft-store.test.ts
git commit -m "feat(den): store Microsoft connector grants"
```

## Task 4: Add Microsoft Environment Configuration

**Files:**

- Modify: `services/den/src/env.ts`
- Modify: `services/den/.env.example`
- Modify: `services/den/README.md`
- Test: `services/den/test/microsoft-env-schema.test.ts`

**Step 1: Write the failing env test**

Create `services/den/test/microsoft-env-schema.test.ts` modeled on `services/den/test/google-workspace-env-schema.test.ts`. Assert:

- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and `MICROSOFT_TOKEN_SECRET_KEY` are exposed in parsed env.
- production rejects missing or weak token encryption key when Microsoft OAuth is enabled.
- `.env.example` documents the Microsoft env vars.

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/microsoft-env-schema.test.ts
```

Expected: FAIL because env support is missing.

**Step 2: Implement env parsing**

Modify `services/den/src/env.ts` following the Google Workspace env pattern.

Add:

- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_TOKEN_SECRET_KEY`
- optional `MICROSOFT_REDIRECT_URI`
- optional `MICROSOFT_CONNECTOR_BASE_URL` only if Google's connector base URL model does not generalize cleanly

Do not reuse Google token secret values.

**Step 3: Update docs and examples**

Update `services/den/.env.example` and `services/den/README.md` with the Microsoft variables and a short note that tokens are encrypted server-side.

**Step 4: Run the env test**

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/microsoft-env-schema.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/env.ts services/den/.env.example services/den/README.md services/den/test/microsoft-env-schema.test.ts
git commit -m "feat(den): configure Microsoft connector OAuth"
```

## Task 5: Add Microsoft Catalog Entry

**Files:**

- Modify: `services/den/src/http/org-mcp-catalog.ts`
- Test: `services/den/test/org-mcp-catalog.test.ts`
- Test: `packages/server/src/tests/den-catalog.test.ts`

**Step 1: Extend Den catalog tests**

In `services/den/test/org-mcp-catalog.test.ts`, add an assertion that `/v1/orgs/:orgId/mcp/catalog` includes:

```ts
{
  id: "microsoft-sharepoint",
  name: "Microsoft SharePoint",
  config: {
    type: "remote",
    url: "https://api.veslo.work/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/mcp",
    oauth: false,
    headers: {
      "X-Veslo-Connector": "microsoft-sharepoint",
    },
  },
  authorization: {
    type: "veslo-server-oauth",
    provider: "microsoft",
    connectorId: "microsoft-sharepoint",
    scopes: [
      "openid",
      "profile",
      "offline_access",
      "https://graph.microsoft.com/Files.Read.All",
      "https://graph.microsoft.com/Sites.Read.All",
    ],
    startPath: "/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/oauth/start",
    runtimeTokenPath: "/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/runtime-token",
    statusPath: "/v1/orgs/org_1/integrations/microsoft/connections",
    disconnectPath: "/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/connection",
  },
  source: { scope: "platform" },
  provider: { id: "microsoft", group: "Microsoft" },
}
```

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/org-mcp-catalog.test.ts
```

Expected: FAIL because the catalog has only Google entries.

**Step 2: Implement catalog entry**

Modify `services/den/src/http/org-mcp-catalog.ts`:

- import Microsoft connector definitions
- add Microsoft catalog items alongside Google items
- keep `oauth: false`
- set only non-secret headers
- do not include Microsoft client id or secret in catalog payload

**Step 3: Extend local server catalog validation tests**

In `packages/server/src/tests/den-catalog.test.ts`, add a test equivalent to the existing Google catalog test:

- `fetchOrgMcpCatalog` accepts `provider: { id: "microsoft", group: "Microsoft" }`
- it preserves `authorization.type = "veslo-server-oauth"`
- it rejects malformed Microsoft authorization fields
- it does not require or accept token material

Run:

```bash
npx -y pnpm@10.27.0 --filter veslo-server test src/tests/den-catalog.test.ts
```

Expected: FAIL until the validator accepts the Microsoft provider payload shape.

**Step 4: Implement local server catalog validation support**

Modify the relevant catalog validation code in `packages/server/src/den-catalog.ts` or the file currently imported by `packages/server/src/tests/den-catalog.test.ts`.

Keep the validator provider-agnostic where possible:

- `authorization.provider` can be `"google"` or `"microsoft"`
- `authorization.connectorId` remains string
- `authorization.scopes` remains string array
- route paths remain strings
- config headers remain non-secret

**Step 5: Run catalog tests**

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/org-mcp-catalog.test.ts
npx -y pnpm@10.27.0 --filter veslo-server test src/tests/den-catalog.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/http/org-mcp-catalog.ts services/den/test/org-mcp-catalog.test.ts packages/server/src/tests/den-catalog.test.ts packages/server/src/den-catalog.ts
git commit -m "feat: add SharePoint to platform MCP catalog"
```

## Task 6: Add Microsoft OAuth And Connection Routes

**Files:**

- Create: `services/den/src/http/microsoft.ts`
- Modify: `services/den/src/index.ts`
- Test: `services/den/test/microsoft-oauth-routes.test.ts`

**Step 1: Write route tests**

Create `services/den/test/microsoft-oauth-routes.test.ts`. Cover:

- `GET /v1/orgs/:orgId/integrations/microsoft/microsoft-sharepoint/oauth/start` returns `authorizeUrl`, `state`, `connectorId`, and scopes.
- unknown connector returns `400 unknown_microsoft_connector`.
- callback verifies state, exchanges code, stores grant, and redirects with `status=connected&provider=microsoft&connectorId=microsoft-sharepoint`.
- `GET /v1/orgs/:orgId/integrations/microsoft/connections` returns SharePoint connection state.
- `DELETE /v1/orgs/:orgId/integrations/microsoft/microsoft-sharepoint/connection` marks the grant disconnected.

Use an in-memory store, fake OAuth client, and fake organization auth helper like the Google Workspace route tests.

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/microsoft-oauth-routes.test.ts
```

Expected: FAIL because the router does not exist.

**Step 2: Implement router**

Create `services/den/src/http/microsoft.ts` by adapting `services/den/src/http/google-workspace.ts`.

Route names:

- `/orgs/:orgId/integrations/microsoft/:connectorId/oauth/start`
- `/integrations/microsoft/oauth/callback`
- `/orgs/:orgId/integrations/microsoft/:connectorId/runtime-token`
- `/orgs/:orgId/integrations/microsoft/connections`
- `/orgs/:orgId/integrations/microsoft/:connectorId/connection`

Use:

- `getMicrosoftConnector`
- `createSignedMicrosoftOAuthState`
- `verifySignedMicrosoftOAuthState`
- `createSignedMicrosoftRuntimeToken`
- `verifySignedMicrosoftRuntimeToken`
- `MicrosoftConnectionStore`
- `MicrosoftOAuthClient`

**Step 3: Wire router into Den app**

Modify `services/den/src/index.ts` or the current Den router composition file to mount the Microsoft router under `/v1`.

Initialize dependencies from env:

- if Microsoft env vars are configured, use `DefaultMicrosoftOAuthClient` and `DbMicrosoftConnectionStore`
- otherwise use unavailable implementations so catalog can remain visible but auth fails clearly

**Step 4: Run route tests**

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/microsoft-oauth-routes.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/http/microsoft.ts services/den/src/index.ts services/den/test/microsoft-oauth-routes.test.ts
git commit -m "feat(den): add Microsoft connector auth routes"
```

## Task 7: Implement Read-Only SharePoint MCP Tools

**Files:**

- Modify: `services/den/src/http/microsoft.ts`
- Create: `services/den/src/microsoft/graph.ts`
- Create: `services/den/src/microsoft/sharepoint-mcp.ts`
- Test: `services/den/test/microsoft-sharepoint-mcp.test.ts`

**Step 1: Write MCP tests**

Create `services/den/test/microsoft-sharepoint-mcp.test.ts` with mocked Graph fetch. Cover these tool calls:

- `sharepoint.search`
- `sharepoint.listSites`
- `sharepoint.listDrives`
- `sharepoint.listChildren`
- `sharepoint.getItem`
- `sharepoint.getContent`

Also cover:

- missing runtime token returns `401 microsoft_runtime_token_invalid`
- missing grant returns `401 microsoft_connection_required`
- expired grant triggers OAuth refresh and store update
- Graph `403` maps to insufficient permission
- write-like tool names return unsupported method/tool error
- content fetch enforces a byte limit

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/microsoft-sharepoint-mcp.test.ts
```

Expected: FAIL because the MCP tool implementation is missing.

**Step 2: Implement Graph helper**

Create `services/den/src/microsoft/graph.ts`:

```ts
export type MicrosoftGraphClientOptions = {
  accessToken: string
  fetchImpl?: typeof fetch
  baseUrl?: string
  maxContentBytes?: number
}

export class MicrosoftGraphClient {
  constructor(private readonly options: MicrosoftGraphClientOptions) {}

  async searchSharePoint(query: string) {
    return this.postJson("/search/query", {
      requests: [{
        entityTypes: ["driveItem", "site", "list", "listItem"],
        query: { queryString: query },
      }],
    })
  }

  async listSites(search?: string) {
    const suffix = search?.trim()
      ? `/sites?search=${encodeURIComponent(search.trim())}`
      : "/sites/root"
    return this.getJson(suffix)
  }

  async listDrives(siteId: string) {
    return this.getJson(`/sites/${encodeURIComponent(siteId)}/drives`)
  }

  async listChildren(driveId: string, itemId = "root") {
    const path = itemId === "root"
      ? `/drives/${encodeURIComponent(driveId)}/root/children`
      : `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children`
    return this.getJson(path)
  }

  async getItem(driveId: string, itemId: string) {
    return this.getJson(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`)
  }

  async getContent(driveId: string, itemId: string) {
    return this.getBytes(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`)
  }
}
```

Implement private `getJson`, `postJson`, and `getBytes` methods with:

- `Authorization: Bearer <token>`
- JSON response parsing
- `@odata.nextLink` preservation
- explicit mapping for 401, 403, 404, 413, 429, and 5xx
- content byte cap before returning data to the MCP response

**Step 3: Implement MCP dispatcher**

Create `services/den/src/microsoft/sharepoint-mcp.ts`.

Keep the protocol shape compatible with the MCP runtime used by existing remote connectors. If the Google connector proxies to an upstream MCP server rather than implementing tools, follow the same HTTP envelope expected by OpenCode. The first implementation should expose only read-only tools and reject everything else.

Tool names:

- `sharepoint.search`
- `sharepoint.listSites`
- `sharepoint.listDrives`
- `sharepoint.listChildren`
- `sharepoint.getItem`
- `sharepoint.getContent`

Return compact JSON payloads, not raw Graph blobs when they are overly large.

**Step 4: Wire MCP endpoint**

In `services/den/src/http/microsoft.ts`, implement:

```text
ALL /orgs/:orgId/integrations/microsoft/:connectorId/mcp
```

It must:

- validate `X-Veslo-Connector-Token`
- resolve and refresh a usable Microsoft grant
- instantiate `MicrosoftGraphClient`
- dispatch the MCP request to read-only SharePoint tools

**Step 5: Run MCP tests**

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/microsoft-sharepoint-mcp.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/http/microsoft.ts services/den/src/microsoft/graph.ts services/den/src/microsoft/sharepoint-mcp.ts services/den/test/microsoft-sharepoint-mcp.test.ts
git commit -m "feat(den): add read-only SharePoint MCP tools"
```

## Task 8: Install SharePoint Hub MCP From Local Server

**Files:**

- Modify: `packages/server/src/tests/server.hub-mcp.test.ts`
- Modify only if needed: `packages/server/src/den-catalog.ts`
- Modify only if needed: `packages/server/src/mcp.ts`

**Step 1: Write server install test**

In `packages/server/src/tests/server.hub-mcp.test.ts`, add a test mirroring the Google runtime token install case:

- Den catalog returns `microsoft-sharepoint`.
- Runtime token path returns `runtime-token-sharepoint-1`.
- `POST /workspace/ws_1/mcp/hub/microsoft-sharepoint` writes an MCP entry to `opencode.jsonc`.
- Config contains the Microsoft MCP URL, `oauth: false`, `X-Veslo-Connector`, and `X-Veslo-Connector-Token`.
- Config does not contain `MICROSOFT_CLIENT_SECRET`, `access_token`, `refresh_token`, or `clientSecret`.

Run:

```bash
npx -y pnpm@10.27.0 --filter veslo-server test src/tests/server.hub-mcp.test.ts
```

Expected: FAIL if server-side validation or install flow is still Google-specific.

**Step 2: Implement minimal server support**

Prefer making existing catalog/install logic provider-agnostic. Avoid SharePoint-specific branches unless current code explicitly requires provider handling.

Likely edits:

- accept Microsoft authorization metadata in catalog validators
- keep runtime token refresh path generic
- keep `X-Veslo-Connector-Token` header validation unchanged

**Step 3: Run server tests**

Run:

```bash
npx -y pnpm@10.27.0 --filter veslo-server test src/tests/den-catalog.test.ts src/tests/server.hub-mcp.test.ts
```

Expected: PASS.

**Step 4: Rebuild server binary**

Because this task may change `packages/server/src`, run:

```bash
npx -y pnpm@10.27.0 --filter veslo-server build:bin
```

Expected: command exits 0 and updates the server binary if tracked/generated by the repo.

**Step 5: Commit**

```bash
git add packages/server/src/tests/server.hub-mcp.test.ts packages/server/src/den-catalog.ts packages/server/src/mcp.ts packages/server/dist/bin/veslo-server
git commit -m "feat(server): install SharePoint platform MCP"
```

If `packages/server/dist/bin/veslo-server` is untracked or ignored, do not force-add it. Commit only files actually changed by the build and source edits.

## Task 9: Surface SharePoint In Napojení

**Files:**

- Modify: `packages/app/src/app/pages/mcp.tsx`
- Modify: `packages/app/src/app/context/mcp-connection-workflow.ts`
- Modify: `packages/app/src/app/lib/mcp-runtime-status-refresh.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Test: `packages/app/src/app/tests/mcp-hub-contract.test.ts`
- Test: `packages/app/src/app/tests/lib/mcp-runtime-status-refresh.test.ts`

**Step 1: Write app contract tests**

Extend `packages/app/src/app/tests/mcp-hub-contract.test.ts`:

- hub catalog payload with `provider.id = "microsoft"` renders/normalizes as a platform connector
- auth modal copy works with provider `microsoft`
- catalog id `microsoft-sharepoint` is used as runtime server key
- no Google-specific copy appears for Microsoft

Extend `packages/app/src/app/tests/lib/mcp-runtime-status-refresh.test.ts`:

- token refresh candidate detection works for `microsoft-sharepoint`
- refresh happens once on auth-like failure

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/mcp-hub-contract.test.ts src/app/tests/lib/mcp-runtime-status-refresh.test.ts
```

Expected: FAIL if app logic or labels are Google-specific.

**Step 2: Implement UI support**

Make the smallest provider-generic edits:

- provider display label should come from catalog payload when available
- connector name should show `Microsoft SharePoint`
- auth flow should use `authorization.startPath`, `statusPath`, `disconnectPath`, and `runtimeTokenPath`
- status copy should not assume Google
- runtime status refresh should continue keying off `X-Veslo-Connector-Token`, not provider id

Add localized labels only where the UI has hardcoded connector copy. Keep the product connector name in English: `Microsoft SharePoint`.

**Step 3: Run app tests**

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/mcp-hub-contract.test.ts src/app/tests/lib/mcp-runtime-status-refresh.test.ts
npx -y pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 4: Commit**

```bash
git add packages/app/src/app/pages/mcp.tsx packages/app/src/app/context/mcp-connection-workflow.ts packages/app/src/app/lib/mcp-runtime-status-refresh.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/app/tests/mcp-hub-contract.test.ts packages/app/src/app/tests/lib/mcp-runtime-status-refresh.test.ts
git commit -m "feat(app): surface SharePoint connector in Napojení"
```

## Task 10: Add Tauri Pilot SharePoint Connector Scenario

**Files:**

- Modify: `packages/e2e/helpers/fixtures` or current Den fixture location used by Google MCP scenario
- Create: `packages/e2e/specs/sharepoint-mcp-connectors.pilot.ts` or add scenario to current pilot scenario registry
- Modify: `packages/e2e/package.json`
- Test: new Tauri Pilot scenario

**Step 1: Inspect the Google MCP scenario**

Read the existing Google MCP scenario referenced by:

```bash
npx -y pnpm@10.27.0 --filter @neatech/veslo-e2e test:pilot:google-mcp
```

Find the scenario file by searching:

```bash
rg -n "google-mcp-connectors|Google Drive|Google Gmail|test:pilot:google-mcp" packages/e2e
```

**Step 2: Write the SharePoint scenario**

Create a Tauri Pilot scenario that:

- launches the real desktop app through the E2E runner
- uses mocked Den catalog with `microsoft-sharepoint`
- opens Napojení
- verifies `Microsoft SharePoint` appears
- installs the connector
- verifies local runtime config status reaches installed/reload-needed or connected state according to current pattern
- does not complete real Microsoft OAuth
- verifies no token/secret text appears in visible UI

**Step 3: Add package script**

Add to `packages/e2e/package.json`:

```json
"test:pilot:sharepoint-mcp": "node --import=tsx/esm ./helpers/pilot-runner.ts --scenario sharepoint-mcp-connectors"
```

If the scenario registry uses a different mapping, follow the Google MCP pattern exactly.

**Step 4: Run desktop preflight and scenario**

Follow `docs/dev/testing-playbook.md` preflight before starting desktop E2E.

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/veslo-e2e test:pilot:sharepoint-mcp
```

Expected: PASS against the real Tauri desktop app with mocked Den/Microsoft endpoints.

**Step 5: Commit**

```bash
git add packages/e2e/package.json packages/e2e/specs packages/e2e/helpers
git commit -m "test(e2e): cover SharePoint MCP connector install"
```

Only stage files actually changed for the scenario.

## Task 11: Update Durable Docs

**Files:**

- Modify: `docs/features/extensions-and-integrations.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify if needed: `docs/dev/testing-playbook.md`

**Step 1: Update feature semantics**

Modify `docs/features/extensions-and-integrations.md`:

- add a `Platform Microsoft 365 MCP Connectors` section
- document `Microsoft SharePoint` as the first Microsoft connector
- state that it is read-only in MVP
- state that Den owns Microsoft OAuth and encrypted grants
- state that local OpenCode config contains only secret-free remote MCP config and renewable Veslo connector headers
- preserve the distinction among catalog-visible, installed/configured, server-authorized, runtime-connected, and reload-needed states

**Step 2: Update config reference**

Modify `docs/dev/state-and-config-reference.md`:

- document Microsoft connector local config rules near the Google Workspace connector section
- state that Microsoft runtime token refresh renews only Veslo connector token material
- state that refresh must not start Microsoft OAuth or write Microsoft token material locally

**Step 3: Update testing playbook only if needed**

If a new stable E2E command was added, update `docs/dev/testing-playbook.md` with:

```bash
pnpm test:pilot:sharepoint-mcp
```

**Step 4: Commit**

```bash
git add docs/features/extensions-and-integrations.md docs/dev/state-and-config-reference.md docs/dev/testing-playbook.md
git commit -m "docs: document SharePoint platform connector"
```

## Task 12: Final Verification

**Files:**

- No new source files unless fixing failures from verification.

**Step 1: Run focused Den tests**

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/den exec tsx --test test/microsoft-*.test.ts test/org-mcp-catalog.test.ts
```

Expected: PASS.

**Step 2: Run focused server tests**

Run:

```bash
npx -y pnpm@10.27.0 --filter veslo-server test src/tests/den-catalog.test.ts src/tests/server.hub-mcp.test.ts
```

Expected: PASS.

**Step 3: Run focused app tests and typecheck**

Run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/mcp-hub-contract.test.ts src/app/tests/lib/mcp-runtime-status-refresh.test.ts
npx -y pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 4: Rebuild server binary**

Run:

```bash
npx -y pnpm@10.27.0 --filter veslo-server build:bin
```

Expected: PASS.

**Step 5: Run Tauri Pilot SharePoint scenario**

Follow desktop preflight in `docs/dev/testing-playbook.md`, then run:

```bash
npx -y pnpm@10.27.0 --filter @neatech/veslo-e2e test:pilot:sharepoint-mcp
```

Expected: PASS.

**Step 6: Refresh graph if available**

Run:

```bash
graphify update .
```

Expected: PASS or clearly report that graphify is unavailable. Dirty graph files are expected after update.

**Step 7: Review final status**

Run:

```bash
git status --short
git log --oneline -12
```

Expected:

- only intentional SharePoint connector changes are staged/committed for this work
- unrelated pre-existing local changes remain untouched
- implementation commits are easy to review task-by-task

**Step 8: Final handoff**

Summarize:

- commits created
- focused tests run
- desktop/Tauri Pilot result
- any unverified real Microsoft tenant smoke
- any unrelated pre-existing dirty files left in the worktree
