# Credential Alert Email Monitor Design

## Context

The AI Gateway already has two related but separate mechanisms:

- Credential and provider failures are represented as admin alerts, mostly through `credential_health_event` records and repository-backed alert read models.
- Codex capacity emails are sent by a dedicated monitor that builds synthetic Codex pool alerts for limit usage and limit visibility.

This leaves an operational gap: admins can see many credential/account failures in the admin portal, but email is currently limited to Codex capacity cases. The required behavior is that every platform admin receives an email when any active account or credential reaches a fault state.

## Goals

- Email all platform admins on the first occurrence of any active credential/account fault.
- Cover every active credential/account, whether or not it currently has sessions or user assignments.
- Deduplicate and throttle repeated notifications so a provider or network outage does not spam admins.
- Keep inference request paths lightweight and resilient.
- Reuse existing mail delivery, audit logging, and admin alert concepts where possible.

## Non-Goals

- Do not send per-request email for client validation errors, policy errors, unauthenticated requests, or unsupported request parameters.
- Do not replace the existing Codex capacity alert monitor.
- Do not expose credential secrets or token material in email content or audit records.

## Recommended Approach

Add a generic `CredentialAlertEmailMonitor` alongside the existing Codex capacity monitor.

The existing Codex capacity monitor should remain responsible for synthetic Codex pool capacity alerts. The new monitor should be responsible for repository-backed credential/account alerts. Both monitors should share the same Lettr-based mailer, platform-admin recipient resolution, and audit-based deduplication pattern.

Keeping the monitors separate reduces risk to existing Codex capacity behavior and gives each monitor a clear input:

- Codex capacity monitor: computes capacity and limit visibility from Codex status probes.
- Credential alert monitor: reads unresolved admin alerts generated from credential/account health events.

## Data Flow

1. A request, probe, or admin action detects a credential/account fault.
2. The existing path writes a health event or repository-backed admin alert.
3. The credential alert email monitor periodically loads unresolved admin alerts.
4. The monitor filters alerts to credential/account faults.
5. The monitor resolves platform-admin recipients from DEN.
6. If DEN lookup fails or returns no recipients, the monitor falls back to `AI_GATEWAY_ALERT_EMAIL_RECIPIENTS`.
7. For each alert and recipient, the monitor checks audit-backed dedupe and throttle keys.
8. The monitor sends one email through the existing admin alert mailer.
9. The monitor records send success or failure in audit.

The monitor should run outside the inference request path. Lettr or DEN failures must not fail user inference requests.

## Email Scope

Send email for every active credential/account fault, including:

- Credential state transitions to `unhealthy`, `degraded`, `draining`, or `revoked`.
- Codex refresh token reuse or refresh failure.
- `invalid_grant`, `invalid_api_key`, `authentication_error`, `revoked_token`, and similar authentication failures.
- Provider network/proxy failures such as connect timeout, DNS failure, connection reset, and `fetch failed`.
- OpenAI-compatible upstream fetch failures.
- No eligible credential for a provider or credential pool when represented as a credential/account alert.
- Healthy Codex credential records whose upstream status makes them ineligible.
- Administrative quarantine, delete, or other non-healthy state transitions that create health events.

Do not send credential-alert email for:

- Resolved alerts.
- Request validation errors.
- Client auth failures.
- AI access policy failures.
- Unsupported request parameters such as `temperature`.
- Normal 80% or 90% Codex capacity warnings unless the existing capacity monitor policy changes separately.

## Recipients

Primary recipients are platform admins from DEN.

Fallback recipients come from `AI_GATEWAY_ALERT_EMAIL_RECIPIENTS`. The fallback is intentionally retained for incidents where DEN is unavailable or returns no platform admin emails.

If neither source produces recipients, the monitor should log a clear warning and skip sending.

## Dedupe And Throttle

Use two levels of suppression:

- Primary dedupe: `alertId + recipient`.
- Secondary throttle: `credentialId + normalizedReason + recipient`, with a 24-hour window.

This ensures a new alert emails every admin once, while repeated health events for the same credential and reason are suppressed during an outage.

Send again when:

- The fault reason changes.
- The credential is a different credential.
- The throttle window expires.

Do not mark failed sends as deduplicated. A failed recipient should be retried on the next monitor run.

## Email Content

Email content should include:

- Alert title and severity.
- Provider and credential/account name when available.
- Credential id.
- Fault reason.
- First seen and last seen times when available.
- A short runbook.
- A link or pointer to the admin portal alerts/credentials area when available.

Email content must not include secret material, OAuth tokens, API keys, or full upstream response bodies.

## Error Handling

- Mail delivery is best-effort per recipient.
- Success and failure are written to audit.
- Failed recipients are retried in later runs.
- DEN recipient lookup failures fall back to configured alert recipients.
- Alert read failures are logged and retried on the next run.
- Mailer failures are logged as one aggregate monitor failure per run, with per-recipient audit entries.

## Testing Plan

Add focused tests for:

- Sending email for an active credential health alert.
- Not sending email for a resolved alert.
- Not sending twice for the same `alertId + recipient`.
- Throttling repeated alerts with the same `credentialId + normalizedReason + recipient`.
- Sending again for a different fault reason.
- Resolving recipients from platform admins.
- Falling back to configured recipients when platform admin lookup fails or returns none.
- Retrying failed recipient sends without marking them deduplicated.
- Preserving existing Codex capacity email tests.
- Proving that provider proxy network failure can produce an admin alert that the new monitor emails.

After deployment, run a production-safe synthetic health event or test credential alert and verify that all platform admins receive the expected test email without breaking real inference.
