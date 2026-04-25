# Codex OAuth DEN Provider Design

**Date:** 2026-04-13
**Status:** Revised after live direct-HTTP compatibility gate
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

Add a new DEN-managed pseudo-provider named `codex_oauth`, backed by a DEN-hosted Codex CLI worker adapter.

The pseudo-provider represents:

- one or more shared Codex/ChatGPT OAuth credentials stored server-side
- the DEN-hosted execution adapter that turns OpenCode-compatible requests into Codex-runtime calls
- the model catalog that the Codex runtime can actually access

This replaces API-key-first routing for the managed AI path. Existing `openai` and `anthropic` API-key credential support can remain as legacy/fallback code, but the new product path should prefer `codex_oauth` and should not require platform admins to create OpenAI or Anthropic API-key credentials.

The direct bearer-token HTTP path is not selected. On 2026-04-13, the live gate sent the local Codex/ChatGPT OAuth access token to `https://api.openai.com/v1/chat/completions` and received HTTP 429 `insufficient_quota`. That proves this path behaves like the normal OpenAI Platform API billing/quota surface for our purpose, not like a subscription-backed Codex runtime. DEN must therefore run Codex as a controlled runtime/CLI worker instead of treating the Codex token as a raw provider API key.

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
7. DEN executes the prompt through the Codex CLI worker adapter using a server-side Codex/ChatGPT login profile.
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
  -> Codex CLI worker adapter
  -> OpenCode-compatible response
```

The adapter must be isolated behind an interface so the gateway route can be tested with a fake worker and the live worker can be gated independently.

Selected worker behavior:

- Spawn `codex exec` non-interactively, not the interactive TUI.
- Use an isolated `CODEX_HOME` for the worker so DEN does not read or mutate a developer's local Codex login by accident.
- Use `--cd` to point Codex at an isolated scratch workspace, not the DEN source tree.
- Use `--sandbox read-only` and `--ask-for-approval never` for the default prompt-answering path.
- Use `--output-last-message` to capture the final assistant answer without parsing terminal UI text.
- Enforce a timeout and kill the child process on overrun.
- Convert OpenAI-compatible chat completion requests into a single Codex prompt.
- Convert the worker's final answer back into an OpenAI-compatible non-streaming chat completion response for OpenCode.
- Return a clear unsupported error for streaming until streaming is implemented deliberately.

The first worker implementation task must be a live CLI compatibility gate. If `codex exec` cannot answer a minimal prompt from the intended server environment, do not continue to UI polish; fix the worker environment first.

## Credential Model

For the first production-safe version, `codex_oauth` should represent a server-side Codex runtime profile rather than a raw upstream API bearer token.

MVP behavior:

- The worker is provisioned with a pre-authenticated `CODEX_HOME` or equivalent secure secret mount.
- Admin credentials store metadata, health, ownership, and assignment state for `codex_oauth`.
- The raw Codex refresh/access token is never returned to Veslo desktop and is never logged.
- A later hardening task can add first-class admin OAuth materialization into the worker auth store, but only after proving the Codex CLI auth cache contract is stable enough for server-side use.

This keeps the mental model clean: DEN/admin owns the Codex login and routes prompts; Veslo and local OpenCode only hold the DEN gateway token.

## Model Catalog

The model list shown in admin should come from the Codex runtime capability set, not from hardcoded OpenAI/Anthropic provider lists.

Rules:

- If the Codex runtime can access a model, it can be listed.
- If the Codex runtime cannot access a model, it must not be shown as assignable.
- Model ids should be stored as opaque runtime model ids.
- Provider labels in the UI are display metadata only in this mode.
- Until live model discovery is implemented, the admin UI should gate model choices behind a small configured allowlist and mark it as runtime-backed, not provider-API-backed.

## Security Rules

- Never send the Codex/ChatGPT OAuth access token or refresh token to the Veslo desktop app.
- Never store raw provider credentials in OpenCode config on the client.
- Encrypt the Codex OAuth credential with the existing managed-AI secret store.
- Preserve the current gateway token boundary between OpenCode and DEN.
- Keep session leases sticky so one session does not jump between credentials unless failover is required.
- Log credential health and usage without logging raw prompts or secrets.
- Treat any DEN-hosted Codex runtime as privileged infrastructure, not as a public arbitrary-code execution endpoint.
- Run Codex workers in isolated scratch directories and avoid granting repository write access for normal prompt-answering.
- Never expose a generic arbitrary CLI execution endpoint in the admin API.

## Failure Behavior

Expected failures should map to user/admin-readable states:

- Missing user AI access: return a policy error.
- No healthy `codex_oauth` credential: return a managed credential error.
- Missing or unhealthy Codex worker profile: return a managed credential/runtime error.
- Expired Codex login: mark the credential unhealthy and tell the admin to reconnect or re-provision the worker profile.
- Permanent OAuth failure: mark the credential unhealthy and alert admin.
- Model not available in Codex runtime catalog: return a model-not-allowed/model-unavailable error.
- Codex runtime unavailable or timed out: return a provider runtime error and record an alert.

## Compatibility With Current Code

Current useful pieces:

- OpenCode provider routing already injects `x-veslo-gateway-token` and `x-veslo-session-id`.
- DEN managed AI already has gateway session validation, user AI access policy, leases, usage, health, alerts, and admin credential pages.
- DEN already has credential, lease, usage, health, alerts, and admin UI primitives that can represent `codex_oauth`.

Expected changes:

- Add `codex_oauth` as a provider/assignment concept.
- Add a Codex CLI worker adapter behind the managed-AI provider transport boundary.
- Add admin UI copy and controls for "Connect Codex / ChatGPT OAuth".
- Change managed provider assignment to prefer `codex_oauth`.
- Add tests that prove OpenCode receives only gateway tokens, while DEN owns the Codex credential.

## Open Questions For Implementation

- Can Render reliably host the Codex CLI worker path, or does this require a separate worker service with persistent storage?
- Should the first live environment use Render persistent disk, a separately deployed worker, or a manually provisioned `CODEX_HOME` secret mount?
- Is Codex CLI `--output-last-message` sufficient for the response path, or do we need `--json` event parsing for richer metadata and streaming later?
- How should the Codex runtime model catalog be discovered and refreshed?

These questions should be answered by a live compatibility gate before broad UI or data-model changes.
