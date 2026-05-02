# VSLO-143 Admin-Managed OpenAI-Compatible Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an admin-managed `openai_compatible` provider so DEN can route Veslo inference to a configured OpenAI-compatible API URL with a platform-owned credential.

**Architecture:** Treat `openai_compatible` as a fourth static managed-AI provider alongside `openai`, `anthropic`, and `codex_oauth`. Store its base URL and API key in the encrypted managed-AI secret store, require a specific credential assignment for users, and proxy requests through the existing local Veslo server -> DEN gateway path. Do not add user-managed provider setup or dynamic provider IDs.

**Tech Stack:** TypeScript, Express, Drizzle/MySQL schema already in place, encrypted managed-AI secret store, static DEN admin HTML/CSS/JS, Solid app config generation, Bun server tests, Node test runner with `tsx`.

---

### Task 1: Add The Managed Provider Identity

**Files:**
- Modify: `services/den/src/managed-ai/providers/ids.ts`
- Modify: `services/den/src/managed-ai/credentials/platform-owner.ts`
- Modify: `services/den/src/managed-ai/credentials/secret-store.ts`
- Modify: `services/den/src/managed-ai/providers/transport.ts`
- Test: `services/den/test/managed-ai-openai-compatible-provider.test.ts`

**Step 1: Write the failing test**

Create `services/den/test/managed-ai-openai-compatible-provider.test.ts`:

```ts
import assert from "node:assert/strict"
import test from "node:test"

import {
  MANAGED_AI_PROVIDERS,
  formatManagedAiProviderLabel,
  isManagedAiProvider,
} from "../src/managed-ai/providers/ids.js"
import { getPlatformCredentialOwnerUserId } from "../src/managed-ai/credentials/platform-owner.js"

test("openai_compatible is a managed provider with a platform credential owner", () => {
  assert.equal(MANAGED_AI_PROVIDERS.includes("openai_compatible" as never), true)
  assert.equal(isManagedAiProvider("openai_compatible"), true)
  assert.equal(formatManagedAiProviderLabel("openai_compatible"), "OpenAI-compatible")
  assert.equal(getPlatformCredentialOwnerUserId("openai_compatible" as never), "platform:openai_compatible")
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir services/den exec tsx --test test/managed-ai-openai-compatible-provider.test.ts
```

Expected: FAIL because `openai_compatible` is not in the provider set.

**Step 3: Implement the provider identity**

Update `services/den/src/managed-ai/providers/ids.ts`:

```ts
export const OPENAI_COMPATIBLE_PROVIDER = "openai_compatible" as const
export const MANAGED_AI_PROVIDERS = ["openai", "anthropic", CODEX_OAUTH_PROVIDER, OPENAI_COMPATIBLE_PROVIDER] as const

export function isManagedAiProvider(value: unknown): value is ManagedAiProvider {
  return value === "openai" ||
    value === "anthropic" ||
    value === CODEX_OAUTH_PROVIDER ||
    value === OPENAI_COMPATIBLE_PROVIDER
}

export function isApiKeyCredentialProvider(value: unknown): value is "openai" | "anthropic" | "openai_compatible" {
  return value === "openai" || value === "anthropic" || value === OPENAI_COMPATIBLE_PROVIDER
}

export function formatManagedAiProviderLabel(provider: string): string {
  if (provider === "openai") return "OpenAI"
  if (provider === "anthropic") return "Anthropic"
  if (provider === CODEX_OAUTH_PROVIDER) return "Codex OAuth"
  if (provider === OPENAI_COMPATIBLE_PROVIDER) return "OpenAI-compatible"
  return provider
}
```

Update `services/den/src/managed-ai/credentials/platform-owner.ts`:

```ts
export const PLATFORM_CREDENTIAL_OWNER_BY_PROVIDER: Record<LeaseProvider, string> = {
  openai: "platform:openai",
  anthropic: "platform:anthropic",
  codex_oauth: "platform:codex_oauth",
  openai_compatible: "platform:openai_compatible",
}
```

Update `services/den/src/managed-ai/credentials/secret-store.ts`:

```ts
export type StoredSecret =
  | { kind: "api_key"; apiKey: string }
  | { kind: "openai_compatible_api_key"; apiKey: string; baseUrl: string }
  | { kind: "openai_oauth"; accessToken: string; refreshToken: string; expiresAt: string }
  | { kind: "codex_auth_json"; authJson: string }
```

Update `services/den/src/managed-ai/providers/transport.ts`:

```ts
export type OpenAiCompatibleTransportInput = {
  apiKey: string
  baseUrl: string
  body: unknown
}

export interface OpenAiCompatibleProviderTransport {
  chatCompletions(input: OpenAiCompatibleTransportInput): Promise<ProviderTransportResponse>
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --dir services/den exec tsx --test test/managed-ai-openai-compatible-provider.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/managed-ai/providers/ids.ts services/den/src/managed-ai/credentials/platform-owner.ts services/den/src/managed-ai/credentials/secret-store.ts services/den/src/managed-ai/providers/transport.ts services/den/test/managed-ai-openai-compatible-provider.test.ts
git commit -m "feat: add managed openai-compatible provider id"
```

### Task 2: Add Admin Credential Validation And Storage

**Files:**
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Modify: `services/den/src/http/admin.ts`
- Test: `services/den/test/admin-managed-ai-credentials.test.ts`

**Step 1: Write failing credential tests**

Add tests to `services/den/test/admin-managed-ai-credentials.test.ts`:

```ts
test("POST /admin/api/credentials creates an OpenAI-compatible credential", async () => {
  const session = createSession()
  const calls = {
    secrets: [] as Array<{ kind: string; apiKey?: string; baseUrl?: string }>,
    credentials: [] as Array<{ ownerUserId: string; provider: string; credentialType: "api_key" | "oauth"; secretRef: string; name: string }>,
  }
  const app = express()
  app.use(express.json())
  app.use("/admin/api", createAdminRouter({
    async getSessionSnapshot() { return session },
    ...createManagedAiAdminRouteDeps({
      async getAdminSession() { return session },
      aiAccess: {} as any,
      alerts: { async listAlerts() { return [] } } as any,
      audit: { async recordEvent() {}, async listEvents() { return [] } } as any,
      credentials: {
        async listAdminCredentials() {
          return [{
            id: "cred_platform_oai_compatible_1",
            name: "OpenRouter",
            provider: "openai_compatible",
            type: "api_key",
            state: "healthy",
            scope: "platform:openai_compatible",
            activeLeases: 0,
            alertCount: 0,
            lastRefreshAt: "2026-05-02T10:00:00.000Z",
            lastFailureAt: null,
            totalTokens: 0,
            nextRotationAt: null,
            linkedAlertIds: [],
          }]
        },
        async createPlatformCredential(input) {
          calls.credentials.push(input)
          return {
            id: "cred_platform_oai_compatible_1",
            ownerUserId: input.ownerUserId,
            provider: input.provider,
            credentialType: input.credentialType,
            state: "healthy",
            secretRef: input.secretRef,
            name: input.name,
            createdAt: new Date("2026-05-02T10:00:00.000Z"),
            updatedAt: new Date("2026-05-02T10:00:00.000Z"),
            lastFailureAt: null,
          }
        },
      } as any,
      leases: {} as any,
      secrets: {
        async put(secret) {
          calls.secrets.push(secret)
          return { secretRef: "secret_custom_1" }
        },
      } as any,
      usage: {} as any,
    }),
  }))

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai_compatible",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        secret: "sk-or-key",
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(calls.secrets, [{
      kind: "openai_compatible_api_key",
      apiKey: "sk-or-key",
      baseUrl: "https://openrouter.ai/api/v1",
    }])
    assert.deepEqual(calls.credentials, [{
      ownerUserId: "platform:openai_compatible",
      provider: "openai_compatible",
      credentialType: "api_key",
      secretRef: "secret_custom_1",
      name: "OpenRouter",
    }])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("POST /admin/api/credentials rejects OpenAI-compatible credentials without a base URL", async () => {
  // Use the same app setup as the create test.
  // Send provider openai_compatible with secret but no baseUrl.
  // Expected: status 400, body { error: "invalid_credential_base_url" }.
})
```

Also add invalid URL coverage:

- `baseUrl: "not a url"` -> `invalid_credential_base_url`
- hosted HTTP URL such as `http://api.example.test/v1` -> `invalid_credential_base_url`
- local HTTP URL such as `http://127.0.0.1:1234/v1` is accepted

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --dir services/den exec tsx --test test/admin-managed-ai-credentials.test.ts
```

Expected: FAIL because `baseUrl` is ignored and the new provider is not stored as the new secret kind.

**Step 3: Implement admin validation**

In `services/den/src/managed-ai/http/admin.ts`, extend `CreateCredentialInput`:

```ts
type CreateCredentialInput = {
  provider: LeaseProvider | null
  name?: string | null
  secret: string
  baseUrl?: string | null
}
```

Add helpers:

```ts
function normalizeOpenAiCompatibleBaseUrl(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : ""
  if (!raw) throw new HttpError("invalid_credential_base_url", 400)

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new HttpError("invalid_credential_base_url", 400)
  }

  const hostname = parsed.hostname.toLowerCase()
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new HttpError("invalid_credential_base_url", 400)
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "")
  return parsed.toString().replace(/\/+$/, "")
}
```

Update `validateCreateCredentialInput`:

```ts
if (provider === "openai_compatible") {
  return {
    provider,
    name: name || `${formatProviderLabel(provider)} credential`,
    credentialType: "api_key",
    storedSecret: {
      kind: "openai_compatible_api_key",
      apiKey: secret,
      baseUrl: normalizeOpenAiCompatibleBaseUrl(input.baseUrl),
    },
  }
}
```

Leave existing `openai`, `anthropic`, and `codex_oauth` behavior unchanged.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --dir services/den exec tsx --test test/admin-managed-ai-credentials.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/managed-ai/http/admin.ts services/den/src/http/admin.ts services/den/test/admin-managed-ai-credentials.test.ts
git commit -m "feat: create admin-managed openai-compatible credentials"
```

### Task 3: Require Assigned Credentials For OpenAI-Compatible Access

**Files:**
- Modify: `services/den/src/http/admin.ts`
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Modify: `services/den/public-admin/app.js`
- Test: `services/den/test/admin-managed-ai-user-access.test.ts`

**Step 1: Write failing tests**

Add coverage to `services/den/test/admin-managed-ai-user-access.test.ts`:

```ts
test("PUT /admin/api/users/:userId/ai-access requires an OpenAI-compatible credential", async () => {
  // Build an admin app with createManagedAiAdminRouteDeps.
  // PUT enabled true, provider "openai_compatible", defaultModel "qwen/qwen3", credentialId null.
  // Expected: 400 { error: "invalid_ai_access_credential_id" }.
})

test("PUT /admin/api/users/:userId/ai-access accepts a healthy OpenAI-compatible credential", async () => {
  // listAdminCredentials returns a healthy openai_compatible credential.
  // PUT enabled true, provider "openai_compatible", credentialId "cred_custom_1", defaultModel "qwen/qwen3".
  // Expected: 200 and saved aiAccess.credentialId === "cred_custom_1".
})
```

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --dir services/den exec tsx --test test/admin-managed-ai-user-access.test.ts
```

Expected: FAIL because credential requirement and available credential filtering only handle Codex.

**Step 3: Generalize available credential options**

In `services/den/src/http/admin.ts`, extend `AdminCredentialOption`:

```ts
export type AdminCredentialOption = {
  id: string
  name: string
  provider?: ManagedAiProvider
}
```

In `services/den/src/managed-ai/http/admin.ts`, replace `listAvailableCodexCredentials` with a generic helper:

```ts
async function listAvailableAssignmentCredentials(): Promise<AdminCredentialOption[] | undefined> {
  const listAdminCredentials = deps.credentials.listAdminCredentials
  if (!listAdminCredentials) return undefined

  const credentials = await listAdminCredentials.call(deps.credentials)
  const options: AdminCredentialOption[] = []

  for (const credential of credentials) {
    if (credential.state !== "healthy") continue
    if (credential.provider === "openai_compatible") {
      options.push({ id: credential.id, name: credential.name, provider: "openai_compatible" })
      continue
    }
    if (credential.provider === "codex_oauth" && codexStatusProvider) {
      const status = await codexStatusProvider.getStatus({ credentialId: credential.id, credentialName: credential.name })
      if (evaluateCodexCredentialEligibility(status, now()).eligible) {
        options.push({ id: credential.id, name: credential.name, provider: "codex_oauth" })
      }
    }
  }

  return options
}
```

Add provider-aware validation:

```ts
if (enabled && (provider === "codex_oauth" || provider === "openai_compatible") && !credentialId) {
  throw new HttpError("invalid_ai_access_credential_id", 400)
}
```

Add `assertAssignableCredential(provider, credentialId)` so a chosen credential must exist, be healthy, and match the selected provider. Keep the Codex eligibility check for `codex_oauth`.

**Step 4: Update the admin UI credential selector**

In `services/den/public-admin/app.js`, filter options by selected provider:

```js
function currentUserAiAccessAvailableCredentials(userId, provider = "") {
  return normalizeAvailableCredentials(state.userAiAccessAvailableCredentialsByUserId[userId] || [])
    .filter((entry) => !provider || entry.provider === provider);
}
```

Update `readAiAccessCredentialValue()` so `openai_compatible` also reads the credential selector:

```js
if (selectedProvider === "codex_oauth" || selectedProvider === "openai_compatible") {
  const selectedCredentialId = els.userAiAccessCredential.value.trim();
  return selectedCredentialId || null;
}
```

Update status copy for `openai_compatible` when no credential exists.

**Step 5: Run tests**

Run:

```bash
pnpm --dir services/den exec tsx --test test/admin-managed-ai-user-access.test.ts
pnpm --dir services/den exec tsx --test test/admin-managed-ai-ui.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/http/admin.ts services/den/src/managed-ai/http/admin.ts services/den/public-admin/app.js services/den/test/admin-managed-ai-user-access.test.ts services/den/test/admin-managed-ai-ui.test.ts
git commit -m "feat: assign openai-compatible credentials to users"
```

### Task 4: Add The OpenAI-Compatible DEN Transport And Proxy

**Files:**
- Create: `services/den/src/managed-ai/providers/openai-compatible-transport.ts`
- Create: `services/den/src/managed-ai/http/providers/openai-compatible.ts`
- Modify: `services/den/src/managed-ai/http/proxy.ts`
- Modify: `services/den/src/managed-ai/runtime/default-runtime.ts`
- Test: `services/den/test/managed-ai-openai-compatible-proxy.test.ts`

**Step 1: Write failing proxy tests**

Create `services/den/test/managed-ai-openai-compatible-proxy.test.ts`:

```ts
import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { createProxyRouter } from "../src/managed-ai/http/proxy.js"

test("openai_compatible proxy calls the assigned credential base URL with bearer key", async () => {
  const calls: Array<{ baseUrl: string; apiKey: string; body: unknown }> = []
  const app = express()
  app.use(express.json())
  app.use(createProxyRouter({
    gatewaySessions: {
      async resolveSession() {
        return { token: "gateway-token", user: { id: "user_gateway", email: "user@example.test" } }
      },
    },
    aiAccess: {
      async getUserAiAccess() {
        return {
          id: "access_1",
          userId: "user_gateway",
          enabled: true,
          provider: "openai_compatible",
          credentialId: "cred_custom_1",
          defaultModel: "custom-model",
          allowedModels: ["custom-model"],
          createdAt: new Date("2026-05-02T10:00:00.000Z"),
          updatedAt: new Date("2026-05-02T10:00:00.000Z"),
        }
      },
    },
    credentials: {
      async getCredentialRecordById() { return null },
      async listHealthyCredentialRecordIds() { return [] },
      async getBindingByCredentialId() {
        return {
          id: "binding_custom_1",
          ownerUserId: "platform:openai_compatible",
          provider: "openai_compatible",
          credentialRecordId: "cred_custom_1",
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      },
      async getCredentialRecordByBindingId() {
        return {
          id: "cred_custom_1",
          name: "Custom provider",
          ownerUserId: "platform:openai_compatible",
          provider: "openai_compatible",
          credentialType: "api_key",
          state: "healthy",
          secretRef: "secret_custom_1",
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      },
      async markCredentialState() {},
    } as any,
    secrets: {
      async get() {
        return { kind: "openai_compatible_api_key", apiKey: "sk-custom", baseUrl: "https://custom.example.test/v1" }
      },
    } as any,
    usageRepository: { async recordUsage() {} } as any,
    leaseBroker: {
      async getOrCreateActiveLease(input) {
        return { id: "lease_1", ownerUserId: input.ownerUserId, provider: input.provider, sessionId: input.sessionId, activeBindingId: input.requiredBindingId! }
      },
      async handleUpstreamFailure() { throw new Error("unused") },
    } as any,
    tokenBroker: {} as any,
    openAiTransport: {} as any,
    anthropicTransport: {} as any,
    codexOAuthTransport: {} as any,
    openAiCompatibleTransport: {
      async chatCompletions(input) {
        calls.push(input)
        return { status: 200, body: { id: "chatcmpl_custom", model: "custom-model", usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } } }
      },
    },
  } as any))

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai_compatible/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-token",
        "content-type": "application/json",
        "x-veslo-session-id": "session_custom_1",
      },
      body: JSON.stringify({ model: "custom-model", messages: [{ role: "user", content: "hi" }] }),
    })

    assert.equal(response.status, 200)
    assert.equal(calls[0]?.baseUrl, "https://custom.example.test/v1")
    assert.equal(calls[0]?.apiKey, "sk-custom")
  } finally {
    server.close()
    await once(server, "close")
  }
})
```

Also test:

- wrong assigned provider returns `provider_not_assigned`
- missing `credentialId` returns `assigned_credential_unavailable`
- stored secret with wrong kind returns `invalid_custom_provider_config`

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir services/den exec tsx --test test/managed-ai-openai-compatible-proxy.test.ts
```

Expected: FAIL because the route and transport do not exist.

**Step 3: Implement the transport**

Create `services/den/src/managed-ai/providers/openai-compatible-transport.ts`:

```ts
import {
  headersToRecord,
  ProviderTransportError,
  readProviderResponseBody,
  type OpenAiCompatibleProviderTransport,
  type OpenAiCompatibleTransportInput,
  type ProviderTransportResponse,
} from "./transport.js"

export class OpenAiCompatibleTransport implements OpenAiCompatibleProviderTransport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async chatCompletions(input: OpenAiCompatibleTransportInput): Promise<ProviderTransportResponse> {
    const baseUrl = input.baseUrl.replace(/\/+$/, "")
    const response = await this.fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify(input.body),
    })

    const body = await readProviderResponseBody(response)
    const headers = headersToRecord(response.headers)
    if (!response.ok) {
      throw new ProviderTransportError(`openai_compatible_upstream_${response.status}`, {
        statusCode: response.status,
        body,
        headers,
      })
    }

    return { status: response.status, body, headers }
  }
}
```

**Step 4: Implement the proxy router**

Create `services/den/src/managed-ai/http/providers/openai-compatible.ts`.

Copy the OpenAI router structure, but:

- route provider is `openai_compatible`
- resolve an assigned binding from `gatewayAiAccess.credentialId`
- load secret from that credential
- require `secret.kind === "openai_compatible_api_key"`
- call `deps.openAiCompatibleTransport.chatCompletions({ apiKey, baseUrl, body })`
- record usage with provider `openai_compatible`
- request id fallback prefix is `openai_compatible_req_`

**Step 5: Wire the router and runtime dependencies**

In `services/den/src/managed-ai/http/proxy.ts`:

```ts
import { createOpenAiCompatibleProxyRouter } from "./providers/openai-compatible.js"
import type { OpenAiCompatibleProviderTransport } from "../providers/transport.js"

export type ProxyDependencies = {
  // existing deps...
  openAiCompatibleTransport: OpenAiCompatibleProviderTransport
}

router.use("/providers/openai_compatible", createOpenAiCompatibleProxyRouter(deps))
```

In `services/den/src/managed-ai/runtime/default-runtime.ts`:

```ts
import { OpenAiCompatibleTransport } from "../providers/openai-compatible-transport.js"

openAiCompatibleTransport: OpenAiCompatibleTransport

openAiCompatibleTransport: overrides.openAiCompatibleTransport ?? new OpenAiCompatibleTransport(),
```

**Step 6: Run tests**

Run:

```bash
pnpm --dir services/den exec tsx --test test/managed-ai-openai-compatible-proxy.test.ts test/managed-ai-proxy-access-policy.test.ts test/managed-ai-proxy-usage.test.ts
pnpm --dir services/den run build
```

Expected: PASS.

**Step 7: Commit**

```bash
git add services/den/src/managed-ai/providers/openai-compatible-transport.ts services/den/src/managed-ai/http/providers/openai-compatible.ts services/den/src/managed-ai/http/proxy.ts services/den/src/managed-ai/runtime/default-runtime.ts services/den/test/managed-ai-openai-compatible-proxy.test.ts
git commit -m "feat: route openai-compatible managed requests"
```

### Task 5: Add DEN Admin UI Controls

**Files:**
- Modify: `services/den/public-admin/index.html`
- Modify: `services/den/public-admin/app.js`
- Modify: `services/den/public-admin/app.css` only if existing classes cannot support the layout
- Test: `services/den/test/admin-managed-ai-ui.test.ts`

**Step 1: Write failing UI tests**

In `services/den/test/admin-managed-ai-ui.test.ts`, assert the static admin shell includes:

- `credential-openai-compatible-name`
- `credential-openai-compatible-base-url`
- `credential-openai-compatible-secret`
- `credential-openai-compatible-submit`
- an AI access provider option with value `openai_compatible`

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir services/den exec tsx --test test/admin-managed-ai-ui.test.ts
```

Expected: FAIL because the admin UI has no custom provider controls.

**Step 3: Add the credential creation card**

In `services/den/public-admin/index.html`, add a detail card near the existing provider credential cards:

```html
<div class="detail-card">
  <p class="eyebrow">Custom OpenAI-compatible provider</p>
  <h4>OpenAI-compatible API</h4>
  <div class="credential-create-grid">
    <label>
      <span>Display name</span>
      <input class="input" id="credential-openai-compatible-name" type="text" placeholder="OpenRouter" />
    </label>
    <label>
      <span>Base URL</span>
      <input class="input" id="credential-openai-compatible-base-url" type="url" placeholder="https://provider.example.com/v1" />
    </label>
  </div>
  <label class="credential-create-secret-field">
    <span>API key</span>
    <textarea class="input ai-access-textarea" id="credential-openai-compatible-secret" placeholder="Paste the provider API key."></textarea>
  </label>
  <div class="button-row">
    <button class="button button-primary" id="credential-openai-compatible-submit" type="button">Save custom provider</button>
    <p class="editor-note credential-create-status" id="credential-openai-compatible-status">OpenAI-compatible providers use a custom /v1 base URL and bearer API key.</p>
  </div>
</div>
```

Add the Users provider select option if the options are static in `index.html`:

```html
<option value="openai_compatible">OpenAI-compatible</option>
```

**Step 4: Add JS behavior**

In `services/den/public-admin/app.js`, add elements and helpers matching the Codex/Anthropic pattern:

```js
credentialOpenAiCompatibleName: document.getElementById("credential-openai-compatible-name"),
credentialOpenAiCompatibleBaseUrl: document.getElementById("credential-openai-compatible-base-url"),
credentialOpenAiCompatibleSecret: document.getElementById("credential-openai-compatible-secret"),
credentialOpenAiCompatibleSubmit: document.getElementById("credential-openai-compatible-submit"),
credentialOpenAiCompatibleStatus: document.getElementById("credential-openai-compatible-status"),
```

Add `createOpenAiCompatibleCredential()`:

```js
async function createOpenAiCompatibleCredential() {
  const name = els.credentialOpenAiCompatibleName.value.trim();
  const baseUrl = els.credentialOpenAiCompatibleBaseUrl.value.trim();
  const secret = els.credentialOpenAiCompatibleSecret.value.trim();
  if (!baseUrl || !secret) {
    setOpenAiCompatibleCredentialStatus("Base URL and API key are required.", "error");
    return;
  }

  els.credentialOpenAiCompatibleSubmit.disabled = true;
  setOpenAiCompatibleCredentialStatus("Saving custom provider credential", "pending");
  try {
    const requestBody = { provider: "openai_compatible", baseUrl, secret };
    if (name) requestBody.name = name;
    const payload = await fetchJson("/credentials", { method: "POST", body: JSON.stringify(requestBody) });
    state.selectedCredentialId = payload?.credential?.id || state.selectedCredentialId;
    resetOpenAiCompatibleCredentialForm();
    setOpenAiCompatibleCredentialStatus("Custom provider credential saved to the platform pool.", "success");
    await refreshCredentialOperations();
    await refreshSelectedUserAiAccessOptions();
  } catch (error) {
    setOpenAiCompatibleCredentialStatus(`Unable to save custom provider: ${error instanceof Error ? error.message : "unknown_error"}`, "error");
  } finally {
    els.credentialOpenAiCompatibleSubmit.disabled = false;
  }
}
```

Bind the button in `bindActions()`.

**Step 5: Run tests**

Run:

```bash
pnpm --dir services/den exec tsx --test test/admin-managed-ai-ui.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/public-admin/index.html services/den/public-admin/app.js services/den/test/admin-managed-ai-ui.test.ts
git add services/den/public-admin/app.css # only if modified
git commit -m "feat: add admin ui for openai-compatible providers"
```

### Task 6: Generate Desktop OpenCode Config For The New Provider

**Files:**
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/utils/providers.ts`
- Modify: `packages/app/src/app/lib/opencode.ts`
- Modify: `packages/app/src/app/lib/ai-access.ts`
- Test: `packages/app/src/app/lib/provider-routing.test.ts`
- Test: `packages/app/src/app/lib/ai-access.test.ts`
- Test: `packages/app/src/app/utils/providers.test.ts`

**Step 1: Write failing app tests**

In `packages/app/src/app/lib/provider-routing.test.ts`, add:

```ts
test("openai_compatible provider config points at ai-gateway custom route", () => {
  const updated = applyGatewayProviderRouting(
    JSON.stringify({ provider: {} }),
    {
      providerId: "openai_compatible",
      serverBaseUrl: "http://127.0.0.1:4318",
      serverClientToken: "veslo-client-token",
      gatewayAccessToken: "gateway-access-token",
      models: ["custom-model"],
    },
  )

  const parsed = JSON.parse(updated) as any
  assert.equal(parsed.provider?.openai_compatible?.name, "OpenAI-compatible")
  assert.equal(parsed.provider?.openai_compatible?.npm, "@ai-sdk/openai-compatible")
  assert.deepEqual(parsed.provider?.openai_compatible?.env, [])
  assert.equal(parsed.provider?.openai_compatible?.options?.baseURL, "http://127.0.0.1:4318/ai-gateway/providers/openai_compatible/v1")
  assert.equal(parsed.provider?.openai_compatible?.options?.apiKey, "veslo-client-token")
  assert.deepEqual(parsed.provider?.openai_compatible?.models?.["custom-model"]?.headers, {
    "x-veslo-gateway-token": "gateway-access-token",
    "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
  })
})
```

In `packages/app/src/app/lib/ai-access.test.ts`, add a managed access test proving `formatManagedAiAccessConfig` writes `model: "openai_compatible/custom-model"`.

In `packages/app/src/app/utils/providers.test.ts`, add `isGatewayOwnedProvider("openai_compatible") === true`.

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --dir packages/app exec node --test --import=tsx/esm src/app/lib/provider-routing.test.ts src/app/lib/ai-access.test.ts src/app/utils/providers.test.ts
```

Expected: FAIL because the app does not know the new provider.

**Step 3: Implement app provider support**

In `packages/app/src/app/lib/veslo-server.ts`:

```ts
export type VesloGatewayProvider = "openai" | "anthropic" | "codex_oauth" | "openai_compatible";
```

In `packages/app/src/app/utils/providers.ts`:

```ts
export const GATEWAY_OWNED_PROVIDER_IDS = ["openai", "anthropic", "codex_oauth", "openai_compatible"] as const;
```

In `packages/app/src/app/lib/opencode.ts`, treat `openai_compatible` like `codex_oauth` for OpenAI-compatible config:

```ts
const isOpenAiCompatibleGatewayProvider = providerId === "codex_oauth" || providerId === "openai_compatible";
```

Use that boolean to add:

```ts
name: providerId === "codex_oauth" ? "Veslo Codex OAuth" : "OpenAI-compatible",
npm: "@ai-sdk/openai-compatible",
env: [],
options: {
  ...existingOptions,
  apiKey: serverClientToken,
  baseURL: `${serverBaseUrl}/ai-gateway/providers/${providerId}/v1`,
}
```

For model headers, omit `Authorization` for `openai_compatible` the same way Codex does. The local server uses `x-veslo-gateway-token` to authenticate to DEN.

**Step 4: Run tests**

Run:

```bash
pnpm --dir packages/app exec node --test --import=tsx/esm src/app/lib/provider-routing.test.ts src/app/lib/ai-access.test.ts src/app/utils/providers.test.ts
pnpm --dir packages/app run typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/veslo-server.ts packages/app/src/app/utils/providers.ts packages/app/src/app/lib/opencode.ts packages/app/src/app/lib/ai-access.ts packages/app/src/app/lib/provider-routing.test.ts packages/app/src/app/lib/ai-access.test.ts packages/app/src/app/utils/providers.test.ts
git commit -m "feat: configure openai-compatible desktop routing"
```

### Task 7: Add Local Veslo Server Proxy Route

**Files:**
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/src/server.ai-gateway.test.ts`

**Step 1: Write failing server test**

In `packages/server/src/server.ai-gateway.test.ts`, add a test mirroring the Codex route test:

```ts
test("server proxies ai-gateway openai_compatible chat completions route", async () => {
  // Start a fake managed AI target.
  // POST to /ai-gateway/providers/openai_compatible/v1/chat/completions.
  // Include x-veslo-gateway-token and x-veslo-session-id.
  // Assert target pathname is /providers/openai_compatible/v1/chat/completions.
  // Assert Authorization is Bearer <gateway-token>.
  // Assert request body is forwarded unchanged.
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir packages/server exec bun test src/server.ai-gateway.test.ts
```

Expected: FAIL with 404 for the new local proxy route.

**Step 3: Implement the route**

In `packages/server/src/server.ts`, add:

```ts
addRoute(routes, "POST", "/ai-gateway/providers/openai_compatible/v1/chat/completions", "client", async (ctx) => {
  return proxyAiGatewayRequest({
    request: ctx.request,
    url: ctx.url,
    gatewayPath: "/providers/openai_compatible/v1/chat/completions",
    auth: "gateway-token",
    requireSessionId: true,
  });
});
```

**Step 4: Run tests**

Run:

```bash
pnpm --dir packages/server exec bun test src/server.ai-gateway.test.ts
pnpm --dir packages/server run typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/server.ai-gateway.test.ts
git commit -m "feat: proxy openai-compatible gateway requests"
```

### Task 8: Add Documentation And Regression Verification

**Files:**
- Modify: `docs/admin-managed-ai-access.md`
- Modify: `docs/features/session-runtime.md`
- Modify: `docs/dev/state-and-config-reference.md` if a new persisted key or policy field is documented there

**Step 1: Update docs**

Document:

- `openai_compatible` as an admin-managed provider
- admin-created credential requires base URL and API key
- assigned credential is required for user access
- desktop still receives read-only policy and routes through local Veslo server
- custom provider is OpenAI-compatible only

**Step 2: Run focused regression tests**

Run:

```bash
pnpm --dir services/den exec tsx --test \
  test/admin-managed-ai-credentials.test.ts \
  test/admin-managed-ai-user-access.test.ts \
  test/admin-managed-ai-ui.test.ts \
  test/managed-ai-openai-compatible-provider.test.ts \
  test/managed-ai-openai-compatible-proxy.test.ts \
  test/managed-ai-proxy-access-policy.test.ts \
  test/managed-ai-proxy-usage.test.ts

pnpm --dir services/den run build

pnpm --dir packages/app exec node --test --import=tsx/esm \
  src/app/lib/provider-routing.test.ts \
  src/app/lib/ai-access.test.ts \
  src/app/utils/providers.test.ts

pnpm --dir packages/app run typecheck

pnpm --dir packages/server exec bun test src/server.ai-gateway.test.ts
pnpm --dir packages/server run typecheck
```

Expected: all pass.

**Step 3: Commit**

```bash
git add docs/admin-managed-ai-access.md docs/features/session-runtime.md docs/dev/state-and-config-reference.md
git commit -m "docs: document admin-managed openai-compatible providers"
```

### Task 9: Desktop Tauri Runtime Smoke Verification

**Files:**
- Modify or create E2E only if an existing spec can be extended safely:
  - `packages/e2e/specs/den-managed-openai-anthropic.spec.ts`
  - or create `packages/e2e/specs/den-managed-openai-compatible.spec.ts`

**Step 1: Add or document a live smoke path**

Prefer a live/manual-capable E2E spec guarded by env vars:

```bash
VESLO_E2E_EXPECTED_MANAGED_AI_PROVIDER=openai_compatible
VESLO_E2E_EXPECTED_MANAGED_AI_MODEL=<custom-model>
VESLO_E2E_OPENAI_COMPATIBLE_CREDENTIAL_ID=<credential-id>
pnpm --dir packages/e2e test --spec ./specs/den-managed-openai-compatible.spec.ts
```

The test should:

- authenticate using the existing desktop auth seed flow
- assign the current test user to `openai_compatible`
- verify Settings shows the assignment
- send a prompt from the Tauri runtime
- assert a response renders

**Step 2: Run when live credentials are available**

Run the E2E only when an actual OpenAI-compatible test endpoint and key are available. If credentials are not available in the implementation session, document the skipped live verification and complete all deterministic unit/build checks.

**Step 3: Commit if E2E was added**

```bash
git add packages/e2e/specs/den-managed-openai-compatible.spec.ts packages/e2e/helpers/live-admin-client.ts
git commit -m "test: add openai-compatible desktop smoke path"
```

### Task 10: Final Review

**Files:**
- No planned modifications

**Step 1: Review git history and status**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: clean worktree after committed tasks.

**Step 2: Run final verification bundle**

Run:

```bash
pnpm --dir services/den run build
pnpm --dir packages/app run typecheck
pnpm --dir packages/server run typecheck
```

Expected: all pass.

**Step 3: Summarize residual risk**

Call out whether live Tauri smoke verification ran. If it did not run, list the missing endpoint/key requirement explicitly.
