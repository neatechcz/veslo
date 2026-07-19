# User-controlled diagnostic capture — implementation record

Status: implemented

## Scope

A signed-in production-installer or debug Tauri-runtime user can explicitly start one diagnostic capture from Settings. The native desktop process owns a 120-second, 2 MiB capture window. GlitchTip is out of scope.

## Contracts

- Capture is available in every debug Tauri runtime, so team members can opt in while helping diagnose an issue. Release builds are compile-time gated by both `VESLO_USER_DIAGNOSTIC_CAPTURE=1` and `VESLO_DEPLOYMENT_DOMAIN=veslo.work`; a missing or mismatched value fails closed. Every upload still requires a signed-in user and `https://api.veslo.work`.
- The capture uses a separate persistent queue and journal, never the legacy local `/debug-logs` route. It is uploaded only to Den `/v1/desktop-diagnostics` using the signed-in bearer token.
- Journal identity is the user and organization that started capture. A changed signed-in identity produces a terminal `identity_changed` state and destroys queued material instead of retrying under the new user.
- Event `captureId` is a UUID persisted as unencrypted Den query metadata. Existing unmarked desktop fallback events retain their narrow legacy allowlist; only UUID-marked events use the broader capture allowlist.
- Process output is copied through the native sanitizer before it enters the capture queue. The sanitizer covers query values, Bearer credentials, assignment/header/JSON secret forms, cookies and API-key aliases. Capture accepts only selected desktop process/UI output sources.
- Each persisted segment uses a deterministic `capture:<captureId>:<firstEventId>` batch and `Idempotency-Key`, so retrying a timeout cannot duplicate an accepted segment.
- The journal records captured/pending/accepted events and bytes plus retention, budget, delivery and identity drops, terminal reason and persisted retry backoff. Queue reads/writes/rewrites share one lock, corruption is terminal rather than silently dropped, and a missing summary cannot become `uploaded`. It emits a capture-marked summary outside the 2 MiB payload budget. Restart terminates an active capture as `interrupted`; queue retention expires after 24 hours.

## Validation

- Rust compilation and focused native tests.
- Den route tests for legacy compatibility, UUID-marked capture acceptance and invalid capture rejection.
- UI typecheck and Drizzle migration journal validation.

## Follow-up

The release lane still needs its first installed-binary smoke run.
