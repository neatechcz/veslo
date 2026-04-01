# AI Gateway Admin UI Auth Design

**Date:** 2026-03-31  
**Status:** Approved  
**Branch:** `codex/ai-gateway-control-plane`

## Goal

Add a real web admin control plane to `services/ai-gateway`, reuse the existing Den authentication model and bearer token, restrict access to `platform_admin`, deploy it separately on Render, and verify the live flow with Playwright.

## Baseline

This design extends the previously approved AI gateway control-plane design and Pencil page set. The page inventory and information architecture were already approved earlier:

- `Credentials`
- `Sessions`
- `Usage`
- `Alerts`
- `Users`
- `Audit`

What changes in this delta:

- the UI must now exist as a working web interface, not only as Pencil mockups
- the UI must reuse the same Den auth/token model as the rest of Veslo
- the deployed service must be tested on Render with the existing platform admin account

## Approaches Considered

### 1) Host admin UI directly inside `services/ai-gateway` and introspect Den bearer auth (chosen)

- `ai-gateway` serves `/admin` and the admin page routes.
- Browser requests include the same bearer token model already used by Veslo.
- `ai-gateway` validates that token by calling Den and checking `platform_admin`.

Pros:

- Preserves the previously approved standalone control-plane boundary.
- Reuses the same token model instead of inventing a second auth system.
- Keeps operator UI, read models, and operator actions co-located with the gateway.

Cons:

- Requires a small Den admin-session/introspection surface.
- Adds one server-to-server auth verification hop.

### 2) Host admin UI in Den and keep `ai-gateway` API-only

Pros:

- Simplest auth story because Den already owns Better Auth and platform roles.

Cons:

- Breaks the approved “separate control plane service” boundary.
- Couples gateway UI releases to Den UI decisions.

### 3) Validate Better Auth bearer tokens locally inside `ai-gateway`

Pros:

- Avoids Den introspection calls.

Cons:

- Duplicates auth concerns and spreads trust/secrets further than needed.
- Tightens coupling between `ai-gateway` and Den internals.

## Chosen Architecture

Use approach 1.

### Service split

- `services/den`
  - remains source of truth for user/session identity and platform roles
  - exposes minimal admin-session and user-directory APIs needed by the gateway UI
- `services/ai-gateway`
  - serves the admin web UI and page routes
  - exposes gateway-owned JSON APIs for credentials, sessions, usage, alerts, and audit
  - proxies user-directory and invite/edit actions to Den-backed admin endpoints

### UI hosting model

- The admin UI is served from `ai-gateway` under `/admin`.
- It is not implemented in `packages/web`.
- The first version uses a lightweight server-served shell with client-side fetches to JSON endpoints.
- The navigation and layout match the approved Pencil structure.

## Auth Model

### Token reuse

- The admin UI uses the same Den bearer token model already returned by Den auth.
- The browser stores that token for the admin surface just like the existing Veslo auth model stores Den auth state.
- `ai-gateway` accepts `Authorization: Bearer <token>` on admin API requests.

### Verification flow

- `ai-gateway` does not validate Better Auth bearer tokens locally.
- Instead it calls a Den admin-session endpoint using the presented bearer token.
- Den returns:
  - authenticated user identity
  - active org context summary
  - `platformAdmin` boolean
- `ai-gateway` rejects non-admin users with `403`.

### Login surface

- If no valid token is present, `/admin` renders a sign-in gate.
- The first version uses Den’s existing email/password web auth flow and captures the returned bearer token.
- If a valid stored Den token is already present, the UI skips the sign-in form.

## Page Set

The admin UI will ship these pages:

- `/admin/credentials`
  - credential inventory, health chips, linked alert counts, row actions
- `/admin/sessions`
  - session list, sticky binding detail, failover history
- `/admin/usage`
  - total usage default plus filters for credential, user, org and breakdown controls
- `/admin/alerts`
  - incident triage queue with acknowledge/resolve/escalate actions
- `/admin/users`
  - user directory, create user action top-right, right-side edit panel, admin toggle, disable/delete actions
- `/admin/audit`
  - filterable audit stream and change detail

## Data Ownership

### Den-owned

- auth session lookup
- `platform_admin` role lookup
- global user directory
- org memberships (`owner/member`)
- create/invite/edit/disable/delete user actions

### AI-gateway-owned

- credential inventory read models
- session lease read models
- usage read models
- alert linkage
- audit event views for gateway-owned actions

## Error Handling

- `401` when there is no valid Den bearer token
- `403` when the authenticated user is not `platform_admin`
- page-level empty states for unimplemented or empty datasets
- explicit “service wiring incomplete” panels where a slice is still fixture-backed

## Deployment

- `ai-gateway` stays separately deployable on Render
- admin routes are served by the same Render service as the gateway
- the existing `veslo-ai-gateway-dev` Render service remains the development target

## Testing Strategy

### Local verification

- focused auth middleware tests
- admin route tests
- page rendering tests for the first shell
- end-to-end local smoke checks against the service

### Remote verification

- deploy `ai-gateway` to Render
- verify `/admin` auth gate
- verify successful admin access using the existing admin account
- verify each page renders and loads its backing JSON calls
- run Playwright MCP against the live Render deployment

## Success Criteria

- `/admin` exists and is no longer `404`
- non-admin users cannot access the control plane
- the existing platform admin can sign in and reach all approved pages
- the UI uses the same Den bearer token model as the rest of Veslo
- Render deployment works for the updated service
- Playwright verifies the live admin flow end-to-end
