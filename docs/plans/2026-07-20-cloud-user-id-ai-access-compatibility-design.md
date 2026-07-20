# Cloud User-ID AI Access Compatibility Design

**Date:** 2026-07-20
**Status:** Approved
**Scope:** Cloud AI Gateway user AI-access reads only.

## Summary

Add an authenticated user-ID compatibility route to the cloud AI Gateway while preserving the existing `/me` route and every current application and inference endpoint. A caller may supply its Veslo/DEN user ID in the route, but that ID is only a selector: the bearer token remains the identity authority, and the supplied ID must exactly match the user resolved from that token.

The compatibility route returns the same AI-access response as the existing `/me` route. Today its effective model remains the singleton platform model. The route preserves an explicit user-addressed contract that can later be backed by per-user model resolution without changing clients, but this change does not introduce per-user model selection or restore historical per-user model fields as authority.

## Goals

- Expose `GET /api/users/:userId/ai-access` on the cloud AI Gateway.
- Expose the equivalent `/ai-gateway/users/:userId/ai-access` mounted alias.
- Preserve `GET /api/me/ai-access` and `GET /ai-gateway/me/ai-access` unchanged.
- Require the path user ID to match the bearer-token user exactly.
- Return the same response contract and globally active effective model as `/me`.
- Keep the route structure ready for a future user-aware effective-model resolver.
- Preserve current desktop application and local Veslo server behavior without changes.

## Non-Goals

- No desktop application changes.
- No local Veslo server routes or proxy changes.
- No DEN service changes.
- No caller-selected model, user model picker, or per-user model persistence.
- No identity alias table or old-user-ID to new-user-ID database migration.
- No trusted user identity headers on inference requests.
- No staging deployment or branch integration.

## API Contract

Canonical compatibility route:

```text
GET /api/users/:userId/ai-access
Authorization: Bearer <DEN user token>
```

Cloud mounted alias:

```text
GET /ai-gateway/users/:userId/ai-access
Authorization: Bearer <DEN user token>
```

Successful responses are byte-for-byte compatible in shape with the current `/api/me/ai-access` response:

```json
{
  "aiAccess": {
    "id": "access-id",
    "userId": "user-id",
    "enabled": true,
    "provider": "codex_oauth",
    "credentialId": "credential-id",
    "effectiveModel": {
      "provider": "codex_oauth",
      "model": "platform-active-model"
    },
    "updatedAt": "2026-07-20T00:00:00.000Z"
  }
}
```

An authenticated user without an AI-access record receives the existing successful null response:

```json
{ "aiAccess": null }
```

## Identity and Authorization

The bearer token is resolved through the existing Gateway session resolver. The path ID is normalized only for surrounding whitespace and compared exactly with the resolved session user ID.

- Missing or invalid bearer authentication returns `401 unauthorized`.
- A supplied ID that does not match the authenticated user returns `403 user_identity_mismatch`.
- The mismatch is rejected before any AI-access or model-policy repository lookup.
- Repository lookups use the authenticated session user ID, never an unverified header or path value.

The provider inference proxy remains unchanged. It continues to resolve the user from its Gateway bearer token and continues to ignore caller-supplied identity headers. This compatibility read route does not grant authority to impersonate another user during inference.

## Model Resolution

Both `/me` and the explicit user-ID route use one shared response handler. The handler reads the authenticated user's enablement, provider, and credential assignment, then composes `effectiveModel` from the singleton platform policy.

Historical per-user `defaultModel` and `allowedModels` values remain non-authoritative and are not returned as the effective model. A future per-user model feature may replace the internal effective-model resolution strategy while keeping both public routes stable. That future change requires its own authorization, persistence, admin, and rollout design.

## Error Handling

The compatibility route preserves the existing `/me` error contract wherever possible:

- `401 unauthorized`: bearer token is missing, invalid, or no longer resolves.
- `403 user_identity_mismatch`: authenticated user differs from the route user.
- `502 user_session_lookup_failed`: session resolution fails unexpectedly.
- `502 platform_model_policy_lookup_failed`: model policy storage fails.
- `503 platform_model_policy_not_configured`: an access record exists but no active platform model is configured.
- `200 { "aiAccess": null }`: the authenticated user has no AI-access record.

No response reveals whether a different requested user exists or has AI access.

## Rollout and Compatibility

This is an additive cloud-only deployment. Existing desktop versions continue to call `/me` and require no update. New or legacy direct cloud clients may use the explicit user-ID route once the Gateway is deployed. Both route families remain supported and share one implementation so their behavior cannot drift.

## Verification

Gateway HTTP tests will prove:

- the canonical and mounted explicit-ID routes return the same payload as `/me` for the authenticated user;
- a mismatched user ID returns the stable `403` response before AI-access or model-policy reads;
- missing and invalid authentication return `401`;
- an absent AI-access record preserves the existing null response;
- legacy per-user model values do not override the platform active model;
- current inference routes still derive identity from the bearer token and ignore caller-supplied owner-user headers.

Verification will include the focused compatibility tests, the complete AI Gateway suite, the AI Gateway TypeScript build, and diff/working-tree checks. Desktop and local-server E2E are intentionally excluded because those surfaces do not change.
