# Admin-Managed AI Access

This flow replaces the old user-managed BYOK provider/model settings in Veslo.

## Source of truth

- The canonical managed-AI admin UI is AI Gateway admin at `/admin` on the derived AI Gateway origin: `https://ai.veslo.work/admin` in production, or `https://ai.staging.veslo.work/admin` when `VESLO_DEPLOYMENT_DOMAIN=staging.veslo.work`.
- When documentation, YouTrack tasks, or implementation notes say "admin" for VSLO-201 managed-AI operations, they mean the AI Gateway admin and its `/admin` subpages.
- There is no separate DEN admin UI for managed-AI operations. DEN can still own backend APIs and storage for auth, users, organizations, domains, invites, memberships, platform roles, and seat limits.
- The standalone AI Gateway owns effective AI access for each signed-in Den user.
- User assignment controls:
  - `enabled`
  - `provider`
  - `credentialId` for providers that require a specific assigned credential
- The global platform model policy separately controls the enabled backend models and exactly one active model.

## Runtime flow

1. The user signs into the Veslo app with the existing browser-based Den flow.
2. The app calls `GET /ai-gateway/me/ai-access` on `packages/server`.
3. `packages/server` proxies that to the configured managed-AI service's `GET /api/me/ai-access` endpoint using the caller's Den bearer token. Defaults derive the standalone AI Gateway from `VESLO_DEPLOYMENT_DOMAIN`, using `https://ai.veslo.work` for production and `https://ai.staging.veslo.work` for staging unless a full URL override is set.
4. The app treats the returned provider/model as read-only admin-managed state.
5. Prompt traffic still goes through the local Veslo server compatibility path.
6. The local Veslo server forwards managed prompt traffic to the configured managed-AI service.
7. The managed-AI service enforces provider/model policy, selects the platform credential, forwards upstream, and records usage/audit state.

Local Veslo server runtime state for this proxy path is owned by
`packages/server/src/ai-gateway-runtime-owner.ts`. The HTTP transport remains
wired through `packages/server/src/server.ts`.

## Global model policy rollout

Deploy the global-model transition in this order:

1. Deploy schema, repository, and API support for the global policy while retaining the historical per-user model columns.
2. Configure and verify exactly one active platform model.
3. Enable runtime enforcement and the simplified user-assignment contracts that contain only access, provider, and credential state.
4. Remove per-user model controls from the app and admin UI.
5. Remove the historical database columns only in a separately approved cleanup after the rollback window closes.

The retained `default_model` and `allowed_models_json` values are rollback-only data. New DEN access records store neutral compatibility values, updates preserve historical values without changing them, and the standalone AI Gateway never uses those columns as runtime model authority. Production DEN provider inference routes are retired and return `den_managed_ai_inference_retired`; the old per-user policy path is available only through an explicit rollback-only runtime mode. A temporary DEN self-access endpoint may return an injected gateway-owned `effectiveModel`; when no gateway policy resolver is configured, it fails explicitly instead of falling back to the retained columns. Account creation and eligible credential assignment remain available even when the platform model policy has not yet been configured, but inference remains blocked until the active policy exists.

## App behavior

- End users no longer get provider connect/disconnect controls.
- End users no longer get the Model settings tab or session model picker for DEN-managed providers.
- Settings now shows a read-only AI access summary.
- If no admin policy is assigned, the user can sign in but cannot send prompts.
- The desktop app caches a non-secret local proof of the user's managed-AI policy for 3 days in `${VESLO_APP_DATA_DIR or app_data_dir()}/access-proofs.v1.json`. This avoids repeatedly calling `GET /ai-gateway/me/ai-access` during normal app flow and restart without adding UI. The file stores policy metadata only; Den and gateway bearer tokens are never persisted there.
- Generated project OpenCode config must also stay non-secret: provider routing points at the local Veslo server and references `{env:VESLO_OPENCODE_SERVER_CLIENT_TOKEN}` for local auth. Managed gateway bearer tokens stay in local Veslo server runtime memory and are attached by the proxy.
- Den/AI Gateway remain authoritative for inference. Prompt traffic still uses the current Den auth or local Veslo server token at runtime, and failed/no-access refreshes clear the cached proof for that identity.

## Admin behavior

- The AI Gateway admin `Users` page includes an `AI access` editor.
- The AI Gateway admin `Organization` page is shared by Platform Admins and Organization Admins. Platform Admins can switch the edited organization with the searchable organization selector on that page; Organization Admins only see their active organization and do not see the selector or seat-limit controls.
- Platform admins can enable/disable user access, pick the assigned provider and credential, and manage the global enabled/active model policy under AI Infrastructure. User assignments contain no model fields.
- New DEN sign-ups may be auto-assigned to Codex / ChatGPT inference when the read-only Gateway policy projection reports `codex_oauth` as the active provider and at least one eligible Codex OAuth inference credential exists. These rows are marked `auto_assigned`. A non-Codex, missing, or unavailable policy projection skips assignment without failing account creation. The active platform model applies to assigned users like every other managed-AI user.
- Admin edits are marked `admin_assigned`. Non-Codex admin assignments remain explicit credential choices.
- Assigned Codex access is lazily repaired by the canonical AI Gateway on the next Codex request, including both `auto_assigned` and `admin_assigned` rows. If the assigned credential is missing, no longer healthy, revoked, permanently unavailable, or currently exhausted, the Gateway selects another healthy eligible Codex credential and updates the user's policy before routing the request. DEN compatibility reads are mutation-free. If no replacement exists, the request fails explicitly and the existing assignment is kept.
- Codex credential assignment options only include credentials whose provider is `codex_oauth`, whose stored state is `healthy`, and whose latest upstream status probe reports OK. A successful `codex | OK` probe is eligible even when rate-limit windows cannot be parsed; revoked, draining, unhealthy, invalid-grant, or probe-failing credentials are hidden from assignment.
- When no eligible Codex credential exists, user creation still succeeds and AI access remains unassigned until an eligible credential is available.
- The DEN admin and standalone AI Gateway admin `Credentials` pages are the place to connect/reconnect OpenAI and create/rotate shared Anthropic, Codex OAuth inference, and OpenAI-compatible credentials.
- Codex OAuth credentials are refreshed from the selected credential detail. Admins can rename the credential, prepare a short-lived local upload command, run `node scripts/admin/codex-auth-upload.mjs` from a Veslo checkout, complete Codex device login locally, and upload the resulting `auth.json` through the one-time URL. The helper stores local Codex login material under `~/.veslo/codex-auth/<credential>` by default, validates that `id_token`, `access_token`, `refresh_token`, and `account_id` are present, uploads the full JSON to the selected admin service, and the service replaces the encrypted secret for the existing credential record while preserving credential id, usage, audit, alert, and assignment history.
- New Codex OAuth credentials can be added from the standalone AI Gateway `Credentials` page with `Prepare Codex account upload`. That creates the same short-lived local helper command without a credential id. After the user completes Codex device login locally, the server reads the account email from the uploaded `id_token`, creates a new shared `codex_oauth` platform credential named `<email> Codex`, and stores the uploaded auth JSON as the encrypted secret. Uploads that do not contain a usable account email are rejected instead of creating an ambiguously named credential.
- Codex OAuth credentials should use a dedicated server/runtime ChatGPT account. Do not reuse the same login material in another long-running runtime. If the Codex status probe reports that a refresh token was already used, the admin service marks that credential unhealthy so it is hidden from new assignments and eligible users can fail over to another healthy Codex credential.
- OpenAI-compatible credentials require a display name, custom HTTP(S) `/v1` base URL, and bearer API key. Local `http://localhost`, `http://127.0.0.1`, and `http://[::1]` URLs are allowed for development; hosted/non-loopback URLs must use HTTPS.
- OpenAI-compatible user access requires assigning a healthy `openai_compatible` credential. DEN does not automatically pick from a mixed custom-provider pool because the assigned credential determines the upstream base URL.
- OpenAI-compatible credential model discovery is infrastructure evidence for the global platform model catalog and compatibility checks; it is not exposed as a user-assignment model field.
- The hosted admin `Usage` page shows recorded usage for every credential, including credentials with zero recorded traffic.
- The hosted admin `Usage` and `Credentials` pages show best-effort Codex upstream status for inference credentials. The Codex status probe runs the gateway's default Codex model so it does not inherit an unsupported CLI default model from the bundled Codex runtime. When the Codex probe returns parseable 5h and weekly windows, both pages show those windows and reset times. When the probe succeeds but no windows are parsed, both pages show `Codex OK, limits unknown` without making the credential ineligible. Any healthy Codex credential with unknown or unavailable limits creates a Codex capacity visibility alert so admins are notified even when other credentials still report measurable limits. Authentication failures such as `invalid_grant`, reused refresh tokens, or 401 responses remain visible as unavailable upstream status and require reconnecting or rotating the credential.
- If a Codex probe reports that a specific model is unsupported for the credential's ChatGPT account, the credential remains usable and the unsupported model is removed from that credential's admin model choices. Admins should assign another listed Codex model for that credential instead of reconnecting it.
- Provider proxy network failures, such as container outbound DNS, firewall/NAT, or upstream reachability timeouts, create a critical admin alert titled `AI inference upstream is unreachable` linked to the affected credential.
- The hosted admin UI shows a bottom-right connection status whenever it is waiting for `/admin/api` responses. If the browser cannot reach the backend, the status remains visible and tells the admin that it is still trying to connect.

## Admin alert emails

Standalone AI Gateway sends credential/account fault emails to active platform admins resolved from DEN through the internal `GET /v1/internal/platform-admin-recipients` route. Configure the same bearer value as `DEN_AI_GATEWAY_INTERNAL_TOKEN` in DEN and `AI_GATEWAY_DEN_INTERNAL_TOKEN` in AI Gateway. `AI_GATEWAY_ALERT_EMAIL_RECIPIENTS` is only a fallback when the DEN recipient lookup is temporarily unavailable, and it remains the recipient source for Codex capacity emails.

Email delivery requires the shared Lettr mailer env (`LETTR_API_KEY`, `AUTH_EMAIL_ADDRESS`, `AUTH_EMAIL_FROM_NAME`) in the AI Gateway service. Credential alert polling defaults to `AI_GATEWAY_CREDENTIAL_ALERT_EMAIL_INTERVAL_MS=60000`; Codex capacity alert polling defaults to `AI_GATEWAY_CODEX_CAPACITY_ALERT_EMAIL_INTERVAL_MS=300000`.

Credential/account fault emails are sent for the first active unresolved alert per credential/account reason and recipient, including upstream auth failures, quota/rate-limit failures, provider network failures, unreachable OpenAI-compatible/Codex transports, and assigned credential records that can no longer be resolved. Repeats for the same credential, same normalized reason/title, and same recipient are throttled for 24 hours. Later healthy credential-health events resolve earlier fault alerts for the same credential, so recovered faults do not email again when the throttle expires. Resolved alerts, recovered alerts, request validation errors, missing gateway session/token errors, and policy-denied requests do not send email. Codex capacity emails are handled by the separate capacity monitor, not the per-credential alert monitor; that monitor emails for high/critical capacity thresholds and for partial or total loss of Codex limit visibility.

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
  cd packages/e2e && pnpm run check:live-admin-user -- --email michal.sara99@gmail.com --provider openai
  VESLO_E2E_EXPECTED_MANAGED_AI_PROVIDER=openai VESLO_E2E_EXPECTED_MANAGED_AI_MODEL=gpt-4o-mini pnpm test --spec ./specs/den-managed-openai-anthropic.spec.ts
  ```

- Assign a live user to Anthropic before a live Anthropic desktop roundtrip:

  ```bash
  cd packages/e2e && pnpm run check:live-admin-user -- --email michal.sara99@gmail.com --provider anthropic
  VESLO_E2E_EXPECTED_MANAGED_AI_PROVIDER=anthropic VESLO_E2E_EXPECTED_MANAGED_AI_MODEL=claude-3-7-sonnet-latest pnpm test --spec ./specs/den-managed-openai-anthropic.spec.ts
  ```

- Assign a live user to an OpenAI-compatible credential before a live custom-provider desktop roundtrip:

  ```bash
  cd packages/e2e && pnpm run check:live-admin-user -- --email michal.sara99@gmail.com --provider openai_compatible --credential-id <credential-id>
  VESLO_E2E_EXPECTED_MANAGED_AI_PROVIDER=openai_compatible VESLO_E2E_EXPECTED_MANAGED_AI_MODEL=<custom-model> pnpm test --spec ./specs/den-managed-openai-anthropic.spec.ts
  ```

- Validate a local Codex `auth.json` without uploading:

  ```bash
  VESLO_AI_ADMIN_BASE="${VESLO_AI_ADMIN_BASE:-https://ai.veslo.work/admin}"
  node scripts/admin/codex-auth-upload.mjs --upload-url "$VESLO_AI_ADMIN_BASE/api/credentials/codex-auth-upload/<token>" --credential-id <credential-id> --credential-name "<credential name>" --auth-json-path ~/.veslo/codex-auth/<credential>/auth.json --dry-run --yes
  ```

- Validate a new Codex account upload command without creating the server credential:

  ```bash
  VESLO_AI_ADMIN_BASE="${VESLO_AI_ADMIN_BASE:-https://ai.veslo.work/admin}"
  node scripts/admin/codex-auth-upload.mjs --upload-url "$VESLO_AI_ADMIN_BASE/api/credentials/codex-auth-upload/<token>" --credential-name "New Codex account" --auth-json-path ~/.veslo/codex-auth/new-codex-account/auth.json --dry-run --yes
  ```

- Run the guarded live Playwright check that opens the selected admin environment, selects the Václav Codex credential, prepares the upload session, and runs the local helper. By default it validates locally and skips the upload; add `E2E_LIVE_ADMIN_CODEX_AUTH_UPLOAD_COMMIT=1` only when the test should replace the selected environment's credential secret.

  ```bash
  cd packages/e2e
  E2E_LIVE_ADMIN_CODEX_AUTH_UPLOAD=1 \
  VESLO_E2E_ADMIN_TOKEN=<admin-token> \
  VESLO_E2E_CODEX_AUTH_JSON_PATH=~/.veslo/codex-auth/vaclav-codex/auth.json \
  pnpm run test:live-codex-auth-upload
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
- Retired DEN hosted provider routes (return `410 den_managed_ai_inference_retired` in the production runtime):
  - `POST /providers/openai/v1/chat/completions`
  - `POST /providers/anthropic/v1/messages`
  - `POST /providers/codex_oauth/v1/chat/completions`
  - `POST /providers/openai_compatible/v1/chat/completions`
