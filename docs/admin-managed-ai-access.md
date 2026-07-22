# Admin-Managed AI Access

This flow replaces the old user-managed BYOK provider/model settings in Veslo.

## Source of truth

- The canonical managed-AI admin UI is AI Gateway admin at `/admin` on the derived AI Gateway origin: `https://ai.veslo.work/admin` in production, or `https://ai.staging.veslo.work/admin` when `VESLO_DEPLOYMENT_DOMAIN=staging.veslo.work`.
- When documentation, YouTrack tasks, or implementation notes say "admin" for VSLO-201 managed-AI operations, they mean the AI Gateway admin and its `/admin` subpages.
- The embedded DEN managed-AI admin is retired. DEN `/admin` page requests redirect to the matching standalone AI Gateway `/admin` page; DEN keeps backend APIs and storage for auth, users, organizations, domains, invites, memberships, platform roles, and seat limits.
- The standalone AI Gateway owns effective AI access for each signed-in Den user.
- The only user assignment control is `enabled`. Provider, credential, and model routing are technical Gateway state derived from platform infrastructure, not client input.
- The global platform model policy may retain an infrastructure catalog of enabled backend models, but exactly one global active model is the exclusive runtime model authority.
- There are no custom per-user or per-organization Managed-AI model policies.
  A user-supplied model cannot switch the runtime model. The Gateway uses the
  global active model and rejects a conflicting model, provider, or credential
  override.

## Runtime flow

1. The user signs into the Veslo app with the existing browser-based Den flow.
2. The app calls `GET /ai-gateway/me/ai-access` on `packages/server` with the Den bearer token and authenticated organization id.
3. `packages/server` proxies that to the standalone AI Gateway's `GET /api/me/ai-access` endpoint. Defaults derive the gateway from `VESLO_DEPLOYMENT_DOMAIN`, using `https://ai.veslo.work` for production and `https://ai.staging.veslo.work` for staging unless a full URL override is set.
4. The app treats the returned provider and `effectiveModel` as Gateway-managed state. Self-access keeps `selectableModels` empty because users cannot select an alternative model.
5. Prompt traffic still goes through the local Veslo server compatibility path.
6. The local Veslo server forwards managed prompt traffic to standalone AI Gateway.
7. AI Gateway evaluates the provider request in this order: authenticated session, DEN billing entitlement, user enablement/provider assignment, the single global active model, then credential selection and brokerage. Denial or unavailable billing stops before user access, model, lease, credential, or provider work.
8. AI Gateway forwards the global active model upstream and records usage/audit state against the resolved user, organization, session, and credential. A user request cannot switch that model.

Credential selection and rotation are separate from model selection. The single global active model fixes the provider/model pair; credential health, capability, assignment, and capacity decide which compatible platform credential can serve it.

The same automatic-access service is entered behind three distinct guards:

- Inference first requires an authenticated session and positive DEN organization entitlement; only then can a missing AI-access record be created lazily as enabled.
- Self-access (`GET /api/me/ai-access` and its exact-user aliases) runs after an authenticated session without a billing entitlement check. It can initialize a missing record so settings can show the effective access state even when inference billing is unavailable.
- An organization-qualified admin GET runs only after admin authentication, validation of the target's active membership, and organization authorization, without a billing entitlement check because it reads administrative state rather than authorizing inference.

The Gateway derives enabled access from the global platform model policy and current credential capability evidence. An explicitly disabled record is preserved unchanged and never re-enabled by any lazy path.

Local Veslo server runtime state for this proxy path is owned by
`packages/server/src/ai-gateway-runtime-owner.ts`. The HTTP transport remains
wired through `packages/server/src/server.ts`.

## Global model policy rollout

Deploy the global-model transition in this order:

1. Deploy schema, repository, and API support for the global policy while retaining the historical per-user model columns.
2. Configure and verify exactly one active platform model.
3. Enable runtime enforcement and the simplified user-assignment contracts that accept only the access toggle.
4. Remove per-user model controls from the app and admin UI.
5. Remove the historical database columns only in a separately approved cleanup after the rollback window closes.

Historical per-user `provider`, `default_model`, and `allowed_models_json` values are retained only for history or rollback. They are not runtime authority in the standalone AI Gateway: enabled reads and inference resolve the current global active model, and self-access exposes no alternative selectable models. DEN provider inference defaults to `denInferenceMode: "retired"` and returns `den_managed_ai_inference_retired`. The old per-user policy path is available only when a caller explicitly constructs the DEN proxy with the code-level dependency `denInferenceMode: "legacy_rollback"`; there is currently no operator environment switch for that mode. DEN compatibility reads stay mutation-free. The canonical standalone Gateway performs lazy automatic assignment at the guarded Gateway entry points instead of depending on DEN signup-time provider resolution. A direct legacy DEN enable request requires an injected server-side automatic-access resolver and fails closed with `user_ai_access_automatic_resolution_unavailable` when that resolver is absent.

## App behavior

- End users no longer get provider connect/disconnect controls.
- End users do not get provider connect/disconnect controls or arbitrary model,
  provider, or credential entry.
- Settings shows the read-only managed AI access summary. Self-access returns the global active model as `effectiveModel` and an empty `selectableModels` array, so it does not expose alternative selectable models.
- A missing assignment can become enabled lazily on authenticated self-access without a billing check. Inference performs the separate DEN entitlement check before it reaches the same initializer. Infrastructure can still be unavailable when no compatible credential exists; that is an explicit availability failure, not an implicit user denial.
- The desktop app caches a non-secret local proof of the user's managed-AI policy for 3 days in `${VESLO_APP_DATA_DIR or app_data_dir()}/access-proofs.v1.json`. This avoids repeatedly calling `GET /ai-gateway/me/ai-access` during normal app flow and restart without adding UI. The file stores policy metadata only; Den and gateway bearer tokens are never persisted there.
- Generated project OpenCode config must also stay non-secret: provider routing points at the local Veslo server and references `{env:VESLO_OPENCODE_SERVER_CLIENT_TOKEN}` for local auth. Managed gateway bearer tokens stay in local Veslo server runtime memory and are attached by the proxy.
- The authenticated Den organization id follows the same local runtime-only boundary. Access priming binds it to the actor token in memory; provider proxying strips caller-supplied organization headers and injects the bound id. It is never written to OpenCode provider config.
- Standalone AI Gateway is authoritative for inference, AI-access assignments,
  the single global active model, credentials, and usage.
  DEN remains authoritative for identity, organization membership, and billing
  entitlement. Prompt traffic still carries the current DEN auth or local Veslo
  server token at runtime, and failed/no-access refreshes clear the cached proof
  for that identity.

## Admin behavior

- The admin portal's fail-closed loading and request-ownership rules are canonicalized in [Admin Data Loading and Scope Isolation](features/admin-data-loading-and-scope-isolation.md). Route-owned data is cleared before destination requests begin; blurred loading treatment applies only to neutral skeletons, never to previously loaded records.
- Every canonical admin dialog is constrained to the available window width and must not introduce horizontal scrolling. Wider editors reflow their fields when the window narrows; DEN `/admin` redirects to this AI Gateway-owned surface rather than maintaining a second modal implementation.
- The organization-scoped AI Gateway admin `AI Access` workspace includes the member modal. The member modal contains only the AI Access switch and, for platform administrators, the platform admin permission switch. Platform Users remains global and does not perform organization-scoped AI-access mutations.
- Platform pages (`/admin`, `/admin/organizations`, `/admin/ai-infrastructure`, `/admin/ai-infrastructure/usage`, `/admin/ai-infrastructure/alerts`, `/admin/platform-users`, and `/admin/audit`) never retain organization context. Organization context exists only inside `/admin/organizations/:orgId/...`; its selector preserves the current organization subpage, and organization admins see only authorized organizations.
- Organization and platform admins can enable or disable user access only inside the explicit Organization AI Access workspace. The admin API accepts only `{ enabled }` and rejects provider, credential, model, redemption, and other technical routing fields. AI Infrastructure retains the platform controls for models and credentials used for all users.
- Global model-policy loads are generation-scoped and abortable. A response from an older request, a previous admin route, or a load that began before the draft became dirty cannot replace the current editor draft or publish a stale error.
- The UI invokes admin AI-access reads and writes only from the canonical Organization AI Access workspace and uses the organization-qualified `GET` and `PUT` routes under `/admin/api/organizations/:organizationId/members/:userId/ai-access`. Server authorization does not trust or require the browser route or referrer: it independently requires managed-AI admin capability, access to the organization named in the API path, and exactly one active target-user membership returned by the scoped organization-member API. Missing, inactive, duplicate, or malformed membership evidence fails closed. The former unqualified `/admin/api/users/:userId/ai-access` routes are removed.
- For writes, all fallible response preparation completes before the Gateway transaction; the transaction then persists the assignment and its success audit together. The audit uses the authenticated admin user id and validated organization id; if the audit insert fails, the policy write rolls back and the request fails.
- Organization Audit is a fail-closed facade over DEN-owned organization events and Gateway-owned AI-access events. The Gateway fetches both sources, labels each row with its source, assigns a stable source-qualified id, merges newest-first, and applies one final hard limit. It never returns a partial history when either source is unavailable. Mutations owned by DEN are audited only in DEN and are not duplicated as synthetic Gateway rows.
- Email/password signup waits for verification and active DEN organization membership; it does not choose provider, credential, or model routing. A subsequent authenticated self-access can initialize the assignment without billing, inference can initialize it only after positive entitlement, and an organization-qualified admin read can initialize it only after scoped membership and role authorization. Trusted already-verified social identity follows the same membership prerequisite.
- Admin edits change only enablement and are marked `admin_assigned`; enabling re-derives current technical routing server-side.
- Assigned Codex access is lazily repaired by the canonical AI Gateway on the next Codex request, including both `auto_assigned` and `admin_assigned` rows. If the assigned credential is missing, no longer healthy, revoked, permanently unavailable, or currently exhausted, the Gateway selects another healthy eligible Codex credential and updates the user's policy before routing the request. DEN compatibility reads are mutation-free. If no replacement exists, the request fails explicitly and the existing assignment is kept.
- Automatic Codex routing uses credentials whose provider is `codex_oauth`, whose stored state is `healthy`, and whose capability evidence supports the active platform model. A successful `codex | OK` probe remains eligible even when rate-limit windows cannot be parsed; revoked, draining, unhealthy, invalid-grant, or probe-failing credentials are excluded.
- When no eligible credential exists, the enabled access record remains enabled with infrastructure unavailable until platform infrastructure becomes eligible.
- The standalone AI Gateway admin `Credentials` page is the only managed-AI admin surface for connecting, reconnecting, creating, and rotating platform credentials. DEN has no separate managed-AI credential UI.
- Codex OAuth credentials are refreshed from the selected credential detail. Admins can rename the credential, prepare a short-lived local upload command, run `node scripts/admin/codex-auth-upload.mjs` from a Veslo checkout, complete Codex device login locally, and upload the resulting `auth.json` through the one-time URL. The helper stores local Codex login material under `~/.veslo/codex-auth/<credential>` by default, validates that `id_token`, `access_token`, `refresh_token`, and `account_id` are present, uploads the full JSON to the selected admin service, and the service replaces the encrypted secret for the existing credential record while preserving credential id, usage, audit, alert, and assignment history.
- New Codex OAuth credentials can be added from the standalone AI Gateway `Credentials` page with `Prepare Codex account upload`. That creates the same short-lived local helper command without a credential id. After the user completes Codex device login locally, the server reads the account email from the uploaded `id_token`, creates a new shared `codex_oauth` platform credential named `<email> Codex`, and stores the uploaded auth JSON as the encrypted secret. Uploads that do not contain a usable account email are rejected instead of creating an ambiguously named credential.
- Codex OAuth credentials should use a dedicated server/runtime ChatGPT account. Do not reuse the same login material in another long-running runtime. If the Codex status probe reports that a refresh token was already used, the admin service marks that credential unhealthy so it is hidden from new assignments and eligible users can fail over to another healthy Codex credential.
- OpenAI-compatible credentials require a display name, custom HTTP(S) `/v1` base URL, and bearer API key. Local `http://localhost`, `http://127.0.0.1`, and `http://[::1]` URLs are allowed for development; hosted/non-loopback URLs must use HTTPS.
- OpenAI-compatible user access requires a healthy compatible `openai_compatible` credential selected by the Gateway from platform infrastructure; the credential still determines the upstream base URL.
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
- Standalone AI Gateway resolves credential bindings from these owner IDs:
  - `platform:openai`
  - `platform:anthropic`
  - `platform:codex_oauth`
  - `platform:openai_compatible`
- Session ownership and usage attribution still stay tied to the real signed-in user.

OpenAI-compatible credentials store their upstream base URL and API key in the encrypted managed-AI secret store as platform-owned connection material. End users only receive the read-only provider/model assignment and never receive the upstream API key or base URL.

OpenAI-compatible proxy transport failures are reported separately from upstream HTTP error responses. A network, DNS, TLS, or invalid base-URL failure returns `openai_compatible_request_failed` with `reason: upstream_fetch_failed`; an upstream HTTP response failure returns `openai_compatible_upstream_error` without exposing upstream response bodies.

## Manual setup

Before this flow works in a live environment, make sure the global active model and healthy compatible provider bindings exist for its platform pool. If the managed-AI tables still only contain legacy per-user BYOK bindings, prompts will fail with `no_eligible_bindings`.

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

  This check may use the global Platform Users directory for lookup. Pass
  `--organization-id <organization-id>` when the intended organization is known
  instead of relying on automatic active-membership resolution.

- Before a live inference roundtrip, configure the single global active model and compatible credential in AI Infrastructure, then enable the member with the Organization AI Access toggle. Do not pass provider, credential, or model assignment fields for the user; the API rejects them and the user cannot switch the global runtime model.

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
  - `GET /admin/api/organizations/:organizationId/members`
  - `GET /admin/api/organizations/:organizationId/members/:userId/ai-access`
  - `PUT /admin/api/organizations/:organizationId/members/:userId/ai-access`
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
