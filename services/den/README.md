# Den Service

Control plane for hosted workers. Provides Better Auth, worker CRUD, and provisioning hooks.

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

## Development deploy environment

For development deployments, use `services/den/.env.development` as the source of truth.

Run Den with:

```bash
DOTENV_CONFIG_PATH=.env.development pnpm dev
```

If you need local `.env` compatibility for other tooling, copy it explicitly:

```bash
cp .env.development .env
```

## Environment

- `DATABASE_URL` MySQL connection URL
- `BETTER_AUTH_SECRET` 32+ char secret
- `VESLO_DEPLOYMENT_DOMAIN` root hosted deployment domain used to derive public `api`, `ai`, `app`, `admin`, and `workers` origins. Production defaults to `veslo.work`; staging should set `staging.veslo.work`.
- `BETTER_AUTH_URL` base URL for auth callbacks. Hosted environments can leave it blank to derive `https://api.<VESLO_DEPLOYMENT_DOMAIN>`.
- `WORKER_TOKEN_ENCRYPTION_KEY` optional key material for encrypting worker host/client tokens at rest (falls back to `BETTER_AUTH_SECRET` when unset)
- `GITHUB_CLIENT_ID` optional OAuth app client ID for GitHub sign-in
- `GITHUB_CLIENT_SECRET` optional OAuth app client secret for GitHub sign-in
- `LETTR_API_KEY` optional Lettr API key used to send Better Auth verification and password reset emails. It is required when `DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true`.
- `AUTH_EMAIL_ADDRESS` optional sender address for auth emails, for example `noreply@mail.veslo.work`. It is required when `DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true`.
- `AUTH_EMAIL_FROM_NAME` optional sender display name for auth emails, for example `Veslo`.
- `DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED` requires verified email for sign-in, bearer-session use, organization provisioning, and Managed AI access when set to `true`. DEN fails startup if this is enabled without both Lettr credentials above.
- `PORT` server port
- `CORS_ORIGINS` comma-separated list of trusted browser origins (used for Better Auth origin validation + Express CORS). Hosted environments can leave it blank to derive the app and AI Gateway origins from `VESLO_DEPLOYMENT_DOMAIN`. In production, wildcard `*` is rejected. Desktop CORS origins (`tauri://localhost`, `http://localhost:1420`, `http://localhost:1421`) are appended server-side to the Express CORS allowlist.
- `PROVISIONER_MODE` `stub`, `render`, or `owned-server`
- `WORKER_URL_TEMPLATE` template string with `{workerId}`
- `OWNED_WORKER_MANAGER_URL` internal worker-manager base URL when `PROVISIONER_MODE=owned-server`
- `OWNED_WORKER_MANAGER_TOKEN` bearer token shared with the owned-server worker manager
- `OWNED_WORKER_PUBLIC_DOMAIN_SUFFIX` public worker domain suffix for owned-server workers. Hosted environments can leave it blank to derive `workers.<VESLO_DEPLOYMENT_DOMAIN>`.
- `RENDER_API_BASE` Render API base URL (default `https://api.render.com/v1`)
- `RENDER_API_KEY` Render API key (required for `PROVISIONER_MODE=render`)
- `RENDER_OWNER_ID` Render workspace owner id (required for `PROVISIONER_MODE=render`)
- `RENDER_WORKER_REPO` repository URL used to create worker services (default `https://github.com/neatechcz/veslo`)
- `RENDER_WORKER_BRANCH` branch used for worker services
- `RENDER_WORKER_ROOT_DIR` render `rootDir` for worker services
- `RENDER_WORKER_PLAN` Render plan for worker services
- `RENDER_WORKER_REGION` Render region for worker services
- `RENDER_WORKER_VESLO_VERSION` orchestrator npm version installed in workers (`veslo-orchestrator`)
- `RENDER_WORKER_NAME_PREFIX` service name prefix
- `RENDER_WORKER_PUBLIC_DOMAIN_SUFFIX` optional domain suffix for worker custom URLs (e.g. `veslo.studio` -> `<worker-id>.veslo.studio`)
- `RENDER_CUSTOM_DOMAIN_READY_TIMEOUT_MS` max time to wait for vanity URL health before falling back to Render URL
- `RENDER_PROVISION_TIMEOUT_MS` max time to wait for deploy to become live
- `RENDER_HEALTHCHECK_TIMEOUT_MS` max time to wait for worker health checks
- `RENDER_POLL_INTERVAL_MS` polling interval for deploy + health checks
- `VERCEL_API_BASE` Vercel API base URL (default `https://api.vercel.com`)
- `VERCEL_TOKEN` Vercel API token used to upsert worker DNS records
- `VERCEL_TEAM_ID` optional Vercel team id for scoped API calls
- `VERCEL_TEAM_SLUG` optional Vercel team slug for scoped API calls (used when `VERCEL_TEAM_ID` is unset)
- `VERCEL_DNS_DOMAIN` Vercel-managed DNS zone used for worker records (default `veslo.studio`)
- `POLAR_FEATURE_GATE_ENABLED` enable cloud-worker paywall (`true` or `false`)
- `POLAR_API_BASE` Polar API base URL (default `https://api.polar.sh`)
- `POLAR_ACCESS_TOKEN` Polar organization access token (required when paywall enabled)
- `POLAR_PRODUCT_ID` Polar product ID used for checkout sessions (required when paywall enabled)
- `POLAR_BENEFIT_ID` Polar benefit ID required to unlock cloud workers (required when paywall enabled)
- `POLAR_SUCCESS_URL` redirect URL after successful checkout (required when paywall enabled)
- `POLAR_RETURN_URL` return URL shown in checkout (required when paywall enabled)
- `STRIPE_ORG_BILLING_ENABLED` enables Stripe-backed organization Managed AI billing when set to `true`
- `STRIPE_ORG_BILLING_SECRET_KEY` Stripe secret key for the current mode (`sk_test` for sandbox, live secret key for production)
- `STRIPE_ORG_BILLING_WEBHOOK_SECRET` Stripe webhook signing secret for `POST /v1/organization-billing/stripe/webhook`
- `STRIPE_ORG_BILLING_SUCCESS_URL`, `STRIPE_ORG_BILLING_CANCEL_URL`, `STRIPE_ORG_BILLING_PORTAL_RETURN_URL` billing return URLs
- `STRIPE_ORG_BILLING_BASIC_MONTHLY_PRICE_ID`, `STRIPE_ORG_BILLING_BASIC_ANNUAL_PRICE_ID`, `STRIPE_ORG_BILLING_EXTENDED_MONTHLY_PRICE_ID`, `STRIPE_ORG_BILLING_EXTENDED_ANNUAL_PRICE_ID` configured Stripe Price IDs
- `STRIPE_ORG_BILLING_TAX_MODE` `manual` or `stripe_tax`; defaults to `manual`
- `YOUTRACK_PROJECT_KEY` default YouTrack project key used for feedback issues
- `YOUTRACK_URL` YouTrack REST base URL, for example `https://neatech.myjetbrains.com`
- `YOUTRACK_TOKEN` YouTrack permanent token used by feedback projection
- `YOUTRACK_TIMEOUT_MS` timeout for one YouTrack REST request (default `20000`)
- `DEN_LOG_INGEST_TOKEN` internal bearer token required by `POST /v1/internal/debug-logs`
- `DEN_LOG_MASTER_KEY` master key material used to encrypt debug log payloads at ingest
- `DEN_LOG_MASTER_KEY_VERSION` operator-managed key version stored with each encrypted payload
- `DEN_LOG_RETENTION_DAYS` retention window for debug log events and accepted batch ids (default `30`)
- `DEN_DIAGNOSTIC_DUMP_ROOT` server filesystem directory for streamed diagnostic dump blobs (default `/data/diagnostic-dumps`)
- `DEN_DIAGNOSTIC_DUMP_MAX_BYTES` maximum accepted streamed diagnostic dump body size in bytes (default `52428800`)
- `MICROSOFT_CLIENT_ID` optional OAuth app client ID for the Microsoft connector
- `MICROSOFT_CLIENT_SECRET` optional OAuth app client secret for the Microsoft connector
- `MICROSOFT_REDIRECT_URI` optional OAuth callback URL override for the Microsoft connector. Hosted environments can leave it blank to derive the callback from `VESLO_DEPLOYMENT_DOMAIN`.
- `MICROSOFT_TOKEN_SECRET_KEY` 32+ char secret used to encrypt Microsoft OAuth tokens server-side
- `MICROSOFT_CONNECTOR_BASE_URL` optional Den public base URL used for Microsoft connector callbacks (defaults to the derived or configured `BETTER_AUTH_URL`)

Microsoft connector OAuth tokens are encrypted server-side before storage. Configure `MICROSOFT_TOKEN_SECRET_KEY` in production whenever Microsoft OAuth is enabled, and use key material distinct from other providers.

The initial Microsoft platform connector is read-only SharePoint. It uses
Veslo-managed Microsoft OAuth and stores user grants server-side; MCP catalog
metadata and local OpenCode config must not contain Microsoft client secrets,
access tokens, or refresh tokens.

## Auth setup (Better Auth)

Set `DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true`, `LETTR_API_KEY`, and `AUTH_EMAIL_ADDRESS` to require email verification and send verification and password-reset messages through Lettr. `AUTH_EMAIL_FROM_NAME` is optional. DEN fails closed at startup when verification is required but delivery is not configured. When verification is not required, blank or unset values disable email verification and password reset delivery.

The explicit desktop onboarding page (`GET /?desktopOnboarding=1`) supports the desktop browser auth flow end to end:

- sign in and sign up
- resend verification email
- forgot-password reset requests
- reset-password completion from emailed links

The default root (`GET /`) returns neutral service metadata. It does not serve an API demo or expose mutating control-plane actions.

### Verified organization provisioning

Email/password signup creates the authentication identity and sends verification first. Before verification, DEN does not create a new organization, register the user's domain, grant a trial, or assign usable Managed AI access. The successful verification callback runs an idempotent provisioner; trusted social-provider identities may run the same provisioner immediately only when their email is already verified.

Provisioning first reuses an existing active membership, otherwise joins an enabled exact-domain self-signup organization, or creates a new organization and exact-domain record. A new or renamed organization domain requires an active member whose verified email matches that normalized exact domain. Domain registration policy owns public/company-domain admission; provisioning and billing do not maintain a second provider classification.

Automatic trials are organization-scoped and last 14 days. DEN grants only when the organization has at least one registered domain and every current domain is unclaimed, then records immutable claims for all of them. Existing manual or automatic trials backfill claims without changing their expiry; later domains are consumed by that same trial. Claims survive domain deletion and reassignment, so a consumed domain cannot unlock another trial, and membership changes never reset or extend it. Active members inherit the organization entitlement. After verified active membership exists, standalone AI Gateway lazily creates missing user access as enabled and derives provider, model, and credential routing from global AI Infrastructure policy and capability evidence; explicit disablement is preserved. End users and DEN do not select a Managed AI model or provider.

Generate Better Auth schema (Drizzle):

```bash
npx @better-auth/cli@latest generate --config src/auth.ts --output src/db/better-auth.schema.ts --yes
```

Apply migrations:

```bash
pnpm db:generate
pnpm db:migrate
```

### Skill-registry package metadata

Each immutable skill version stores its canonical package metadata alongside the
archive. For legacy rows without that column, the search index is only an opaque
recovery hint: it is never trusted or persisted as a manifest, and a recovered
candidate is served only when its recomputed package SHA-256 exactly matches the
immutable version hash. Deploy the matching Drizzle migration before serving
existing package versions.

## API

- `GET /health`
- `GET /` neutral service metadata
- `GET /v1/me`
- `GET /v1/orgs`
- `GET /v1/orgs/:orgId/members`
- `GET /v1/orgs/:orgId/skills/catalog`
  - Authenticated and org-scoped.
  - Requires member access to the target organization.
  - Currently returns a mock `{ items: [] }` payload.
- `POST /v1/orgs/:orgId/members`
- `PATCH /v1/orgs/:orgId/members/:memberId`
- `DELETE /v1/orgs/:orgId/members/:memberId`
- `GET /v1/workers` (list recent workers for signed-in user/org)
  - For multi-org users, send `x-veslo-org-id` to select the active org.
- `POST /v1/workers`
  - Cloud launches return `202` quickly with worker `status=provisioning` and continue provisioning asynchronously.
  - Returns `402 payment_required` with Polar checkout URL when paywall is enabled and entitlement is missing.
  - Existing Polar customers are matched by `external_customer_id` first, then by email to preserve access for pre-existing paid users.
- `GET /v1/workers/:id`
  - Includes latest instance metadata when available.
- `POST /v1/workers/:id/tokens`
- `DELETE /v1/workers/:id`
  - Deletes worker records and attempts to suspend the backing cloud service when destination is `cloud`.
- `POST /v1/feedback`
  - Authenticated and org-scoped through `x-veslo-org-id`.
  - Accepts `{ title, description, userId?, userEmail?, orgId?, orgName?, context, screenshotStatus, screenshotDataUrl, screenshotMimeType }`.
  - Persists a canonical `feedback_report` row with `status=pending`; user/org identity is derived from the authenticated session and selected organization.
  - With the production projector configured, waits for the first YouTrack projection attempt before returning.
  - Returns `201` with `{ feedbackId, status: "projected", youtrackIssueId, youtrackIssueUrl }` after a YouTrack task is created or reused.
  - Returns `502 feedback_youtrack_projection_failed` if the report was persisted but the synchronous YouTrack projection did not produce a task number.
  - Successful projection stores `youtrackIssueId` + `youtrackIssueUrl` on the feedback row; failures write attempt history, schedule in-process retries, and remain eligible for the durable retry sweep after a Den restart.
  - Screenshot data is stored directly on the feedback row for v1 as base64 payload + mime type + byte size.
  - Rejects invalid payloads with `400 invalid_feedback_payload` and oversized screenshots with `413 feedback_screenshot_too_large`.
  - The feedback route uses a larger JSON body limit to support screenshot-bearing payloads without widening limits for unrelated endpoints.
- `POST /v1/internal/debug-logs`
  - Internal server-to-server route used by `veslo-server` debug-log shipping.
  - Requires `Authorization: Bearer <DEN_LOG_INGEST_TOKEN>`.
  - Accepts `{ batchId, events }`, stores encrypted event payloads, and returns `202 { acceptedBatchIds }`.
  - Repeated `batchId` or `Idempotency-Key` values are treated as accepted retries and do not duplicate event rows.
- `POST /v1/internal/diagnostic-dumps`
  - Internal server-to-server route used for large diagnostic dump uploads that should not be stored as debug-log JSON event payloads.
  - Requires `Authorization: Bearer <DEN_LOG_INGEST_TOKEN>`.
  - Streams the request body directly to `DEN_DIAGNOSTIC_DUMP_ROOT` and writes a sibling `.metadata.json` file with source, kind, byte count, SHA-256, and storage path.
  - The owned-server Compose stack mounts `${DIAGNOSTIC_DUMP_HOST_ROOT:-/srv/veslo/diagnostic-dumps}` into `${DEN_DIAGNOSTIC_DUMP_ROOT:-/data/diagnostic-dumps}`.
  - Uploads are bounded by `DEN_DIAGNOSTIC_DUMP_MAX_BYTES` and return `202 { ok: true, dump }` when accepted.
- `POST /v1/desktop-diagnostic-dumps`
  - User-authenticated desktop route for large diagnostic dump uploads from developer/support helpers.
  - Requires the signed-in user's Better Auth bearer token and `x-veslo-org-id`; no internal `DEN_LOG_INGEST_TOKEN` is exposed to client machines.
  - Streams the request body directly to `DEN_DIAGNOSTIC_DUMP_ROOT/desktop/<orgId>/<userId>/<YYYY-MM-DD>/` and writes a sibling `.metadata.json`.
  - Uploads are bounded by `DEN_DIAGNOSTIC_DUMP_MAX_BYTES` and return `202 { ok: true, dump }` when accepted.
- `POST /v1/organization-billing/stripe/webhook`
  - Stripe webhook endpoint for organization Managed AI billing.
  - Must receive raw request bytes for signature verification.
  - In local sandbox testing, forward this endpoint through Stripe CLI or a trusted tunnel and use the generated `whsec` value.
- `POST /v1/desktop-diagnostics`
  - Desktop fallback route used when local `veslo-server` cannot be trusted as the diagnostics carrier.
  - Requires the signed-in user's Better Auth bearer token and verifies the requested organization.
  - Accepts `{ batchId, installId, bootId, userId, orgId, workspaceId?, deliveryPath: "desktop-direct-fallback", events }`.
  - Only bootstrap diagnostics and `veslo-server-shell` stdout/stderr events are accepted; arbitrary UI/runtime logs are rejected.
  - Stores accepted events in the same encrypted debug-log store and returns `202 { ok: true, acceptedBatchIds }`.
- `GET /admin/api/debug-logs`
  - Platform-admin-only backend-first debug-log search API.
  - Supports metadata filters such as user, org, workspace, session, run, source, stream, level, and time range.
- `GET /admin/api/debug-logs/:eventId`
  - Platform-admin-only row detail API that decrypts and returns the payload for one stored debug-log event.
- `GET /admin/api/debug-logs/export`
  - Platform-admin-only JSONL export for the active debug-log filters.
- `POST /v1/desktop-auth/handoff`
  - Requires an authenticated browser session (Better Auth cookie). Returns a single-use, short-lived one-time code that the desktop app can exchange for credentials.
  - Respects `x-veslo-org-id` header to select the active organization.
- `POST /v1/desktop-auth/start`
  - Starts desktop browser authentication with PKCE.
  - Accepts `{ intent, redirectUri, state, codeChallenge, codeChallengeMethod: "S256" }` and returns `{ sessionId, authorizeUrl, expiresAt }`.
- `POST /v1/desktop-auth/exchange`
  - Accepts `{ code, sessionId, state, codeVerifier }` for PKCE exchange (legacy `{ code }` still supported).
  - Returns `{ tokenType, token, accessToken, expiresIn, user, org }`.
  - The code is consumed on first use and cannot be replayed.

## Deployment

Den production is deployed as part of the owned-server Compose stack through
`.github/workflows/deploy-owned-server.yml`. The workflow is manual-only
(`workflow_dispatch`); pushes and merges to `main` or `dev` must not deploy Den
by themselves.

See `docs/dev/cloud-deployments.md` for the canonical operator procedure.

Production secrets and service-specific values live in the server-side
owned-server env file referenced by `OWNED_SERVER_ENV_FILE`, not in a retired
Render deploy workflow. Render and Vercel worker-provisioning variables may
still be present as rollback or worker-domain configuration, but they are not
the production Den deployment mechanism.
