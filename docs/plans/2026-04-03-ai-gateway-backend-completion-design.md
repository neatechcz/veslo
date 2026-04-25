# AI Gateway Backend Completion Design

## Goal

Finish `services/ai-gateway` as the production-correct provider edge for Veslo:

- server-side credential custody
- authenticated request forwarding
- sticky session-to-credential assignment
- usable admin read models and actions
- telemetry, audit, and alerting foundations

## Current State

The repository already contains:

- a standalone `services/ai-gateway` service
- provider proxy routes for OpenAI and Anthropic
- admin pages and JSON endpoints for credentials, sessions, usage, alerts, users, and audit
- BYOK credential APIs for OpenAI OAuth and Anthropic API keys
- sticky lease semantics and failover tests

The main gaps are in runtime correctness:

- live proxy routes are not authenticated against gateway access tokens
- live proxy state uses in-memory credentials and leases
- OpenAI OAuth refresh is not wired for production
- usage recording is not attached to provider proxy traffic
- alerts are fixture-backed
- several admin actions are UI-only placeholders

## Recommendation

Use a backend-first sequence:

1. harden the live data plane
2. attach telemetry and operational signals
3. finish admin actions on top of real backend primitives
4. verify end-to-end through the existing admin shell and Veslo server gateway routes

This order minimizes rework. The admin shell already has enough surface area to consume live data once the backend is trustworthy.

## Architecture

### 1. Gateway Authentication

The gateway must treat forwarded provider requests as authenticated server-to-server calls.

- `packages/server` already forwards `Authorization: Bearer <gateway-access-token>` to provider proxy routes.
- `services/ai-gateway` should validate that token before selecting leases or forwarding upstream.
- the resolved gateway principal must supply the user identity used for lease ownership and usage attribution

The proxy must stop trusting caller-supplied `x-veslo-owner-user-id`.

### 2. Persistent Runtime Repositories

The live gateway runtime should use MySQL-backed repositories for:

- credential records and bindings
- session leases
- usage events
- audit events

Secrets remain encrypted at the gateway layer and are never exposed to the client. The secret ciphertext can remain in the gateway-managed secret store abstraction, but the credential metadata and binding records used by runtime selection must be persisted.

### 3. Credential and Lease Semantics

Per provider:

- one session gets one active binding
- the active binding remains sticky during the session
- initial assignment should rotate across healthy bindings instead of always picking the first row
- permanent credential failures trigger a same-provider rebind
- transient failures and refreshable auth issues do not rebind immediately

The selector should move from "first healthy binding" to deterministic rotation, preferably round-robin based on persisted ordering plus lease pressure.

### 4. Provider Forwarding

The gateway remains a thin provider edge.

- request bodies should be forwarded with minimal transformation
- gateway only attaches provider credentials and required auth headers
- response status, headers, and body should be preserved as much as possible

Initial scope can stay on:

- `POST /providers/openai/v1/chat/completions`
- `POST /providers/anthropic/v1/messages`

but the transport layer should be shaped so more routes can be added without redesign.

### 5. OAuth Lifecycle

OpenAI OAuth needs full lifecycle support:

- start auth
- code exchange
- encrypted token storage
- refresh on expiry
- unhealthy marking on permanent refresh failure

Anthropic remains API-key based for now, but the repository and secret-store model must stay provider-extensible.

### 6. Telemetry and Signals

Usage recording should happen on successful provider proxy requests.

Track at minimum:

- user
- provider
- credential record
- credential binding
- session id
- request id
- model
- input tokens
- output tokens
- error/failure classes where available

Alerts should be derived from real events, starting with:

- repeated permanent credential failures
- repeated OAuth refresh failures
- rate-limit failures above threshold
- unusually high session or credential error rates

### 7. Admin Surfaces

Admin pages should be split into two classes:

- read models backed by real data
- actions backed by explicit APIs

Expected functional scope:

- Credentials: list, revoke, drain, rotate, status
- Sessions: list, current binding, failover history, lease state
- Usage: aggregate by total, credential, user, org
- Alerts: list, acknowledge, resolve
- Users: already mostly Den-backed, keep and extend only if needed
- Audit: list significant actions and operational events

## Delivery Phases

### Phase A: Live Data Plane Correctness

- authenticate gateway proxy requests
- replace in-memory live credential + lease runtime with persistent repos
- wire OpenAI OAuth refresh
- keep secret values server-side only

### Phase B: Usage, Audit, and Alerts

- record usage from proxy traffic
- store operational audit events
- derive live alerts from failure counters and credential state

### Phase C: Admin Completion

- wire admin action APIs
- connect UI buttons to real endpoints
- remove placeholder-only behaviors

## Testing Strategy

Use TDD per slice.

Primary checks:

- focused `services/ai-gateway` tests for auth, repo behavior, proxy behavior, usage recording, alerts
- `pnpm --filter @neatech/ai-gateway build`
- `packages/server` proxy tests for gateway forwarding
- end-to-end admin verification after backend slices are stable

## Non-Goals For The First Slice

- broad provider-route expansion beyond the current OpenAI and Anthropic endpoints
- visual redesign of the admin UI
- advanced quota policies beyond basic round-robin/load spreading

## Success Criteria

The backend is considered substantially complete when:

- all provider traffic goes through the gateway with validated server-side auth
- no raw provider secrets are required client-side
- session-to-credential stickiness is persisted and rotates across sessions
- OpenAI OAuth refresh works in production
- usage, audit, and alerts are based on real runtime events
- the admin pages read and mutate real gateway state instead of fixtures or placeholders
