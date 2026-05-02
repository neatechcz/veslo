# VSLO-143 Admin-Managed OpenAI-Compatible Provider Design

## Context

VSLO-143 asks Veslo Inference to support adding a custom API provider and model. The provider must be OpenAI-compatible, support a custom API/base URL, model ID, and credential, and preserve the existing OpenAI and Codex provider behavior.

The product decision for this work is that custom providers remain admin-managed through DEN / Managed AI Gateway. This must not reintroduce user-managed BYOK controls in the desktop app. The desktop app should continue to receive a read-only managed-AI assignment and write only the local OpenCode routing config needed to send traffic through the local Veslo server and DEN.

## Decision

Add a new managed provider type: `openai_compatible`.

Do not overload the existing `openai` provider. The current `openai` provider represents the platform OpenAI pool and managed OpenAI route. A custom provider has its own upstream base URL and credential, so it needs its own managed provider identity to keep leases, usage, assignment, and error reporting predictable.

Dynamic provider IDs such as `custom_openrouter` or `custom_deepinfra` are also out of scope for this phase. Provider IDs are currently static across DEN policy, credential pools, lease records, app-side config generation, and local server routes. A single static `openai_compatible` provider satisfies this ticket with much lower blast radius.

## User Experience

Admins can create an OpenAI-compatible credential in the DEN admin Credentials page with:

- display name
- base URL
- API key

Admins assign users in the DEN admin Users page with:

- provider: `openai_compatible`
- assigned credential
- default model ID
- optional allowed model IDs

End users see the assigned provider and model in the desktop Settings AI access summary. They do not see or edit the API key or base URL.

## Data Model

Extend the managed-AI provider set with `openai_compatible`.

Store custom provider connection material in the encrypted secret store. Add a new stored secret shape:

```ts
{
  kind: "openai_compatible_api_key";
  apiKey: string;
  baseUrl: string;
}
```

Keep the existing credential record table unchanged if possible:

- `provider = "openai_compatible"`
- `credential_type = "api_key"`
- `owner_user_id = "platform:openai_compatible"`
- `secret_ref` points to the encrypted custom-provider secret

Require `credentialId` for `openai_compatible` user assignments, the same way Codex assignments require a credential. The credential determines the upstream base URL, so automatic selection from a mixed URL pool would be surprising.

## Runtime Flow

1. DEN returns the managed-AI policy for the signed-in user:
   - `provider: "openai_compatible"`
   - `credentialId`
   - `defaultModel`
   - `allowedModels`
2. The desktop app formats OpenCode config with provider `openai_compatible`.
3. The generated OpenCode provider uses `@ai-sdk/openai-compatible`.
4. The generated provider base URL points at the local Veslo server route:
   - `/ai-gateway/providers/openai_compatible/v1`
5. The local Veslo server proxies:
   - `/ai-gateway/providers/openai_compatible/v1/chat/completions`
   to DEN:
   - `/providers/openai_compatible/v1/chat/completions`
6. DEN enforces AI access policy and model allow-list.
7. DEN resolves the assigned credential, decrypts the base URL and API key, and calls:
   - `${baseUrl}/chat/completions`
8. DEN records usage against provider `openai_compatible`, the credential, binding, user, session, and model.

## Validation

Admin credential creation validates:

- base URL is present
- API key is present
- base URL is an HTTP(S) URL
- hosted/prod environments require HTTPS
- localhost HTTP is allowed for local development and tests

User AI access assignment validates:

- provider is a supported managed provider
- `credentialId` is required for `openai_compatible`
- `defaultModel` is required when access is enabled
- `defaultModel` is included in `allowedModels` when `allowedModels` is non-empty
- assigned credential exists, is healthy, and has provider `openai_compatible`

Runtime validation preserves explicit failures:

- wrong provider route: `provider_not_assigned`
- disallowed model: `model_not_allowed`
- missing assigned credential: `assigned_credential_unavailable`
- invalid stored custom provider config: `invalid_custom_provider_config`
- upstream failure: return provider status/body where safe, otherwise `proxy_request_failed`

## Compatibility

Existing managed providers remain isolated:

- `openai` still routes to the platform OpenAI pool.
- `anthropic` still routes to the platform Anthropic pool.
- `codex_oauth` still uses the server-side Codex worker and assigned credential behavior.

The desktop app must keep existing OpenAI and Codex config generation behavior unchanged. `openai_compatible` adds a fourth gateway-owned provider, not a replacement for existing providers.

## Testing

Add focused coverage for:

- DEN provider enum accepts `openai_compatible`.
- Admin can create an OpenAI-compatible credential with base URL and API key.
- Admin credential validation rejects missing base URL, missing key, invalid URL, and disallowed HTTP URL.
- User AI access assignment requires an assigned OpenAI-compatible credential.
- OpenAI-compatible proxy enforces provider/model policy.
- OpenAI-compatible proxy calls the stored base URL with bearer API key.
- Usage is recorded under provider `openai_compatible`.
- App config generation emits an OpenAI-compatible provider using the local gateway route.
- Local Veslo server proxies the new route to DEN.
- Existing OpenAI provider routing still passes.
- Existing Codex OAuth provider routing still passes.

Desktop verification should include a Tauri runtime smoke test or live E2E path that sends a prompt through an assigned `openai_compatible` credential, plus regression checks for OpenAI and Codex.

## Non-Goals

- General support for arbitrary non-OpenAI inference protocols.
- User-managed BYOK provider setup in the desktop app.
- Dynamic provider IDs in this phase.
- Model discovery from `/models` in this phase. Admin-entered model IDs are sufficient for VSLO-143.
