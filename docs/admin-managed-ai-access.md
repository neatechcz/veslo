# Admin-Managed AI Access

This flow replaces the old user-managed BYOK provider/model settings in Veslo.

## Source of truth

- `services/ai-gateway` owns the effective AI access policy for each signed-in Den user.
- The policy is stored in `user_ai_access_policy` and keyed by the Den `userId`.
- The policy controls:
  - `enabled`
  - `provider`
  - `defaultModel`
  - `allowedModels`

## Runtime flow

1. The user signs into the Veslo app with the existing browser-based Den flow.
2. The app calls `GET /ai-gateway/me/ai-access` on `packages/server`.
3. `packages/server` proxies that to `GET /api/me/ai-access` on `services/ai-gateway` using the caller's Den bearer token.
4. The app treats the returned provider/model as read-only admin-managed state.
5. Prompt traffic still goes through the Veslo server and then through `services/ai-gateway`.
6. The gateway enforces provider/model policy before forwarding upstream.

## App behavior

- End users no longer get provider connect/disconnect controls.
- End users no longer get the Model settings tab or session model picker for gateway-managed providers.
- Settings now shows a read-only AI access summary.
- If no admin policy is assigned, the user can sign in but cannot send prompts.

## Admin behavior

- The AI Gateway admin `Users` screen now includes an `AI access` editor.
- Platform admins can enable/disable access, pick the assigned provider, set the default model, and optionally restrict allowed models.
- The `Credentials` page remains the place to inspect provider credentials.

## Platform credential pools

- Upstream provider credentials are selected from platform-owned pools, not from the signed-in end user's ID.
- The gateway resolves bindings from these owner IDs:
  - `platform:openai`
  - `platform:anthropic`
- Session ownership and usage attribution still stay tied to the real signed-in user.

## Manual setup

Before this flow works in a live environment, make sure healthy provider bindings exist for the platform pool owner that matches the assigned provider. If the database still only contains legacy per-user BYOK bindings, prompts will fail with `no_eligible_bindings`.

## Verification tooling

Use these commands when verifying the admin-managed flow locally or against the hosted admin environment:

- Seed a real desktop E2E profile through the live Den browser sign-in flow:

  ```bash
  cd packages/e2e && pnpm run seed:live-auth
  ```

- Run the authenticated desktop settings check after the profile is seeded:

  ```bash
  cd packages/e2e && pnpm test --spec ./specs/admin-managed-ai-access.spec.ts
  ```

- Check whether a real user is visible in the hosted admin directory:

  ```bash
  cd packages/e2e && pnpm run check:live-admin-user -- --email michal.sara@neatech.cz
  ```

## CI paths

- Windows MSI builds are produced by the GitHub Actions workflow `Build Windows MSI` in [`.github/workflows/build-windows-msi.yml`](../.github/workflows/build-windows-msi.yml).
- Hosted AI gateway deployment is handled by the GitHub Actions workflow `Deploy AI Gateway` in [`.github/workflows/deploy-ai-gateway.yml`](../.github/workflows/deploy-ai-gateway.yml).
- To deploy the dev gateway from a branch, use workflow dispatch with `service_name=veslo-ai-gateway-dev` and `branch=<your-branch>`.

## Main endpoints

- Admin read/update:
  - `GET /admin/api/users/:userId/ai-access`
  - `PUT /admin/api/users/:userId/ai-access`
- User self-read:
  - `GET /api/me/ai-access`
- Veslo app proxy:
  - `GET /ai-gateway/me/ai-access`
