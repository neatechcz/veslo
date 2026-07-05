# Veslo Cloud App (`packages/web`)

Frontend for the Veslo cloud app, normally `app.veslo.work` in production.

## What it does

- Signs up / signs in users against Den service auth.
- Launches cloud workers via `POST /v1/workers`.
- Handles paywall responses (`402 payment_required`) and shows Polar checkout links.
- Uses a Next.js proxy route (`/api/den/*`) to reach the Den API derived from the deployment domain without browser CORS issues.

## Local development

1. Install workspace deps from repo root:
   `pnpm install`
2. Run the app:
   `pnpm --filter @neatech/veslo-web dev`
3. Open:
   `http://localhost:3005`

### Optional env vars

- `DEN_API_BASE` (server-only): upstream API base used by proxy route.
  - default: `https://api.<deployment-domain>`, where `deployment-domain` is `NEXT_PUBLIC_VESLO_DEPLOYMENT_DOMAIN`, `VESLO_DEPLOYMENT_DOMAIN`, or `veslo.work`
- `NEXT_PUBLIC_VESLO_DEPLOYMENT_DOMAIN` / `VESLO_DEPLOYMENT_DOMAIN`: root deployment domain used to derive Den and app origins.
  - production default: `veslo.work`
  - staging example: `staging.veslo.work`
- `DEN_AUTH_ORIGIN` (server-only): Origin header sent to Better Auth endpoints.
  - default: the derived Den API origin
- `NEXT_PUBLIC_OPENWORK_APP_CONNECT_URL` (client): Base URL for "Open in App" links.
  - Example: `https://app.veslo.work/app`
  - The web panel appends `/connect-remote` and injects worker URL/token params automatically.
- `NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL` (client): Canonical URL used for GitHub auth callback redirects.
  - default: `https://app.<deployment-domain>`
- `NEXT_PUBLIC_POSTHOG_KEY` (client): PostHog project key used for Den analytics.
  - set this to the same project key used by `packages/landing`
- `NEXT_PUBLIC_POSTHOG_HOST` (client): PostHog host URL.
  - default: `https://us.i.posthog.com`
- `LOOPS_API_KEY` (server-only): Loops API key for signup contact capture.

## Desktop onboarding mode

When the web app is opened with the `?desktopOnboarding=1` query parameter (typically launched by the desktop app), it enters a special flow:

1. The user signs in / signs up as usual.
2. If email verification is required, the verification callback preserves the desktop onboarding query context and returns the user to the same onboarding route after verification succeeds.
3. Once authenticated and an organization is resolved, the web app calls `POST /v1/desktop-auth/handoff` to obtain a one-time code.
4. The browser redirects to `veslo://auth-complete?code=<code>`, handing control back to the desktop app which exchanges the code for credentials via `POST /v1/desktop-auth/exchange`.

## Deploy on Vercel

Recommended project settings:

- Root directory: `packages/web`
- Framework preset: Next.js
- Build command: `next build`
- Output directory: `.next`
- Install command: `npm install` (or `pnpm install`)

Then assign custom domain:

- `app.veslo.work`
