# Admin-Managed AI Access

This flow replaces the old user-managed BYOK provider/model settings in Veslo.

## Source of truth

- The canonical managed-AI admin UI is AI Gateway admin at `https://ai.veslo.work/admin`.
- When documentation, YouTrack tasks, or implementation notes say "admin" for VSLO-201 managed-AI operations, they mean the AI Gateway admin and its `/admin` subpages.
- There is no separate DEN admin UI for managed-AI operations. DEN can still own backend APIs and storage for auth, users, organizations, domains, invites, memberships, platform roles, and seat limits.
- DEN owns the effective AI access policy for each signed-in Den user.
- The policy is stored in the DEN-managed managed-AI policy tables and keyed by the Den `userId`.
- The policy controls:
  - `enabled`
  - `provider`
  - `credentialId` for providers that require a specific assigned credential
  - `defaultModel`
  - `allowedModels`

## Runtime flow

1. The user signs into the Veslo app with the existing browser-based Den flow.
2. The app calls `GET /ai-gateway/me/ai-access` on `packages/server`.
3. `packages/server` proxies that to the configured managed-AI service's `GET /api/me/ai-access` endpoint using the caller's Den bearer token. Production defaults use the standalone AI Gateway at `https://ai.veslo.work`.
4. The app treats the returned provider/model as read-only admin-managed state.
5. Prompt traffic still goes through the local Veslo server compatibility path.
6. The local Veslo server forwards managed prompt traffic to the configured managed-AI service.
7. The managed-AI service enforces provider/model policy, selects the platform credential, forwards upstream, and records usage/audit state.

## App behavior

- End users no longer get provider connect/disconnect controls.
- End users no longer get the Model settings tab or session model picker for DEN-managed providers.
- Settings now shows a read-only AI access summary.
- If no admin policy is assigned, the user can sign in but cannot send prompts.

## Admin behavior

- The AI Gateway admin `Users` page includes an `AI access` editor.
- The AI Gateway admin `Organization` page is shared by Platform Admins and Organization Admins. Platform Admins can switch the edited organization with the searchable organization selector on that page; Organization Admins only see their active organization and do not see the selector or seat-limit controls.
- Platform admins can enable/disable access, pick the assigned provider, set the default model, and optionally restrict allowed models.
- New DEN sign-ups are auto-assigned to Codex / ChatGPT inference with `gpt-5.5` when at least one eligible Codex OAuth inference credential exists. These rows are marked `auto_assigned`. When multiple credentials are eligible, DEN selects the one with the fewest active leases and uses deterministic tie-breaking.
- Admin edits are marked `admin_assigned`. Non-Codex admin assignments remain explicit credential choices.
- Assigned Codex access is lazily repaired on the next Codex request, including both `auto_assigned` and `admin_assigned` rows. If the assigned credential is missing, no longer healthy, revoked, permanently unavailable, or currently exhausted, DEN selects another healthy eligible Codex credential and updates the user's policy before routing the request. If no replacement exists, the request fails explicitly and the existing assignment is kept.
- Codex credential assignment options only include credentials whose provider is `codex_oauth`, whose stored state is `healthy`, and whose latest upstream status probe reports OK. A successful `codex | OK` probe is eligible even when rate-limit windows cannot be parsed; revoked, draining, unhealthy, invalid-grant, or probe-failing credentials are hidden from assignment.
- When no eligible Codex credential exists, user creation still succeeds and AI access remains unassigned until an eligible credential is available.
- The AI Gateway admin `Credentials` page is the place to connect/reconnect OpenAI and create/rotate shared Anthropic, Codex OAuth inference, and OpenAI-compatible credentials.
- Codex OAuth credentials must use a server-only `auth.json`; do not reuse the same ChatGPT login material from a workstation or another server process. If the Codex status probe reports that a refresh token was already used, the admin service marks that credential unhealthy so it is hidden from new assignments and eligible users can fail over to another healthy Codex credential. The Credentials page `Reconnect` action replaces the encrypted `auth.json` for the existing credential record and marks it healthy again, preserving credential id, usage, audit, alert, and assignment history.
- OpenAI-compatible credentials require a display name, custom HTTP(S) `/v1` base URL, and bearer API key. Local `http://localhost`, `http://127.0.0.1`, and `http://[::1]` URLs are allowed for development; hosted/non-loopback URLs must use HTTPS.
- OpenAI-compatible user access requires assigning a healthy `openai_compatible` credential. DEN does not automatically pick from a mixed custom-provider pool because the assigned credential determines the upstream base URL.
- When an OpenAI-compatible credential is selected in the user AI access editor, the admin UI asks that credential's `/models` endpoint for available model IDs and uses the result as suggestions for the default model field. Admins can still type a model manually when discovery fails or the upstream returns an empty list.
- The AI Gateway admin `Usage` page shows capacity first: remaining 5h and weekly Codex limits, measured credential count, and per-credential capacity visibility before historical usage drilldown.
- The AI Gateway admin `Usage` and `Credentials` pages show best-effort Codex upstream status for inference credentials. When the Codex probe returns parseable 5h and weekly windows, both pages show those windows and reset times. When the probe succeeds but no windows are parsed, both pages show `Codex OK, limits unknown` without making the credential ineligible. Authentication failures such as `invalid_grant`, reused refresh tokens, or 401 responses remain visible as unavailable upstream status and require reconnecting or rotating the credential.
- The AI Gateway admin `Users`, `Credentials`, `Alerts`, and `Audit` pages use modal detail/edit surfaces for selected rows. User and organization changes are applied only through explicit Save actions, not through immediate field changes.
- The hosted Codex status probe must run with bundled `@openai/codex` `0.137.0` or newer. Older CLI builds can complete a probe without writing subscription rate-limit snapshots, which leaves the admin pages in the best-effort `limits unknown` state.
- If a Codex probe reports that a specific model is unsupported for the credential's ChatGPT account, the credential remains usable and the unsupported model is removed from that credential's admin model choices. Admins should assign another listed Codex model for that credential instead of reconnecting it.

## Platform credential pools

- Upstream provider credentials are selected from platform-owned pools, not from the signed-in end user's ID.
- DEN resolves bindings from these owner IDs:
  - `platform:openai`
  - `platform:anthropic`
  - `platform:codex_oauth`
  - `platform:openai_compatible`
- Session ownership and usage attribution still stay tied to the real signed-in user.

OpenAI-compatible credentials store their upstream base URL and API key in the encrypted managed-AI secret store as platform-owned connection material. End users only receive the read-only provider/model assignment and never receive the upstream API key or base URL.

OpenAI-compatible proxy transport failures are reported separately from upstream HTTP error responses. A network, DNS, TLS, or invalid base-URL failure returns `openai_compatible_request_failed` with `reason: upstream_fetch_failed`; an upstream HTTP response failure returns `openai_compatible_upstream_error` without exposing upstream response bodies.

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

- Assign a live user to an OpenAI-compatible credential before a live custom-provider desktop roundtrip:

  ```bash
  cd packages/e2e && pnpm run check:live-admin-user -- --email michal.sara99@gmail.com --provider openai_compatible --credential-id <credential-id> --default-model <custom-model> --allowed-model <custom-model>
  VESLO_E2E_EXPECTED_MANAGED_AI_PROVIDER=openai_compatible VESLO_E2E_EXPECTED_MANAGED_AI_MODEL=<custom-model> pnpm test --spec ./specs/den-managed-openai-anthropic.spec.ts
  ```

## CI paths

- Windows MSI builds are produced by the GitHub Actions workflow `Build Windows MSI` in [`.github/workflows/build-windows-msi.yml`](../.github/workflows/build-windows-msi.yml).
- Production Den and AI Gateway services are deployed through the owned-server Compose workflow described in [Cloud Deployments](dev/cloud-deployments.md).
- `services/ai-gateway` is the hosted standalone AI Gateway service for the canonical managed-AI admin UI.

## Main endpoints

- Admin read/update:
  - `GET /admin/api/credentials/:credentialId/models`
  - `GET /admin/api/users/:userId/ai-access`
  - `PUT /admin/api/users/:userId/ai-access`
- User self-read:
  - `GET /api/me/ai-access`
- Veslo app local compatibility proxy:
  - `GET /ai-gateway/me/ai-access`
  - `POST /ai-gateway/providers/openai/v1/chat/completions`
  - `POST /ai-gateway/providers/anthropic/v1/messages`
  - `POST /ai-gateway/providers/codex_oauth/v1/chat/completions`
  - `POST /ai-gateway/providers/openai_compatible/v1/chat/completions`
- DEN hosted provider routes:
  - `POST /providers/openai/v1/chat/completions`
  - `POST /providers/anthropic/v1/messages`
  - `POST /providers/codex_oauth/v1/chat/completions`
  - `POST /providers/openai_compatible/v1/chat/completions`
