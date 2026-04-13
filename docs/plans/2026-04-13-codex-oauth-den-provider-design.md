# Codex OAuth DEN Provider Design

**Date:** 2026-04-13
**Status:** Approved for implementation planning
**Branch:** codex/ai-gateway-auth-migration

## Goal

Move hosted managed-AI execution to a DEN-owned Codex/ChatGPT OAuth credential model.

The intended product behavior is:

- Veslo desktop still sends prompts to the local OpenCode runtime.
- OpenCode is configured with a Veslo/DEN gateway provider endpoint and a Veslo-generated gateway token.
- OpenCode sends provider-compatible requests to DEN/Render, not directly to OpenAI, Anthropic, or other provider APIs.
- DEN/admin owns the Codex/ChatGPT OAuth credential and returns the model response to OpenCode.
- The user does not configure OpenAI API keys, Anthropic API keys, or other provider API keys in the Veslo app.

## Non-Goal

This is not a universal OAuth-token bridge for every upstream provider API.

A Codex/ChatGPT OAuth credential is the credential for the Codex/OpenAI runtime path. It is not an Anthropic API credential and should not be sent to Anthropic as if it were an Anthropic bearer token. If Anthropic or another provider appears in this mode, it must appear because the DEN-hosted Codex runtime can access that model/provider through its own Codex session, not because DEN is calling the raw Anthropic API with the Codex token.

## Selected Approach

Add a new DEN-managed pseudo-provider named `codex_oauth`.

The pseudo-provider represents:

- one or more shared Codex/ChatGPT OAuth credentials stored server-side
- the DEN-hosted execution adapter that turns OpenCode-compatible requests into Codex-runtime calls
- the model catalog that the Codex runtime can actually access

This replaces API-key-first routing for the managed AI path. Existing `openai` and `anthropic` API-key credential support can remain as legacy/fallback code, but the new product path should prefer `codex_oauth` and should not require platform admins to create OpenAI or Anthropic API-key credentials.

## Data Flow

1. The Veslo app signs in to DEN and receives a Veslo/DEN gateway token.
2. Veslo configures local OpenCode provider settings so the selected managed provider points to the DEN gateway endpoint.
3. OpenCode sends the prompt to DEN with:
   - gateway token
   - Veslo/OpenCode session id
   - selected model
   - provider-compatible request body
4. DEN validates the gateway token and resolves the Veslo user.
5. DEN applies the user AI access policy from admin.
6. DEN resolves a sticky session lease for the `codex_oauth` credential.
7. DEN executes the prompt through the Codex-runtime adapter using the server-side Codex/ChatGPT OAuth credential.
8. DEN returns an OpenCode-compatible response payload.
9. DEN records usage, credential health, audit, and alerts under the `codex_oauth` credential.

## Admin UI

The admin UI should expose a clear managed-AI setup:

- Credentials page:
  - Add a "Connect Codex / ChatGPT OAuth" action.
  - Store the resulting credential as type `codex_oauth`.
  - Show health, active sessions, alerts, and last failure for the credential.
- Users page:
  - Allow assigning managed AI access to `codex_oauth`.
  - Allow selecting a default model from the discovered Codex runtime model catalog.
  - Allow optional per-user allowed model restrictions.
- Sessions and Usage pages:
  - Attribute usage to provider `codex_oauth`, model, user, session, and credential.

The UI should avoid implying that Anthropic/OpenAI API keys are required for this mode.

## Execution Adapter

The implementation needs one adapter boundary:

```text
OpenCode-compatible request
  -> DEN gateway policy/lease/token broker
  -> Codex runtime adapter
  -> OpenCode-compatible response
```

The adapter must be isolated behind an interface so we can validate the exact Codex execution mechanism before committing the rest of the gateway to one transport.

Candidate adapter implementations:

- Direct Codex/OpenAI OAuth-backed HTTP path, if the OAuth token is accepted by a supported runtime endpoint for the required request shape.
- DEN-hosted Codex CLI worker path, where Render runs a controlled Codex runtime session logged in through the admin OAuth credential.

The first implementation task must be a live compatibility gate. If a direct OAuth-backed HTTP call is not supported, the implementation should not try to fake Anthropic/OpenAI API auth with that token. It should use the Codex runtime adapter path or stop with a clear unsupported-state error.

## Model Catalog

The model list shown in admin should come from the Codex runtime capability set, not from hardcoded OpenAI/Anthropic provider lists.

Rules:

- If the Codex runtime can access a model, it can be listed.
- If the Codex runtime cannot access a model, it must not be shown as assignable.
- Model ids should be stored as opaque runtime model ids.
- Provider labels in the UI are display metadata only in this mode.

## Security Rules

- Never send the Codex/ChatGPT OAuth access token or refresh token to the Veslo desktop app.
- Never store raw provider credentials in OpenCode config on the client.
- Encrypt the Codex OAuth credential with the existing managed-AI secret store.
- Preserve the current gateway token boundary between OpenCode and DEN.
- Keep session leases sticky so one session does not jump between credentials unless failover is required.
- Log credential health and usage without logging raw prompts or secrets.
- Treat any DEN-hosted Codex runtime as privileged infrastructure, not as a public arbitrary-code execution endpoint.

## Failure Behavior

Expected failures should map to user/admin-readable states:

- Missing user AI access: return a policy error.
- No healthy `codex_oauth` credential: return a managed credential error.
- Expired OAuth access token with valid refresh token: refresh server-side and retry.
- Permanent OAuth failure: mark the credential unhealthy and alert admin.
- Model not available in Codex runtime catalog: return a model-not-allowed/model-unavailable error.
- Codex runtime unavailable or timed out: return a provider runtime error and record an alert.

## Compatibility With Current Code

Current useful pieces:

- OpenCode provider routing already injects `x-veslo-gateway-token` and `x-veslo-session-id`.
- DEN managed AI already has gateway session validation, user AI access policy, leases, usage, health, alerts, and admin credential pages.
- DEN already has an OpenAI OAuth-shaped credential flow that can be adapted into a `codex_oauth` credential flow if the token exchange is the same.

Expected changes:

- Add `codex_oauth` as a credential/secret/provider concept.
- Add a Codex runtime adapter behind the managed-AI provider transport boundary.
- Add admin UI copy and controls for "Connect Codex / ChatGPT OAuth".
- Change managed provider assignment to prefer `codex_oauth`.
- Add tests that prove OpenCode receives only gateway tokens, while DEN owns the Codex credential.

## Open Questions For Implementation

- Which exact runtime call should the first adapter use: direct OAuth-backed HTTP or Codex CLI worker?
- Does the existing OpenAI OAuth admin flow produce the same token class required by Codex runtime execution?
- Can Render reliably host the Codex runtime path, or does this require a separate worker service with persistent storage?
- How should the Codex runtime model catalog be discovered and refreshed?

These questions should be answered by a live compatibility gate before broad UI or data-model changes.
