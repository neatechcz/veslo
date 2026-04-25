# Shared Codex Credential Assignment Design

**Date:** 2026-04-17
**Status:** Approved
**Branch:** codex/ai-gateway-auth-migration

## Goal

Make Codex credential ownership fully admin-managed and database-backed so Veslo desktop prompts keep working when the admin changes which Codex account a user should run under, without any gateway redeploy.

The intended product behavior is:

- The Veslo desktop app signs the user in to Veslo only.
- The Veslo desktop app sends prompts through the local OpenCode runtime to the managed AI gateway.
- DEN/admin decides:
  - which provider a user may use
  - which model that user may use
  - which shared Codex credential that user is mapped to
- The gateway resolves the assigned credential at request time and runs the prompt through the correct server-side credential.
- Many users may share one Codex credential.

## Non-Goal

This design does not make the desktop app own provider credentials again.

It also does not require one dedicated Codex account per Veslo user. Shared admin-owned Codex credentials are explicitly allowed.

## Selected Approach

Use explicit user-to-credential assignment for `codex_oauth`.

This means:

- Admin creates one or more Codex credentials on `/admin/credentials`.
- Each credential is stored encrypted in the database, like other managed credentials.
- Admin assigns a user AI access policy on `/admin/users`.
- When the provider is `codex_oauth`, the policy also points at a selected Codex credential record.
- Many users can point at the same credential.

This is Approach 2 from the earlier options and is the selected design.

## Why This Approach

It matches the target mental model:

- the desktop app does not own Codex login
- the admin UI is the single control plane
- account switching becomes a data change, not an infrastructure change
- shared service accounts are supported cleanly

It also matches how the rest of the managed credential system already works better than the current global `AI_GATEWAY_CODEX_AUTH_JSON` secret.

## Current Mismatch

Today the code is split:

- user AI access already stores provider and model assignment
- credential tables already exist and support shared credential records and bindings
- the Codex route still hardcodes the platform owner `platform:codex_oauth`
- the Codex worker still reads one global auth blob from environment

That means admin UI assignment looks dynamic, but actual Codex identity is still static at deploy time.

## Target Data Model

### User AI Access

Extend the user AI access policy to optionally include `credentialId`.

Rules:

- `credentialId` is nullable for providers that do not need explicit selection yet
- `credentialId` is required when `enabled=true` and `provider=codex_oauth`
- `credentialId` must reference a healthy credential with `provider=codex_oauth`
- the selected credential may be shared by many users

### Credentials

Codex credentials become normal managed credential records:

- `provider = codex_oauth`
- `credentialType = oauth`
- `ownerUserId = platform:codex_oauth` for shared platform credentials
- secret payload stores Codex auth material encrypted in the secret store

For the first version, the important thing is that the credential is stored per record in the database and can be selected by id. The transport can still materialize a Codex auth file locally per request.

## Target Admin UI

### `/admin/credentials`

Add first-class Codex credential support:

- create a new `Codex / ChatGPT runtime` credential
- show provider, state, scope, active leases, alerts, and usage
- allow revoke/drain/rotate like other credentials where supported

The UI text should make clear this is the shared server-side credential used to answer Veslo prompts.

### `/admin/users`

When the assigned provider is `codex_oauth`, show:

- enable AI access
- provider
- default model
- allowed models
- assigned credential selector

The selector should list active `codex_oauth` credentials by name, not raw ids.

## Target Request Flow

1. Veslo desktop app signs in to Veslo.
2. Local OpenCode sends prompt to the gateway with Veslo gateway token.
3. Gateway resolves the Veslo user.
4. Gateway loads user AI access policy.
5. Gateway validates provider/model policy.
6. Gateway loads the assigned Codex credential from the policy.
7. Gateway obtains or reuses the binding for that credential.
8. Gateway materializes the assigned credential auth state for the Codex worker.
9. Codex worker executes the prompt with that credential.
10. Gateway returns the response to OpenCode and records usage against the chosen credential.

## Binding Strategy

We do not want routing based only on provider-wide platform owner anymore for Codex.

Instead:

- the user policy names one credential
- the gateway resolves the binding that belongs to that credential
- leases remain sticky per session against that binding
- failover can still move to another binding only if policy explicitly allows it in a later phase

For the first implementation, strict binding to the selected credential is simpler and matches the admin mental model best.

## Secret Handling

The Codex credential secret must live in the existing encrypted secret store, not in deployment env.

The worker should receive the credential by:

- reading the selected credential secret from the database
- materializing a request-local or worker-local auth file
- executing Codex with that auth context

The desktop app never receives the Codex access token, refresh token, or auth JSON.

## Error Handling

Expected failures:

- no AI access policy: user gets policy error
- provider assigned but no credential selected: admin configuration error
- selected credential missing or revoked: credential unavailable error
- selected credential unhealthy: credential unhealthy error
- selected model outside allowed models: model policy error
- Codex runtime auth expired: mark credential unhealthy and alert admin
- worker execution failure: provider runtime error

## Compatibility Notes

Useful existing pieces:

- AI access policy plumbing already exists
- credential repository and secret store already exist
- admin credentials and users pages already exist
- usage, alerts, leases, and audit already exist

Required structural change:

- stop treating Codex auth as one deploy-wide secret
- treat it as a credential record selected by policy

## Migration Strategy

1. Extend schema and API to carry `credentialId`.
2. Add admin UI support for creating and assigning Codex credentials.
3. Change Codex routing to resolve the selected credential record instead of the hardcoded platform owner path.
4. Remove dependency on the global Codex auth env for normal request execution.

During transition, the global env path can remain as a fallback only if needed to avoid breaking live environments while the new path is rolled out.

## Success Criteria

The feature is complete when all of the following are true:

- Admin can create multiple shared Codex credentials in admin.
- Admin can assign one of those credentials to a user.
- Multiple users can share the same Codex credential.
- Changing the assigned Codex credential for a user takes effect without redeploying the gateway.
- The Veslo desktop app can sign in as a real user and send a prompt successfully through the assigned Codex credential.
