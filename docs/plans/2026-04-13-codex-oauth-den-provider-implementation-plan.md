# Codex OAuth DEN Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a DEN-managed `codex_oauth` pseudo-provider so Veslo/OpenCode prompts route through DEN/Render using a server-side Codex/ChatGPT OAuth credential instead of user-managed provider API keys.

**Architecture:** Keep Veslo desktop talking to local OpenCode, and keep OpenCode talking to a gateway-compatible DEN provider endpoint. Add `codex_oauth` as the managed provider identity, store the Codex OAuth credential server-side, route requests through a Codex runtime adapter, and keep existing lease, policy, usage, audit, and alert behavior.

**Tech Stack:** TypeScript, Express, Node test runner, Drizzle/MySQL, SolidJS app utilities, static DEN admin UI, OpenCode provider config JSON.

---

## Ground Rules

- Do not modify `vendor/opencode`.
- Do not commit secrets, OAuth tokens, API keys, or local auth cache contents.
- Keep `openai` and `anthropic` API-key paths intact as legacy/fallback paths unless a task explicitly says otherwise.
- Do not present `codex_oauth` as a raw Anthropic/OpenAI API credential. It is a Codex/ChatGPT runtime credential.
- Run focused tests after each task and commit each task separately.

## Task 1: Live Codex OAuth Compatibility Gate

**Files:**
- Create: `services/den/scripts/probe-codex-oauth-runtime.ts`
- Test: no committed unit test; this is a live diagnostic script.

**Step 1: Add the probe script**

Create `services/den/scripts/probe-codex-oauth-runtime.ts`:

```ts
const accessToken = process.env.MANAGED_AI_CODEX_ACCESS_TOKEN?.trim() ?? ""
const baseUrl = (process.env.MANAGED_AI_CODEX_TEST_BASE_URL ?? "https://api.openai.com").replace(/\/+$/, "")
const model = process.env.MANAGED_AI_CODEX_TEST_MODEL?.trim() || "gpt-5.4"

if (!accessToken) {
  throw new Error("MANAGED_AI_CODEX_ACCESS_TOKEN is required")
}

const response = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    max_tokens: 8,
  }),
})

const text = await response.text()
console.log(JSON.stringify({
  ok: response.ok,
  status: response.status,
  contentType: response.headers.get("content-type"),
  body: text.slice(0, 2000),
}, null, 2))

if (!response.ok) {
  process.exitCode = 1
}
```

**Step 2: Run the probe without a token to verify safe failure**

Run: `pnpm --dir services/den exec tsx scripts/probe-codex-oauth-runtime.ts`

Expected: FAIL with `MANAGED_AI_CODEX_ACCESS_TOKEN is required`.

**Step 3: Run the live probe with a real short-lived access token**

Run with the token supplied from the admin OAuth exchange environment, not pasted into shell history if avoidable:

```bash
MANAGED_AI_CODEX_ACCESS_TOKEN=<redacted> pnpm --dir services/den exec tsx scripts/probe-codex-oauth-runtime.ts
```

Expected if direct HTTP is viable: HTTP 200 and a response body with a model answer.

Expected if direct HTTP is not viable: HTTP 401/403 or a clear upstream auth error. If this happens, stop broad implementation and switch the adapter task to a DEN-hosted Codex CLI worker implementation with a separate reviewed plan.

**Step 4: Commit**

```bash
git add services/den/scripts/probe-codex-oauth-runtime.ts
git commit -m "chore: add codex oauth runtime probe"
```

## Task 2: Add Shared `codex_oauth` Provider Identity

**Files:**
- Create: `services/den/src/managed-ai/providers/ids.ts`
- Modify: `services/den/src/managed-ai/leases/repository.ts`
- Modify: `services/den/src/managed-ai/access/repository.ts`
- Modify: `services/den/src/managed-ai/credentials/platform-owner.ts`
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Test: `services/den/test/admin-managed-ai-user-access.test.ts`

**Step 1: Write the failing tests**

Add a test in `services/den/test/admin-managed-ai-user-access.test.ts` proving that admin AI access accepts `codex_oauth`:

```ts
test("admin can assign codex_oauth managed AI access", async () => {
  const app = createTestApp()
  const response = await fetchJson(app, "/admin/api/users/user_1/ai-access", {
    method: "PUT",
    body: {
      enabled: true,
      provider: "codex_oauth",
      defaultModel: "gpt-5.4",
      allowedModels: ["gpt-5.4"],
    },
  })

  assert.equal(response.status, 200)
  assert.equal(response.body.aiAccess.provider, "codex_oauth")
  assert.equal(response.body.aiAccess.defaultModel, "gpt-5.4")
})
```

Adjust helper names to match the existing test file.

**Step 2: Run the test to verify it fails**

Run: `pnpm --dir services/den exec tsx --test test/admin-managed-ai-user-access.test.ts`

Expected: FAIL with `invalid_ai_access_provider` or equivalent.

**Step 3: Add provider identity helpers**

Create `services/den/src/managed-ai/providers/ids.ts`:

```ts
export const MANAGED_AI_PROVIDERS = ["openai", "anthropic", "codex_oauth"] as const
export type ManagedAiProvider = (typeof MANAGED_AI_PROVIDERS)[number]

export const CODEX_OAUTH_PROVIDER = "codex_oauth" as const

export function isManagedAiProvider(value: unknown): value is ManagedAiProvider {
  return value === "openai" || value === "anthropic" || value === CODEX_OAUTH_PROVIDER
}

export function isApiKeyCredentialProvider(value: unknown): value is "anthropic" {
  return value === "anthropic"
}

export function formatManagedAiProviderLabel(provider: string): string {
  if (provider === "openai") return "OpenAI"
  if (provider === "anthropic") return "Anthropic"
  if (provider === CODEX_OAUTH_PROVIDER) return "Codex OAuth"
  return provider
}
```

**Step 4: Wire provider types**

Modify `services/den/src/managed-ai/leases/repository.ts`:

```ts
import type { ManagedAiProvider } from "../providers/ids.js"

export type LeaseProvider = ManagedAiProvider
```

Modify `services/den/src/managed-ai/access/repository.ts`:

```ts
import { MANAGED_AI_PROVIDERS, type ManagedAiProvider } from "../providers/ids.js"

export const AiAccessProviders = MANAGED_AI_PROVIDERS
export type AiAccessProvider = ManagedAiProvider
```

Modify `services/den/src/managed-ai/credentials/platform-owner.ts`:

```ts
export const PLATFORM_CREDENTIAL_OWNER_BY_PROVIDER: Record<LeaseProvider, string> = {
  openai: "platform:openai",
  anthropic: "platform:anthropic",
  codex_oauth: "platform:codex_oauth",
}
```

**Step 5: Update admin validation**

Modify `services/den/src/managed-ai/http/admin.ts`:

- Import `formatManagedAiProviderLabel`, `isApiKeyCredentialProvider`, and `isManagedAiProvider`.
- Keep generic secret credential creation restricted to API-key providers:

```ts
function parseCredentialProvider(value: unknown): LeaseProvider | null {
  return isApiKeyCredentialProvider(value) ? value : null
}

function parseAiAccessProvider(value: unknown): AiAccessProvider | null {
  return isManagedAiProvider(value) ? value : null
}

function formatProviderLabel(provider: string) {
  return formatManagedAiProviderLabel(provider)
}
```

**Step 6: Run focused tests**

Run: `pnpm --dir services/den exec tsx --test test/admin-managed-ai-user-access.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add services/den/src/managed-ai/providers/ids.ts services/den/src/managed-ai/leases/repository.ts services/den/src/managed-ai/access/repository.ts services/den/src/managed-ai/credentials/platform-owner.ts services/den/src/managed-ai/http/admin.ts services/den/test/admin-managed-ai-user-access.test.ts
git commit -m "feat: add codex oauth managed provider id"
```

## Task 3: Add `codex_oauth` Secret and Token Broker Support

**Files:**
- Modify: `services/den/src/managed-ai/credentials/secret-store.ts`
- Modify: `services/den/src/managed-ai/credentials/default-token-broker.ts`
- Modify: `services/den/src/managed-ai/runtime/default-runtime.ts`
- Test: `services/den/test/managed-ai-token-broker.test.ts`

**Step 1: Write failing token broker tests**

Add tests in `services/den/test/managed-ai-token-broker.test.ts`:

```ts
test("returns live codex oauth access tokens before proxying", async () => {
  const secretStore = new EncryptedSecretStore("test_secret_key_32_bytes_minimum____", {
    secret_1: {
      kind: "codex_oauth",
      accessToken: "codex_access",
      refreshToken: "codex_refresh",
      expiresAt: "2026-04-01T13:00:00.000Z",
    },
  })
  const credentials = new InMemoryCredentialRepository(
    new Map([
      [
        "binding_codex",
        createCredentialRecord({
          provider: "codex_oauth",
          credentialType: "oauth",
        }),
      ],
    ]),
  )

  const broker = new DefaultTokenBroker({
    credentials,
    secrets: secretStore,
    now: () => new Date("2026-04-01T12:00:00.000Z"),
  })

  assert.deepEqual(await broker.getUpstreamAuth({ bindingId: "binding_codex" }), {
    kind: "oauth",
    value: "codex_access",
  })
})
```

Add a second test proving expired `codex_oauth` uses `refreshCodexOAuth` and stores the refreshed secret.

**Step 2: Run the test to verify failure**

Run: `pnpm --dir services/den exec tsx --test test/managed-ai-token-broker.test.ts`

Expected: FAIL because `codex_oauth` is not a valid stored secret kind.

**Step 3: Extend stored secret types**

Modify `services/den/src/managed-ai/credentials/secret-store.ts`:

```ts
export type StoredSecret =
  | { kind: "api_key"; apiKey: string }
  | { kind: "openai_oauth"; accessToken: string; refreshToken: string; expiresAt: string }
  | { kind: "codex_oauth"; accessToken: string; refreshToken: string; expiresAt: string }
```

**Step 4: Extend token broker refresh**

Modify `services/den/src/managed-ai/credentials/default-token-broker.ts`:

- Add a `CodexOAuthSecret` type.
- Add `refreshCodexOAuth?: (input) => Promise<CodexOAuthSecret>` to `DefaultTokenBrokerDeps`.
- Route `secret.kind === "codex_oauth"` through `refreshCodexOAuth`.
- Keep `openai_oauth` behavior unchanged.

**Step 5: Wire default runtime**

Modify `services/den/src/managed-ai/runtime/default-runtime.ts` so `refreshCodexOAuth` uses the same OAuth client initially:

```ts
refreshCodexOAuth: async ({ secret }) => ({
  kind: "codex_oauth",
  ...(await openAiOAuth.refreshToken({ refreshToken: secret.refreshToken })),
}),
```

**Step 6: Run focused tests**

Run: `pnpm --dir services/den exec tsx --test test/managed-ai-token-broker.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add services/den/src/managed-ai/credentials/secret-store.ts services/den/src/managed-ai/credentials/default-token-broker.ts services/den/src/managed-ai/runtime/default-runtime.ts services/den/test/managed-ai-token-broker.test.ts
git commit -m "feat: support codex oauth secrets"
```

## Task 4: Add DEN Admin Codex OAuth Credential Routes

**Files:**
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Test: `services/den/test/admin-managed-ai-openai-oauth.test.ts`

**Step 1: Write failing route tests**

Add tests to `services/den/test/admin-managed-ai-openai-oauth.test.ts` or split into `services/den/test/admin-managed-ai-codex-oauth.test.ts`:

```ts
test("POST /admin/api/credentials/codex/oauth/exchange persists the platform Codex OAuth credential", async () => {
  // Mirror the existing OpenAI OAuth exchange test, but assert:
  // secret.kind === "codex_oauth"
  // ownerUserId === "platform:codex_oauth"
  // provider === "codex_oauth"
  // credentialType === "oauth"
  // name === "Shared Codex OAuth"
  // audit action === "credential.codex_oauth.connect"
})
```

**Step 2: Run the test to verify failure**

Run: `pnpm --dir services/den exec tsx --test test/admin-managed-ai-openai-oauth.test.ts`

Expected: FAIL with 404 for `/credentials/codex/oauth/start` or `/exchange`.

**Step 3: Add routes**

Modify `createManagedAiAdminUiRouter` in `services/den/src/managed-ai/http/admin.ts`:

- Add `POST /admin/api/credentials/codex/oauth/start`.
- Add `POST /admin/api/credentials/codex/oauth/exchange`.
- Reuse signed state helpers, but use Codex-specific storage/action names.
- Store:

```ts
await deps.secrets.put({
  kind: "codex_oauth",
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken,
  expiresAt: tokens.expiresAt,
})
```

- Create platform credential:

```ts
{
  ownerUserId: getPlatformCredentialOwnerUserId("codex_oauth"),
  name: "Shared Codex OAuth",
  provider: "codex_oauth",
  credentialType: "oauth",
  secretRef: stored.secretRef,
}
```

**Step 4: Run focused tests**

Run: `pnpm --dir services/den exec tsx --test test/admin-managed-ai-openai-oauth.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/managed-ai/http/admin.ts services/den/test/admin-managed-ai-openai-oauth.test.ts
git commit -m "feat: add codex oauth admin credential flow"
```

## Task 5: Add Codex Runtime Transport and Proxy Route

**Files:**
- Create: `services/den/src/managed-ai/providers/codex-oauth-transport.ts`
- Create: `services/den/src/managed-ai/http/providers/codex-oauth.ts`
- Modify: `services/den/src/managed-ai/providers/transport.ts`
- Modify: `services/den/src/managed-ai/http/proxy.ts`
- Modify: `services/den/src/managed-ai/runtime/default-runtime.ts`
- Test: `services/den/test/managed-ai-codex-oauth-proxy.test.ts`

**Step 1: Write failing proxy tests**

Create `services/den/test/managed-ai-codex-oauth-proxy.test.ts` with a fake Codex transport:

```ts
test("POST /providers/codex_oauth/v1/chat/completions forwards with sticky codex oauth lease", async () => {
  // Build the same app shape as existing managed-ai proxy tests.
  // Assert:
  // - request requires bearer gateway auth
  // - x-veslo-session-id is required
  // - lease scope provider is "codex_oauth"
  // - binding owner is "platform:codex_oauth"
  // - fake transport receives upstreamAuth.value === "codex_access"
  // - response body is forwarded to the caller
  // - usage provider is "codex_oauth"
})
```

Use `services/den/test/managed-ai-proxy-usage.test.ts` and `services/den/test/managed-ai-proxy-auth.test.ts` as the structural reference.

**Step 2: Run the test to verify failure**

Run: `pnpm --dir services/den exec tsx --test test/managed-ai-codex-oauth-proxy.test.ts`

Expected: FAIL because the route and transport do not exist.

**Step 3: Add transport interface**

Modify `services/den/src/managed-ai/providers/transport.ts`:

```ts
export type CodexChatCompletionsTransportInput = {
  upstreamAuth: UpstreamAuth
  body: unknown
}

export interface CodexOAuthProviderTransport {
  chatCompletions(input: CodexChatCompletionsTransportInput): Promise<ProviderTransportResponse>
}
```

**Step 4: Add HTTP transport**

Create `services/den/src/managed-ai/providers/codex-oauth-transport.ts`:

```ts
import {
  headersToRecord,
  ProviderTransportError,
  readProviderResponseBody,
  type CodexChatCompletionsTransportInput,
  type CodexOAuthProviderTransport,
  type ProviderTransportResponse,
} from "./transport.js"

export class CodexOAuthTransport implements CodexOAuthProviderTransport {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(deps: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = (deps.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "")
    this.fetchImpl = deps.fetchImpl ?? fetch
  }

  async chatCompletions(input: CodexChatCompletionsTransportInput): Promise<ProviderTransportResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.upstreamAuth.value}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
    })

    const body = await readProviderResponseBody(response)
    const headers = headersToRecord(response.headers)
    if (!response.ok) {
      throw new ProviderTransportError(`codex_oauth_upstream_${response.status}`, {
        statusCode: response.status,
        body,
        headers,
      })
    }
    return { status: response.status, body, headers }
  }
}
```

If Task 1 proved direct HTTP is not viable, replace this with a fail-fast transport and stop for a CLI-worker-specific plan before continuing.

**Step 5: Add proxy route**

Create `services/den/src/managed-ai/http/providers/codex-oauth.ts` by copying the OpenAI route shape and changing:

- route provider: `codex_oauth`
- binding owner: `getPlatformCredentialOwnerUserId("codex_oauth")`
- transport: `deps.codexOAuthTransport.chatCompletions`
- usage provider: `codex_oauth`
- request id prefix: `codex_oauth_req_`

Modify `services/den/src/managed-ai/http/proxy.ts`:

```ts
router.use("/providers/codex_oauth", createCodexOAuthProxyRouter(deps))
```

**Step 6: Wire runtime dependencies**

Modify `services/den/src/managed-ai/runtime/default-runtime.ts` to add `codexOAuthTransport` to `ProxyDependencies` and instantiate `new CodexOAuthTransport(...)`.

**Step 7: Run focused tests**

Run: `pnpm --dir services/den exec tsx --test test/managed-ai-codex-oauth-proxy.test.ts`

Expected: PASS.

**Step 8: Commit**

```bash
git add services/den/src/managed-ai/providers/transport.ts services/den/src/managed-ai/providers/codex-oauth-transport.ts services/den/src/managed-ai/http/providers/codex-oauth.ts services/den/src/managed-ai/http/proxy.ts services/den/src/managed-ai/runtime/default-runtime.ts services/den/test/managed-ai-codex-oauth-proxy.test.ts
git commit -m "feat: proxy codex oauth provider requests"
```

## Task 6: Update Veslo Desktop Provider Routing

**Files:**
- Modify: `packages/app/src/app/utils/providers.ts`
- Modify: `packages/app/src/app/lib/ai-access.ts`
- Modify: `packages/app/src/app/lib/opencode.ts`
- Test: `packages/app/src/app/utils/providers.test.ts`
- Test: `packages/app/src/app/lib/ai-access.test.ts`
- Test: `packages/app/src/app/lib/provider-routing.test.ts`

**Step 1: Write failing app tests**

Add to `packages/app/src/app/utils/providers.test.ts`:

```ts
test("identifies codex oauth as gateway-owned provider", () => {
  assert.equal(isGatewayOwnedProvider("codex_oauth"), true)
})
```

Add to `packages/app/src/app/lib/ai-access.test.ts` a `codex_oauth` managed access case:

```ts
test("formatManagedAiAccessConfig routes codex oauth through the gateway", () => {
  const content = formatManagedAiAccessConfig("{}", {
    profile: {
      userId: "user_123",
      providerId: "codex_oauth",
      defaultModel: { providerID: "codex_oauth", modelID: "gpt-5.4" },
      allowedModels: ["gpt-5.4"],
      updatedAt: null,
    },
    serverBaseUrl: "https://veslo.example.test",
    gatewayAccessToken: "den_token_123",
  })
  const parsed = JSON.parse(content)
  assert.equal(parsed.model, "codex_oauth/gpt-5.4")
  assert.equal(parsed.provider.codex_oauth.options.baseURL, "https://veslo.example.test/ai-gateway/providers/codex_oauth/v1")
})
```

**Step 2: Run focused app tests to verify failure**

Run: `pnpm --dir packages/app test -- app/utils/providers.test.ts app/lib/ai-access.test.ts app/lib/provider-routing.test.ts`

If the app package uses a different focused test script, use the existing package test convention from `packages/app/package.json`.

Expected: FAIL because `codex_oauth` is not gateway-owned yet.

**Step 3: Update provider utilities**

Modify `packages/app/src/app/utils/providers.ts`:

```ts
export const GATEWAY_OWNED_PROVIDER_IDS = ["openai", "anthropic", "codex_oauth"] as const;
```

Consider changing `isGatewayOAuthProvider` to return true for `openai` and `codex_oauth` only if it is still used in a UI path.

**Step 4: Verify `applyGatewayProviderRouting` works unchanged**

No route-specific code should be required in `packages/app/src/app/lib/opencode.ts` because the base URL is already built from `providerId`. Only adjust tests/types if TypeScript requires it.

**Step 5: Run focused app tests**

Run: `pnpm --dir packages/app test -- app/utils/providers.test.ts app/lib/ai-access.test.ts app/lib/provider-routing.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/utils/providers.ts packages/app/src/app/lib/ai-access.ts packages/app/src/app/lib/opencode.ts packages/app/src/app/utils/providers.test.ts packages/app/src/app/lib/ai-access.test.ts packages/app/src/app/lib/provider-routing.test.ts
git commit -m "feat: route codex oauth provider from desktop"
```

## Task 7: Update DEN Admin UI Copy and Controls

**Files:**
- Modify: `services/den/public-admin/index.html`
- Modify: `services/den/public-admin/app.js`
- Test: `services/den/test/admin-managed-ai-ui.test.ts`

**Step 1: Write failing UI shell tests**

Modify `services/den/test/admin-managed-ai-ui.test.ts`:

- Replace expectations for Anthropic key controls with Codex OAuth controls.
- Assert that `GET /admin/credentials` contains `credential-codex-connect`.
- Assert that `GET /admin/app.js` contains `/credentials/codex/oauth/start` and `/credentials/codex/oauth/exchange`.
- Assert the user AI access provider select contains `codex_oauth`.

**Step 2: Run the UI test to verify failure**

Run: `pnpm --dir services/den exec tsx --test test/admin-managed-ai-ui.test.ts`

Expected: FAIL because UI still references OpenAI OAuth and Anthropic key as the primary flow.

**Step 3: Update HTML**

Modify `services/den/public-admin/index.html`:

- Change platform credential headline to `Connect Codex / ChatGPT OAuth`.
- Add a button with `id="credential-codex-connect"`.
- Add status text with `id="credential-codex-status"`.
- Keep legacy OpenAI/Anthropic controls only if explicitly labeled as fallback/legacy, or hide them from the primary flow.
- Add `<option value="codex_oauth">Codex OAuth</option>` to `#user-ai-access-provider`.

**Step 4: Update admin JS**

Modify `services/den/public-admin/app.js`:

- Add `CODEX_OAUTH_STORAGE_KEY`.
- Add `credentialCodexConnect` and `credentialCodexStatus` element references.
- Add `readPendingCodexOAuth`, `writePendingCodexOAuth`, and `clearPendingCodexOAuth` based on the existing OpenAI helpers.
- Add `isCodexOAuthCallback()` for `/admin/oauth/codex/callback`.
- Add `connectCodexCredential()` using `/credentials/codex/oauth/start`.
- Add `finishCodexOAuth()` using `/credentials/codex/oauth/exchange`.
- Update credential summary to look for `entry.provider === "codex_oauth" && entry.type === "oauth"`.

**Step 5: Run focused UI tests**

Run: `pnpm --dir services/den exec tsx --test test/admin-managed-ai-ui.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/public-admin/index.html services/den/public-admin/app.js services/den/test/admin-managed-ai-ui.test.ts
git commit -m "feat: add codex oauth admin controls"
```

## Task 8: Full Verification and Live Gate

**Files:**
- No planned code edits.

**Step 1: Run DEN focused tests**

Run: `pnpm --dir services/den test`

Expected: all DEN tests pass.

**Step 2: Build DEN**

Run: `pnpm --dir services/den build`

Expected: TypeScript build exits 0.

**Step 3: Run app focused tests**

Run the focused app tests from Task 6 using the actual `packages/app` script.

Expected: all focused tests pass.

**Step 4: Run desktop E2E only if launching Veslo**

If this work changes desktop runtime behavior and you need to launch/test Veslo internally, follow AGENTS.md:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
cd ../e2e
pnpm test --spec ./specs/admin-managed-ai-access.spec.ts
```

Do not run the Next.js web app.

**Step 5: Run live Render gate**

After deployment, verify:

- Admin can connect a Codex OAuth credential.
- Credential appears in `/admin/credentials` as `codex_oauth`.
- User can be assigned provider `codex_oauth` and a Codex-runtime model.
- Veslo desktop config routes the provider to `/ai-gateway/providers/codex_oauth/v1`.
- A prompt returns a model response through OpenCode.
- Usage is recorded under provider `codex_oauth`.

**Step 6: Commit any final test/doc fixes**

```bash
git status --short
git add <only-files-you-changed>
git commit -m "test: verify codex oauth managed ai"
```
