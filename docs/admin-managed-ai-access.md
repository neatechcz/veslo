# Admin-Managed AI Access

This flow replaces the old user-managed BYOK provider/model settings in Veslo.

## Source of truth

- DEN owns the effective AI access policy for each signed-in Den user.
- The policy is stored in the DEN-managed managed-AI policy tables and keyed by the Den `userId`.
- The policy controls:
  - `enabled`
  - `provider`
  - `defaultModel`
  - `allowedModels`

## Runtime flow

1. The user signs into the Veslo app with the existing browser-based Den flow.
2. The app calls `GET /ai-gateway/me/ai-access` on `packages/server`.
3. `packages/server` proxies that to DEN's hosted managed-AI `GET /api/me/ai-access` endpoint using the caller's Den bearer token.
4. The app treats the returned provider/model as read-only admin-managed state.
5. Prompt traffic still goes through the local Veslo server compatibility path.
6. The local Veslo server forwards managed prompt traffic to hosted DEN.
7. DEN enforces provider/model policy, selects the platform credential, forwards upstream, and records usage/audit state.

## App behavior

- End users no longer get provider connect/disconnect controls.
- End users no longer get the Model settings tab or session model picker for DEN-managed providers.
- Settings now shows a read-only AI access summary.
- If no admin policy is assigned, the user can sign in but cannot send prompts.

## Admin behavior

- The DEN admin `Users` screen includes an `AI access` editor.
- Platform admins can enable/disable access, pick the assigned provider, set the default model, and optionally restrict allowed models.
- New users created from the admin flow are auto-assigned to Codex / ChatGPT runtime with `gpt-5.4` when at least one eligible Codex runtime credential exists. When multiple credentials are eligible, DEN selects the one with the fewest active leases and uses deterministic tie-breaking.
- Codex credential assignment options only include credentials whose provider is `codex_oauth`, whose stored state is `healthy`, and whose latest upstream status probe reports OK. A successful `codex | OK` probe is eligible even when rate-limit windows cannot be parsed; revoked, draining, unhealthy, invalid-grant, or probe-failing credentials are hidden from assignment.
- When no eligible Codex credential exists, user creation still succeeds and AI access remains unassigned until an eligible credential is available.
- The DEN admin `Credentials` page is the place to connect/reconnect OpenAI and create/rotate shared Anthropic and Codex runtime credentials.
- The hosted admin `Usage` page shows recorded usage for every credential, including credentials with zero recorded traffic.
- Codex runtime credentials include best-effort upstream limits metadata with cached `5h` and `weekly` windows when a credential-scoped probe succeeds. If limits cannot be read, the Usage page still renders historical usage and marks Codex limits as unavailable.

## Platform credential pools

- Upstream provider credentials are selected from platform-owned pools, not from the signed-in end user's ID.
- DEN resolves bindings from these owner IDs:
  - `platform:openai`
  - `platform:anthropic`
  - `platform:codex_oauth`
- Session ownership and usage attribution still stay tied to the real signed-in user.

## Manual setup

Before this flow works in a live environment, make sure healthy provider bindings exist for the platform pool owner that matches the assigned provider. If the managed-AI tables still only contain legacy per-user BYOK bindings, prompts will fail with `no_eligible_bindings`.

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

- Assign a live user to OpenAI before a live OpenAI desktop roundtrip:

  ```bash
  cd packages/e2e && pnpm run check:live-admin-user -- --email michal.sara99@gmail.com --provider openai --default-model gpt-4o-mini --allowed-model gpt-4o-mini
  VESLO_E2E_EXPECTED_MANAGED_AI_PROVIDER=openai VESLO_E2E_EXPECTED_MANAGED_AI_MODEL=gpt-4o-mini pnpm test --spec ./specs/den-managed-openai-anthropic.spec.ts
  ```

- Assign a live user to Anthropic before a live Anthropic desktop roundtrip:

  ```bash
  cd packages/e2e && pnpm run check:live-admin-user -- --email michal.sara99@gmail.com --provider anthropic --default-model claude-3-7-sonnet-latest --allowed-model claude-3-7-sonnet-latest
  VESLO_E2E_EXPECTED_MANAGED_AI_PROVIDER=anthropic VESLO_E2E_EXPECTED_MANAGED_AI_MODEL=claude-3-7-sonnet-latest pnpm test --spec ./specs/den-managed-openai-anthropic.spec.ts
  ```

## CI paths

- Windows MSI builds are produced by the GitHub Actions workflow `Build Windows MSI` in [`.github/workflows/build-windows-msi.yml`](../.github/workflows/build-windows-msi.yml).
- Hosted DEN deployment is handled by the GitHub Actions workflow `Deploy DEN` in [`.github/workflows/deploy-den.yml`](../.github/workflows/deploy-den.yml).
- `services/ai-gateway` is a transitional/internal reference implementation for this managed-AI runtime, not the hosted product boundary.

## Main endpoints

- Admin read/update:
  - `GET /admin/api/users/:userId/ai-access`
  - `PUT /admin/api/users/:userId/ai-access`
- User self-read:
  - `GET /api/me/ai-access`
- Veslo app local compatibility proxy:
  - `GET /ai-gateway/me/ai-access`
  - `POST /ai-gateway/providers/openai/v1/chat/completions`
  - `POST /ai-gateway/providers/anthropic/v1/messages`
