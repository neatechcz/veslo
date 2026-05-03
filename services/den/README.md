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
- `BETTER_AUTH_URL` base URL for auth callbacks
- `WORKER_TOKEN_ENCRYPTION_KEY` optional key material for encrypting worker host/client tokens at rest (falls back to `BETTER_AUTH_SECRET` when unset)
- `GITHUB_CLIENT_ID` optional OAuth app client ID for GitHub sign-in
- `GITHUB_CLIENT_SECRET` optional OAuth app client secret for GitHub sign-in
- `LETTR_API_KEY` optional Lettr API key used to send Better Auth verification and password reset emails. Blank or unset values disable email verification and password reset delivery.
- `AUTH_EMAIL_ADDRESS` optional sender address for auth emails, for example `noreply@mail.veslo.work`. Blank or unset values disable email verification and password reset delivery.
- `AUTH_EMAIL_FROM_NAME` optional sender display name for auth emails, for example `Veslo`.
- `PORT` server port
- `CORS_ORIGINS` comma-separated list of trusted browser origins (used for Better Auth origin validation + Express CORS). In production, wildcard `*` is rejected. Desktop CORS origins (`tauri://localhost`, `http://localhost:1420`, `http://localhost:1421`) are appended server-side to the Express CORS allowlist.
- `PROVISIONER_MODE` `stub` or `render`
- `WORKER_URL_TEMPLATE` template string with `{workerId}`
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
- `YOUTRACK_PROJECT_KEY` default YouTrack project key used for feedback issues
- `YOUTRACK_MCP_COMMAND` command used to start the installed YouTrack MCP server on the Den host
- `YOUTRACK_MCP_ARGS` optional JSON string array of extra MCP command arguments
- `YOUTRACK_MCP_TIMEOUT_MS` timeout for one MCP tool call (default `20000`)
- `YOUTRACK_MCP_WIRE_PROTOCOL` stdio framing for the MCP command: `content-length` by default, or `line` for the local wrapper used by the live desktop smoke
- `YOUTRACK_MCP_URL` optional remote MCP URL forwarded to child MCP wrappers that read it from the environment
- `YOUTRACK_MCP_TOKEN` optional remote MCP token forwarded to child MCP wrappers that read it from the environment

## Auth setup (Better Auth)

Set `LETTR_API_KEY` and `AUTH_EMAIL_ADDRESS` to enable email verification and password reset delivery through Lettr. `AUTH_EMAIL_FROM_NAME` is optional. Blank or unset values disable email verification and password reset delivery.

The root onboarding page (`GET /?desktopOnboarding=1`) now supports the desktop browser auth flow end to end:

- sign in and sign up
- resend verification email
- forgot-password reset requests
- reset-password completion from emailed links

Generate Better Auth schema (Drizzle):

```bash
npx @better-auth/cli@latest generate --config src/auth.ts --output src/db/better-auth.schema.ts --yes
```

Apply migrations:

```bash
pnpm db:generate
pnpm db:migrate
```

## API

- `GET /health`
- `GET /` demo web app (sign-up + auth + worker launch)
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
  - Successful projection stores `youtrackIssueId` + `youtrackIssueUrl` on the feedback row; failures write attempt history and schedule in-process retries.
  - Screenshot data is stored directly on the feedback row for v1 as base64 payload + mime type + byte size.
  - Rejects invalid payloads with `400 invalid_feedback_payload` and oversized screenshots with `413 feedback_screenshot_too_large`.
  - The feedback route uses a larger JSON body limit to support screenshot-bearing payloads without widening limits for unrelated endpoints.
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

The workflow `.github/workflows/deploy-den.yml` updates Render env vars and deploys the service only when it is run manually from GitHub Actions. Pushes and merges to `main` or `dev` must not deploy Den by themselves.

The workflow also patches the configured Render control-plane service with `autoDeploy: no` on every manual run. Keep native Render Auto-Deploy off for this service.

The deployment workflow preserves existing Render YouTrack projector variables when matching GitHub secrets/vars are not provided, then writes them back during the env sync. This prevents a manual Den deploy from silently disabling feedback projection.

See `docs/dev/cloud-deployments.md` for the canonical operator procedure.

Required GitHub Actions secrets:

- `RENDER_API_KEY`
- `RENDER_DEN_CONTROL_PLANE_SERVICE_ID`
- `RENDER_OWNER_ID`
- `DEN_DATABASE_URL`
- `DEN_BETTER_AUTH_SECRET`
- `DEN_LETTR_API_KEY` when hosted verification or password reset emails should be enabled

Optional GitHub Actions secrets (enable GitHub social sign-in):

- `DEN_GITHUB_CLIENT_ID`
- `DEN_GITHUB_CLIENT_SECRET`

Optional GitHub Actions variable:

- `DEN_RENDER_WORKER_REPO` (defaults to `https://github.com/<github.repository>` in workflow, or `https://github.com/neatechcz/veslo` fallback)
- `DEN_RENDER_WORKER_PLAN` (defaults to `standard`)
- `DEN_RENDER_WORKER_VESLO_VERSION` (defaults to `0.11.113` and is used for `veslo-orchestrator`)
- `DEN_CORS_ORIGINS` (defaults to `https://app.veslo.neatech.com,https://api.veslo.neatech.com,<render-service-url>`)
- `DEN_RENDER_WORKER_PUBLIC_DOMAIN_SUFFIX` (defaults to `veslo.studio`)
- `DEN_RENDER_CUSTOM_DOMAIN_READY_TIMEOUT_MS` (defaults to `240000`)
- `DEN_VERCEL_API_BASE` (defaults to `https://api.vercel.com`)
- `DEN_VERCEL_TEAM_ID` (optional)
- `DEN_VERCEL_TEAM_SLUG` (optional, defaults to `prologe`)
- `DEN_VERCEL_DNS_DOMAIN` (defaults to `veslo.studio`)
- `DEN_POLAR_FEATURE_GATE_ENABLED` (`true`/`false`, defaults to `false`)
- `DEN_POLAR_API_BASE` (defaults to `https://api.polar.sh`)
- `DEN_POLAR_SUCCESS_URL` (defaults to `https://app.veslo.neatech.com`)
- `DEN_POLAR_RETURN_URL` (defaults to `DEN_POLAR_SUCCESS_URL`)
- `DEN_AUTH_EMAIL_ADDRESS` sender email value for hosted auth emails, for example `noreply@mail.veslo.work`
- `DEN_AUTH_EMAIL_FROM_NAME` optional sender display name for hosted auth emails, for example `Veslo`
- `DEN_DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED` (`true`/`false`, defaults to `false`)

Required additional secret when using vanity worker domains:

- `VERCEL_TOKEN`

For hosted auth-email testing:

- set `DEN_LETTR_API_KEY` and `DEN_AUTH_EMAIL_ADDRESS` to enable verification and password-reset email delivery on Render
- set `DEN_AUTH_EMAIL_FROM_NAME` when you want the sender to display as `Veslo`
- set `DEN_DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true` only when you want the desktop handoff to hard-block unverified users
- if `DEN_DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true`, both `DEN_LETTR_API_KEY` and `DEN_AUTH_EMAIL_ADDRESS` must be configured or the deploy workflow will fail validation
- if those GitHub repo inputs are blank, the deploy workflow preserves the current Render values for `LETTR_API_KEY`, `AUTH_EMAIL_ADDRESS`, `AUTH_EMAIL_FROM_NAME`, and `DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED` instead of clearing them
