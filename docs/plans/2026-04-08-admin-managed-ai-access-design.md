# Admin-Managed AI Access Design

## Goal

Move provider and model control out of the user-facing Veslo app and into the AI Gateway admin UI so platform admins, not end users, control which provider and models each signed-in user can use.

## Summary

The current implementation still reflects a BYOK flow:

- the Veslo app exposes provider connection in Settings
- the Veslo app exposes default/session model selection
- the app writes model selection into `opencode.json`
- `services/ai-gateway` stores user-owned credentials and proxies provider traffic for those users

The target implementation changes authority:

- the admin UI manages platform credentials and per-user AI access policy
- the Veslo app becomes a thin client for prompt entry and display
- the backend resolves user identity from the existing Den bearer token
- the gateway enforces assigned provider/model policy on every prompt

## User Experience

For end users:

- browser-based login remains unchanged
- Settings no longer exposes `Providers`
- Settings no longer exposes `Model`
- session UI no longer exposes provider connect or model picker actions
- the app may show a read-only summary of the assigned provider/model
- if no AI access is assigned, the user can sign in but cannot send prompts

For platform admins:

- `Credentials` remains the place to manage platform-owned upstream credentials
- `Users` gains an `AI access` editor for each user
- admins assign:
  - access enabled/disabled
  - provider
  - default model
  - allowed models

## Architecture

### Source of truth

`services/ai-gateway` becomes the source of truth for end-user AI access policy.

The policy is keyed to the authenticated Den user ID, not to a separate gateway-specific identity or opaque token. This keeps the existing login flow and reuses the current gateway bearer-token resolution path.

### Runtime flow

1. User signs into Veslo with the existing browser flow.
2. The app obtains the existing Den bearer token as it does today.
3. The app asks the Veslo server for the signed-in user’s effective AI access profile.
4. The app configures gateway routing to the assigned provider and uses the admin-set default model for prompts.
5. The Veslo server proxies those requests to `services/ai-gateway`.
6. `services/ai-gateway` resolves the user from the bearer token, loads the user access policy, validates provider/model, selects an eligible platform credential binding, and forwards upstream.

### Enforcement model

The backend is the final guardrail.

The app should behave correctly and not present illegal choices, but the gateway must still reject:

- missing AI access assignment
- disabled AI access
- provider mismatch
- missing default model
- requested model not in the allowed list when a list is configured

## Data Model

Add a new user-scoped AI access policy table in `services/ai-gateway`.

Proposed fields:

- `id`
- `user_id`
- `enabled`
- `provider`
- `default_model`
- `allowed_models_json`
- `created_at`
- `updated_at`

The user access policy is separate from credential records:

- credential records remain the platform-owned upstream secrets/bindings used for routing
- user access policy decides which provider/model that user is allowed to consume

This avoids overloading credential tables with authorization policy.

## Admin UI Changes

Extend the existing `Users` page in `services/ai-gateway/public-admin`.

Each user editor will gain an `AI access` section with:

- access enabled checkbox
- provider select
- default model input or select
- allowed models multi-value input
- validation and save feedback

The UX should treat `default model` as required when access is enabled.

`Allowed models` semantics:

- empty list means only the default model is allowed
- non-empty list means the default model must be one of the allowed models

This keeps the behavior deterministic for the Veslo app while leaving room for future admin-controlled multi-model support.

## App Changes

### Remove user-facing settings

Remove or disable:

- `Providers` card/controls in `packages/app/src/app/pages/settings.tsx`
- `Model` tab in `packages/app/src/app/pages/settings.tsx`
- provider connection entry points in session/dashboard surfaces
- provider/model picker modal usage

### Replace with read-only managed state

Add a small read-only representation of assigned AI access, likely in Settings or session metadata:

- assigned provider
- assigned default model
- admin-managed notice

### Prompt model selection

The app should stop treating local default model state as user-editable authority for gateway-managed providers.

Instead:

- the app fetches the assigned AI access profile
- the assigned default model is used for prompt requests
- the local model picker flow is removed
- `opencode.json` routing can still be updated to point OpenAI/Anthropic provider traffic at the Veslo gateway, but the effective model comes from the assigned profile, not from user settings

## API Changes

### `services/ai-gateway`

Add admin endpoints:

- `GET /admin/api/users/:userId/ai-access`
- `PUT /admin/api/users/:userId/ai-access`

Add user endpoint:

- `GET /api/me/ai-access`

Update proxy behavior:

- load the current user’s AI access before provider proxying
- validate the route provider against the assigned provider
- validate requested model against allowed/default models
- optionally normalize missing/invalid request model to the assigned default model only when safe and intentional; otherwise reject with a clear error

### `packages/server`

Add a proxy route for the app:

- `GET /ai-gateway/me/ai-access`

Remove or disable obsolete self-service routes:

- OpenAI OAuth start/callback for end users
- Anthropic API key save
- credential list/revoke routes that exist only for user self-management

## Credential Ownership Model

The current gateway implementation stores user-owned credentials and user-scoped bindings. The target flow is platform-admin-controlled, so the runtime must stop assuming each end user owns their own provider credentials.

The cleanest migration is:

- keep per-provider credential records and bindings in `services/ai-gateway`
- introduce a provider pool owner/scope that is platform-managed rather than user-managed
- use the user access policy to decide which provider pool the user is routed into

This can be implemented either by:

- expanding credential ownership semantics to support platform-owned bindings, or
- temporarily using a stable synthetic owner ID per provider pool

The code should prefer an explicit platform-owned model if the schema change is small enough to land cleanly.

## Error Handling

User-visible cases:

- no AI access assigned: block prompts with a clear message
- access disabled: block prompts with a clear message
- backend unavailable: surface existing transport/server errors
- provider credential outage: surface provider/runtime failure, but do not reintroduce user controls

Admin-facing cases:

- invalid provider
- missing default model
- default model not included in allowed models
- attempt to save malformed allowed model data

## Validation Rules

When access is enabled:

- provider is required
- default model is required
- if `allowedModels` is non-empty, `defaultModel` must be included

When access is disabled:

- provider/model values may remain persisted but are inactive

## Migration

### Behavior migration

- existing end-user provider/model settings become ignored for OpenAI/Anthropic
- any user-facing provider/model settings code should be removed or reduced to read-only display

### Data migration

- introduce the new policy table through a Drizzle migration
- seed no assignments by default
- platform admins must assign AI access before affected users can send prompts

## Testing

Add or update targeted tests for:

- schema/repository coverage for the user access policy table
- admin API read/write behavior
- user self-read behavior
- proxy enforcement of provider/model assignment
- Veslo server proxying for the new self-read endpoint
- app behavior when AI access exists
- app behavior when AI access is missing
- removal of obsolete provider/model UI entry points

## Documentation

Add brief developer documentation describing:

- user identity is keyed off the existing Den login
- admins manage platform credentials and per-user AI access separately
- end users no longer manage provider/model settings in Veslo
- any required migration/setup steps

## Out of Scope

- redesigning the login flow
- end-user model selection when multiple models are allowed
- org-level policy inheritance
- hosted remote execution changes
- messaging-surface UI changes
