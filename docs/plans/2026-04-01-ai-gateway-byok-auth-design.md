# AI Gateway BYOK Auth Migration Design

**Date:** 2026-04-01  
**Status:** Approved  
**Branch:** `codex/ai-gateway-auth-migration`

## Goal

Migrate OpenAI and Anthropic provider auth away from OpenCode-owned local auth storage and into `services/ai-gateway`, while keeping OpenCode as the session/tool engine. The gateway becomes the model edge for migrated providers, owns user BYOK credentials, forwards provider traffic upstream, tracks usage, and applies sticky per-session binding plus rebinding on permanent credential failure.

## Decisions

- Scope: full migration for OpenAI and Anthropic
- Runtime boundary: gateway becomes the model edge while OpenCode remains the session/tool engine
- Credential policy: BYOK only
- Secret policy: gateway-only secrets; raw keys/tokens never return to clients, workers, or OpenCode
- Provider UX: transparent provider swap; users still see `OpenAI` and `Anthropic`

## Current Baseline

Today, Veslo app/provider auth goes through OpenCode:

- API keys are set via OpenCode auth APIs
- provider OAuth is initiated and completed via OpenCode
- OpenCode persists provider auth in its own local data/config locations
- Veslo server mostly proxies requests and does not own provider secrets

Current `main` also includes a new `services/ai-gateway` service with:

- credential and lease schema scaffolding
- token broker and provider transport interfaces
- sticky lease broker semantics
- fixture-backed admin UI for credentials, sessions, usage, alerts, and audit

That gateway scaffolding is not yet the active runtime path for provider execution.

## Chosen Architecture

### Ownership boundary

`services/ai-gateway` becomes the only owner of migrated provider secrets.

- The app uploads OpenAI OAuth grants and Anthropic API keys to `ai-gateway`
- `ai-gateway` stores them behind `secret_ref`
- OpenCode never stores raw OpenAI or Anthropic secrets after migration
- Clients and workers only receive safe metadata such as connection state, provider, health, and timestamps

### Product/runtime boundary

OpenCode remains the engine for:

- sessions
- prompts
- tools
- history
- model selection

`ai-gateway` becomes the model edge for migrated providers:

- receives gateway-bound model traffic for OpenAI and Anthropic
- resolves the active binding for the user/session/provider
- loads the raw secret from secure storage
- forwards the request to OpenAI or Anthropic
- records usage, health transitions, and audit events

### Provider identity

The user-facing providers remain `openai` and `anthropic`.

This is a transparent provider swap:

- UI labels and model picker remain stable
- existing session/model semantics stay familiar
- under the hood, provider traffic is redirected to `ai-gateway`

## Credential Model

### BYOK only

Each user owns and uses only their own provider credentials.

- no shared organization-wide credential pool
- no fallback to Veslo-managed shared keys
- a user may register multiple credentials per provider

Examples:

- multiple OpenAI OAuth credentials for the same user
- multiple Anthropic API keys for the same user

### Secret handling

The gateway stores raw credentials and exposes only metadata:

- `credential_record`
- `credential_binding`
- `secret_ref`
- provider
- credential type
- state
- timestamps and health

Raw secrets must not appear in:

- OpenCode auth stores
- `opencode.json`
- worker logs
- UI payloads
- Veslo server config export endpoints

## Request Flow

### Auth setup

1. User chooses `OpenAI` or `Anthropic` in Veslo.
2. The app calls `ai-gateway` auth endpoints, not OpenCode provider auth.
3. `ai-gateway` stores the credential and returns non-secret metadata.
4. Veslo refreshes provider connection state from gateway-backed metadata.

OpenAI:

- browser-based OAuth flow starts and completes through `ai-gateway`
- gateway stores refresh/access material securely

Anthropic:

- API key is submitted directly to `ai-gateway`
- gateway stores the key securely

### Model execution

1. User runs a prompt using `openai/<model>` or `anthropic/<model>`.
2. OpenCode remains the orchestrator for the session/tool flow.
3. The actual provider call for those migrated providers is routed to `ai-gateway`.
4. `ai-gateway` identifies the user, provider, and session.
5. `ai-gateway` resolves the sticky binding for that session/provider pair.
6. `ai-gateway` loads upstream auth from secure storage.
7. `ai-gateway` forwards the request upstream.
8. `ai-gateway` records usage and returns the provider response.

## Session Stickiness And Rotation

### Stickiness

Each session must hold one active binding per provider.

- OpenAI lease and Anthropic lease are separate
- one session using both providers must not collapse to a single lease row

Required schema direction:

- current scaffold models `session_id -> active_binding_id`
- migrated design requires `session_id + provider -> active_binding_id`

### Distribution

- healthy existing sessions stay on their current binding
- new sessions may land on another eligible binding from the same user/provider pool
- this spreads load across a user’s own credentials without disrupting active sessions

### Failure classes

- `refreshable_auth`
  - expired access token with viable refresh path
- `permanent_credential`
  - `invalid_grant`
  - revoked token
  - invalid API key
  - irrecoverable quota or credential invalidation
- `transient_upstream`
  - timeouts
  - temporary 5xx
  - temporary upstream rate limiting

### Failure behavior

- `refreshable_auth`: keep same binding and refresh/retry if supported
- `transient_upstream`: keep same binding
- `permanent_credential`: mark current credential/binding unhealthy and rebind to another eligible binding for the same user/provider
- no replacement available: return a user-visible provider-auth failure

## Usage, Health, And Audit

The gateway must become the source of truth for migrated-provider telemetry.

### Usage tracking

Record usage against:

- user
- org
- provider
- credential record
- credential binding
- session
- model
- request
- token/request counts

### Health tracking

Track:

- credential state transitions
- refresh failures
- invalid grant / invalid key events
- rebinding counts
- drain/revoke events

### Audit tracking

Track operator and system events such as:

- credential added
- credential refreshed
- credential revoked
- credential drained
- session rebound
- alert acknowledged/resolved

## Migration Strategy

### Phase 1: Gateway foundations

- implement real credential repository
- implement secure secret storage and `secret_ref` resolution
- implement token broker
- implement provider transports
- expand leases to `session + provider`
- implement usage, health, and audit persistence
- keep runtime dark while foundations are built

### Phase 2: OpenAI cutover

- move OpenAI auth flow to gateway
- route OpenAI model traffic through gateway
- stop writing OpenAI secrets into OpenCode auth
- validate sticky lease and rebinding behavior for OpenAI OAuth

### Phase 3: Anthropic cutover

- move Anthropic auth flow to gateway
- route Anthropic traffic through gateway
- stop writing Anthropic API keys into OpenCode auth
- validate sticky lease behavior for Anthropic API keys

### Phase 4: Cleanup

- remove direct OpenCode auth path for migrated providers
- keep LM Studio and other local-only providers outside the gateway
- preserve non-migrated provider behavior until separately designed

## Compatibility Rules

- New sessions after cutover use gateway-backed OpenAI/Anthropic execution only
- Existing sessions may be temporarily grandfathered or explicitly failed during cutover; this must be chosen at implementation time
- Local-only providers such as LM Studio remain direct/local because they are not cloud BYOK credentials

## Required Code Changes

### `services/ai-gateway`

- replace scaffold token broker with real implementation
- replace scaffold provider transport with real OpenAI and Anthropic transports
- replace in-memory lease repository with durable repository
- evolve schema for provider-scoped sticky leases
- add secure secret storage integration
- replace fixture-backed admin read models with real data

### Veslo app/server integration

- move OpenAI/Anthropic connect flows from OpenCode auth APIs to gateway APIs
- update provider connection state logic to use gateway-backed metadata for migrated providers
- ensure OpenCode runtime routes migrated provider traffic to gateway instead of direct upstream auth
- prevent migrated provider secrets from being written to OpenCode auth/config

## Testing Gates

### OpenAI

- user can connect OpenAI OAuth via gateway
- user can run a prompt successfully
- usage is recorded in gateway
- second session can land on a different OpenAI binding for the same user
- permanent OpenAI credential failure triggers rebind to another eligible binding
- no raw OpenAI secret is stored in OpenCode auth/config

### Anthropic

- user can connect Anthropic API key via gateway
- user can run a prompt successfully
- usage is recorded in gateway
- second session can land on a different Anthropic binding for the same user
- permanent Anthropic credential failure triggers rebind to another eligible binding
- no raw Anthropic key is stored in OpenCode auth/config

### Security and observability

- raw secrets never appear in client payloads, worker logs, or config export responses
- admin UI shows real credential/session/usage/audit state
- session stickiness is preserved across repeated requests

## Non-goals

- migrating local-only providers such as LM Studio into gateway ownership
- building a shared credential pool for all users
- sending raw provider secrets back down to workers or clients
- replacing OpenCode’s session/tool engine in this migration
