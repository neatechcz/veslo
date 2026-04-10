# DEN-Owned Managed AI Routing Design

**Date:** 2026-04-10  
**Status:** Approved  
**Branch:** `codex/ai-gateway-auth-migration`

## Goal

Make DEN the single hosted control plane and data plane for managed AI. The admin UI should own provider credential setup and per-user provider assignment, and prompt routing should be decided and executed by DEN instead of a separately-deployed `ai-gateway` service.

## Scope

Phase 1 covers only admin-managed hosted AI for:

- OpenAI via admin-side OAuth
- Anthropic via admin-side shared API key

This phase intentionally does not add support for arbitrary OpenCode providers. It also does not require an immediate database consolidation. The product mental model changes now; internal storage consolidation can happen later.

## Decisions

- DEN becomes the only hosted service the product needs to explain for managed AI.
- The separate `services/ai-gateway` deployment is removed from the product mental model.
- The current `ai-gateway` runtime logic is reused inside DEN where practical rather than rewritten from scratch.
- Desktop keeps using local `veslo-server` and OpenCode as compatibility layers in phase 1.
- Managed prompts will depend on the hosted DEN service being reachable. Offline/local-only managed prompting is not part of this design.
- Supported managed providers in phase 1 are `openai` and `anthropic`.

## Current Baseline

Today the managed flow is split across three layers:

1. The Veslo app reads the signed-in user's DEN auth and asks for managed AI access.
2. The app rewrites OpenCode provider config so OpenCode sends provider calls through local `veslo-server` compatibility routes.
3. `veslo-server` forwards those managed AI requests to a separate AI gateway service.
4. The AI gateway resolves the DEN token back to a user, applies the provider/model policy, and forwards the request upstream.

This already gives the desired functional behavior for OpenAI and Anthropic, but not the desired mental model. It also leaves the hosted admin UI behind the repo and leaves OpenAI admin credential setup as a secret-entry flow instead of a proper admin OAuth connect flow.

## Chosen Architecture

### Product boundary

From the product point of view, DEN owns:

- admin UI
- provider credential setup
- user AI access policy
- provider/model enforcement
- upstream provider routing
- usage and audit visibility

The user and admin should think of this as one hosted system:

- admins configure users and providers in DEN/admin
- Veslo asks DEN what the user is allowed to use
- DEN routes prompts to the assigned provider

### Runtime boundary

OpenCode remains:

- the session and tool engine
- the holder of model identifiers in workspace config
- the thing the user interacts with through the Veslo desktop app

`veslo-server` remains:

- the local bridge between desktop and hosted services
- the compatibility surface that OpenCode already talks to

DEN becomes:

- the hosted managed-AI brain
- the owner of all provider-routing decisions

### Internal implementation boundary

Phase 1 should not rewrite the provider runtime from first principles. Instead, DEN should absorb the working AI gateway logic:

- user AI access repository and validation
- platform credential repository and secret storage
- OpenAI OAuth client and refresh handling
- Anthropic API key handling
- sticky lease selection and rebinding
- OpenAI and Anthropic provider transports
- usage and audit recording

The code can move into DEN-owned modules or be embedded as DEN-owned runtime code, but the external service boundary becomes DEN.

## Request Flow

### Admin setup

For OpenAI:

1. Admin opens the hosted DEN admin UI.
2. Admin clicks a `Connect OpenAI` action.
3. DEN starts the OpenAI OAuth flow.
4. OpenAI redirects back to DEN.
5. DEN exchanges the code and stores the platform-owned OpenAI credential.
6. DEN refreshes and monitors that credential as needed.

For Anthropic:

1. Admin opens the hosted DEN admin UI.
2. Admin pastes the shared Anthropic API key.
3. DEN stores it as a platform-owned Anthropic credential.

For user assignment:

1. Admin opens a user in `Users`.
2. Admin enables managed AI access.
3. Admin chooses `openai` or `anthropic`.
4. Admin sets the default model and allowed models.

### Prompt flow

1. User signs in to Veslo and receives a DEN token.
2. Veslo asks DEN for the user's managed AI access policy.
3. If managed access is enabled, Veslo rewrites OpenCode config so OpenCode sends managed-provider calls through the local compatibility path.
4. OpenCode sends the prompt to local `veslo-server`.
5. Local `veslo-server` forwards the request to hosted DEN.
6. DEN:
   - authenticates the DEN token
   - resolves the user
   - loads the assigned provider/model policy
   - validates provider and model
   - picks the active platform credential lease
   - refreshes OpenAI OAuth if needed
   - forwards to OpenAI or Anthropic
   - records usage and audit data
   - returns the provider response
7. The response returns through `veslo-server` to OpenCode and then to the user.

## Compatibility Strategy

Phase 1 should preserve the local desktop plumbing:

- keep the local `/ai-gateway/me/ai-access` compatibility path
- keep the local `/ai-gateway/providers/openai/...` compatibility path
- keep the local `/ai-gateway/providers/anthropic/...` compatibility path

The important change is upstream ownership:

- local `veslo-server` should forward those compatibility routes to DEN-owned hosted endpoints
- the desktop app should no longer need a separate AI gateway deployment target

This reduces rollout risk because the desktop app and OpenCode integration can keep their current contract while the hosted service boundary changes underneath them.

## Data Model

Phase 1 should avoid a risky schema merge into DEN's main auth tables. DEN can own the behavior while still using the existing AI gateway storage model:

- user AI access policy
- credential records
- credential bindings
- encrypted secret store
- session leases
- usage events
- audit events

This allows the service boundary to change without bundling a large data migration into the same rollout.

Later follow-up work can decide whether to:

- keep those tables as a DEN-managed subsystem, or
- physically merge them into a broader DEN schema

## UI Expectations

The hosted admin UI must expose:

- per-user AI access assignment for `openai` and `anthropic`
- explicit provider enablement and model assignment
- visible credential state and health
- a proper OpenAI connect/reconnect OAuth action
- Anthropic shared-key creation and rotation

The admin UI should not imply support for providers that the hosted managed path cannot execute.

## Error Handling

If OpenAI is not connected:

- DEN should return an explicit managed-AI failure
- admin UI should show that OpenAI needs connection or reconnection

If Anthropic is missing or invalid:

- DEN should return an explicit credential/configuration failure
- admin UI should show unhealthy state

If a user is assigned a disallowed provider or model:

- DEN should reject the prompt with explicit errors such as:
  - `provider_not_assigned`
  - `model_not_allowed`
  - `invalid_default_model`

If OpenAI refresh fails permanently:

- DEN should mark the credential unhealthy
- DEN should stop silently pretending the provider is available
- admin UI should surface that the credential requires reconnection

DEN must not silently fall back to a different provider than the one assigned to the user.

## Rollout Risks

- The deployed admin UI is currently behind the repo and must be updated first.
- OpenAI admin-side OAuth is new implementation work in the admin flow.
- Forcing all managed prompts through hosted DEN makes managed AI depend on network reachability.
- Keeping `/ai-gateway/*` as compatibility paths in phase 1 leaves temporary naming debt.

## Testing Gate

Phase 1 is not complete until all of the following are true:

- hosted admin UI shows per-user AI access assignment for `openai` and `anthropic`
- admin can connect OpenAI through OAuth on the hosted UI
- admin can store a shared Anthropic key on the hosted UI
- admin can assign a test user to OpenAI and a valid model
- admin can assign a test user to Anthropic and a valid model
- Veslo desktop routes managed prompts through hosted DEN
- a real OpenAI-assigned prompt succeeds end to end
- a real Anthropic-assigned prompt succeeds end to end
- invalid or disallowed provider/model requests fail clearly

## Non-Goals

- supporting arbitrary OpenCode providers in phase 1
- direct prompt handling on the literal `/admin` path
- immediate removal of local compatibility routes
- immediate physical database consolidation
