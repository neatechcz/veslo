# Veslo Cloud App (`packages/web`)

Frontend for `app.veslo.neatech.com`.

## What it does

- Signs up / signs in users against Den service auth.
- Launches cloud workers via `POST /v1/workers`.
- Handles paywall responses (`402 payment_required`) and shows Polar checkout links.
- Uses a Next.js proxy route (`/api/den/*`) to reach `api.veslo.neatech.com` without browser CORS issues.

## Local development

1. Install workspace deps from repo root:
   `pnpm install`
2. Run the app:
   `pnpm --filter @neatech/veslo-web dev`
3. Open:
   `http://localhost:3005`

### Optional env vars

- `DEN_API_BASE` (server-only): upstream API base used by proxy route.
  - default: `https://api.veslo.neatech.com`
- `DEN_AUTH_ORIGIN` (server-only): Origin header sent to Better Auth endpoints.
  - default: `https://den-control-plane-veslo.onrender.com`
- `NEXT_PUBLIC_OPENWORK_APP_CONNECT_URL` (client): Base URL for "Open in App" links.
  - Example: `https://veslo.neatech.com/app`
  - The web panel appends `/connect-remote` and injects worker URL/token params automatically.
- `NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL` (client): Canonical URL used for GitHub auth callback redirects.
  - default: `https://app.veslo.neatech.com`
- `NEXT_PUBLIC_POSTHOG_KEY` (client): PostHog project key used for Den analytics.
  - set this to the same project key used by `packages/landing`
- `NEXT_PUBLIC_POSTHOG_HOST` (client): PostHog host URL.
  - default: `https://us.i.posthog.com`
- `LOOPS_API_KEY` (server-only): Loops API key for signup contact capture.

## Deploy on Vercel

Recommended project settings:

- Root directory: `packages/web`
- Framework preset: Next.js
- Build command: `next build`
- Output directory: `.next`
- Install command: `npm install` (or `pnpm install`)

Then assign custom domain:

- `app.veslo.neatech.com`
