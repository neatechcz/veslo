# Admin-Managed AI Access Follow-Up Design

## Goal

Finish the admin-managed AI migration by removing the last legacy user BYOK gateway surface, adding admin-side platform credential creation, and then validating the real desktop flow end to end.

## Scope

This follow-up is intentionally sequenced:

1. Remove the remaining direct user credential APIs from `services/ai-gateway`.
2. Add admin-only credential creation for platform-owned provider pools.
3. Run the AGENTS-required Docker/Tauri/WebDriver verification path.

The existing user-scoped AI access policy model remains the source of truth for provider/model assignment. This work only removes obsolete credential ownership paths and fills in the missing admin credential write flow.

## Recommended Approach

### Step 1: Hard-remove legacy user BYOK routes

The supported authenticated user surface in `services/ai-gateway` should be reduced to:

- `GET /api/me/ai-access`

The following legacy routes should be removed from the supported API:

- `POST /api/providers/openai/oauth/start`
- `POST /api/providers/openai/oauth/callback`
- `POST /api/providers/anthropic/api-keys`
- `GET /api/providers/:provider/credentials`
- `DELETE /api/providers/:provider/credentials/:credentialId`

Rationale:

- the Veslo app and `packages/server` no longer use them
- keeping them alive preserves an unnecessary auth and secret-management surface
- coexistence would undermine the admin-managed migration goal

The cleanest behavior is route removal, which naturally yields `404` for stale callers.

### Step 2: Add admin credential creation for platform pools

Platform-managed provider credentials should be created from the admin `Credentials` page via direct secret entry.

Recommended initial support:

- OpenAI API key
- Anthropic API key

No admin OAuth flow is included in this slice. Direct secret entry is the best fit for platform-owned credentials because it is simpler to validate, rotate, drain, revoke, audit, and test.

Admin API addition:

- `POST /admin/api/credentials`

Request body:

- `provider`
- `secret`
- optional `name`

Behavior:

- provider must be `openai` or `anthropic`
- secret must be non-empty
- a secret record is encrypted and stored
- a credential record is created
- a binding is created under the provider-specific platform owner:
  - `platform:openai`
  - `platform:anthropic`

### Step 3: Run the desktop end-to-end gate

After the cleanup and admin credential write flow land, validate the real Veslo runtime using the AGENTS-required path:

1. start Docker dev stack
2. build the Tauri desktop app with the E2E feature
3. run the matching WebdriverIO spec

If the environment cannot complete one of those steps, report the exact blocker and the exact commands remaining.

## Data Model

Add a real credential display name instead of inventing UI-only labels.

Recommended schema change:

- add `name` to `credential_record`

This lets the admin `Credentials` table show stable human-readable labels while still keeping provider, state, usage, and binding ownership in the existing normalized model.

The existing `owner_user_id` field remains, but platform-created credentials now consistently use provider pool owners:

- `platform:openai`
- `platform:anthropic`

## API Behavior

### User-authenticated gateway API

Supported:

- `GET /api/me/ai-access`

Removed:

- all direct user credential mutation/list/revoke routes

### Admin-authenticated gateway API

Existing:

- `GET /admin/api/credentials`
- `POST /admin/api/credentials/:credentialId/revoke`
- `POST /admin/api/credentials/:credentialId/drain`
- `POST /admin/api/credentials/:credentialId/rotate`

New:

- `POST /admin/api/credentials`

Validation errors should remain explicit:

- `invalid_provider`
- `invalid_credential_secret`
- any existing admin session/auth failures

Success should return the created admin credential record so the UI can update immediately without relying on a full page refetch.

## UI Behavior

The `Credentials` page gets a compact admin-only create form:

- provider select
- optional name input
- secret textarea or password input
- submit button

The UI should not expose or echo the stored secret after creation. It only confirms the created credential metadata and refreshes the list.

The rest of the credential operations remain as they are today:

- drain
- revoke
- rotate

## Error Handling

User-facing:

- stale callers to removed BYOK endpoints receive `404`
- users without configured AI access remain blocked by the current admin-managed messages

Admin-facing:

- invalid provider or empty secret returns `400`
- create failures surface as admin API errors
- lack of healthy platform bindings still manifests at runtime as `no_eligible_bindings`

## Testing Strategy

### Step 1

- remove legacy user BYOK tests
- add a focused test that `GET /api/me/ai-access` still works
- verify removed BYOK paths now return `404`

### Step 2

- add repository tests for platform credential creation if needed
- add admin API tests for `POST /admin/api/credentials`
- add admin UI tests for the create form
- add runtime/proxy coverage showing platform-created bindings are eligible for routing

### Step 3

- run Docker/Tauri/WebDriver per AGENTS.md
- capture any environmental blockers precisely if full E2E is not possible

## Migration Notes

This is a breaking cleanup for any client still calling the old user BYOK gateway routes.

Before deploy:

- apply the credential-name schema migration
- create at least one healthy platform credential per provider you plan to assign
- verify AI access policies point users at providers that have healthy platform bindings
