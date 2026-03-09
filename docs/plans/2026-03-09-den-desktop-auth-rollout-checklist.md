# Desktop Auth Handoff Rollout Checklist

## Dev deployment targets

- Den API: Render development service deployed by `.github/workflows/deploy-den.yml`
- Web auth UI: `packages/web` deployment pointed at the same Render Den URL
- Desktop app: `VITE_VESLO_LOGIN_URL_DEV` must point at the web auth deployment

## Required config

- Render `DEN_CORS_ORIGINS` must include the web auth deployment origin used for `?desktopOnboarding=1`
- Web `DEN_API_BASE` must point at the Render Den development URL
- Web `DEN_AUTH_ORIGIN` should match the same Render Den development URL
- Web `NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL` should match the deployed web auth origin
- Desktop `VITE_VESLO_LOGIN_URL_DEV` should match the deployed web auth origin

## Manual verification

1. Deploy `services/den` to Render dev and confirm `POST /v1/desktop-auth/handoff` and `POST /v1/desktop-auth/exchange` are reachable.
2. Deploy `packages/web` against the same Den dev backend.
3. Launch desktop with `VITE_VESLO_LOGIN_URL_DEV` set to the web deployment URL.
4. Start from a reset desktop state with no `veslo.den.auth` local storage value.
5. Confirm desktop lands on `Sign in to Veslo`.
6. Click `Sign in to Veslo`, complete auth in browser, and verify the browser redirects to `veslo://auth-complete?code=...`.
7. Confirm desktop consumes the code, stores `veslo.den.auth`, and continues into local onboarding/session flow.
8. Restart desktop and confirm stored auth is validated before local onboarding continues.

## Notes

- No workflow change is required for this feature. Existing Den deployment already syncs env vars and deploys on `dev`.
- No new secrets are required if the existing `VITE_VESLO_LOGIN_URL_*`, `DEN_API_BASE`, and `DEN_CORS_ORIGINS` values are configured correctly.
