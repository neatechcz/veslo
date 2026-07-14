---
title: VSLO-274 Session Archives Non-JSON KISS Plan
date: 2026-07-13
status: pending-installed-desktop-validation
done: false
repository_snapshot: live veslo-main main worktree on 2026-07-14
issue: VSLO-274
base_branch: main
vslo274_01_transport_contract_done: true
vslo274_02_archive_scope_and_migration_done: true
vslo274_03_safe_diagnostics_done: true
vslo274_04_focused_automated_validation_done: true
vslo274_05_manual_desktop_validation_done: false
desktop_e2e: intentionally-excluded
---

# VSLO-274: Session Archives Must Not Parse Non-JSON Responses

## Status

The implementation is in `veslo-main` on `main`, with focused automated
validation recorded below. The plan is deliberately **not complete**: the
manual installed-desktop diagnostic gate remains required. The user excluded
Tauri Pilot/E2E from this slice; that decision does not waive the installed
desktop retest.

## Problem

The archive list boundary previously treated every non-empty response as JSON.
An upstream proxy page, plain-text error, or malformed JSON could therefore
throw a generic parse error before the archive owner knew what failed. At the
same time, archive loading and legacy migration needed to remain safe when the
resolved archive client or owner changed while a request was still in flight.

The first remediation also left three acceptance gaps: a diagnostic could not
identify the failing archive endpoint or actual MIME type, an older list could
overwrite a successful mutation within the same owner scope, and a background
archive-list failure could replace a different workflow's visible app error.

The failure must be understandable without sending an upstream HTML page,
URL, credentials, headers, or arbitrary server text to GlitchTip or the
desktop diagnostic fallback.

## KISS Boundary

In scope:

- strict JSON-response handling for the shared server transport, used by the
  archive-list call site;
- typed, sanitized archive-list response diagnostics;
- current-owner snapshot guards for archive reads, mutations, and legacy
  migration;
- conservative archive loading error recovery; and
- bounded browser monitoring plus desktop direct-diagnostic eligibility.

Out of scope:

- changing archive API routes, server persistence, archive record shape, or
  archive selection semantics;
- parsing HTML error pages, guessing a fallback response format, or adding a
  second archive transport;
- adding raw response excerpts to monitoring or native diagnostics;
- changing general binary/download transport behavior; and
- broad app, server, or archive UI refactors.

## Contract

### Transport

`requestJson` has one response policy:

1. An empty successful body resolves as `null`.
2. A non-empty response is JSON only when its canonical media type is
   `application/json` or `application/*+json`.
3. A non-empty response with another or missing media type raises
   `VesloServerError` with `code: "non_json_response"`.
4. A declared JSON response that cannot parse raises `VesloServerError` with
   `code: "malformed_json_response"`.
5. Existing valid-JSON non-2xx handling remains intact.

Only `session-archives:list` supplies the additional diagnostic operation.
The typed diagnostic contains only:

- fixed operation, request method, and response kind;
- sanitized request origin plus a query/fragment-free pathname;
- HTTP status, a low-cardinality media-type category, and the actual canonical
  content type (`missing` or `invalid` when no safe MIME token exists); and
- a bounded, redacted response preview.

The preview removes credentials, bearer values, sensitive assignments, URL
query values, and home paths before it is bounded. There is no raw full URL,
query string, header, token, or unbounded response body in the diagnostic.

### Archive owner and migration

The active archive scope is a structured key made from `(baseUrl, token,
ownerKey)`, not concatenated text. Every list, archive, unarchive, and legacy
migration operation captures a generation-bearing snapshot. A completion can
write archive state or migration storage only when that exact snapshot is
still current.

Within one current scope, a list captures the archive-record revision before
awaiting the server. A successful archive/unarchive response confirms the
snapshot and advances that revision, so a list that began earlier cannot
overwrite the mutation's records. This also means a successful mutation after
an initial list failure confirms the scope and can release legacy migration.

The first successful list confirms a snapshot. Until then:

- `sessionArchiveReady` remains false;
- a failed initial list cannot erase or mark legacy archive state migrated;
- a later connected server-health check can retry that same failed scope; and
- a background failure writes the archive-load message only when the global
  error is empty or already owned by this archive store; and
- success clears only the exact archive-load message, never another workflow's
  global error.

After a confirmed snapshot, a later list failure preserves the last confirmed
records and readiness while surfacing the retryable error.

### Diagnostics

The browser error-monitoring owner keeps low-cardinality fields as tags and
attaches the normalized endpoint, canonical MIME type, and redacted preview as
context. In a Tauri runtime, the archive store emits the same normalized
payload as `session-archives:load-failed`. The native direct Den fallback
allowlist accepts the `session-archives:` prefix, while retaining its existing
sanitization and source restrictions.

## Implemented Slices

### VSLO274-01 — Strict response contract

Implemented in the shared Veslo server transport and the archive-list domain
call site. Tests cover text/plain errors, arbitrary HTML-looking content,
missing/`+json` media types, malformed declared JSON, empty 204 success, a
sanitized request origin/pathname, the actual canonical content type, and a
bounded redacted preview.

### VSLO274-02 — Snapshot-safe archive state

Implemented in the session archive store. A client/owner switch clears
unconfirmed visible state and invalidates late responses. A same-scope record
revision now prevents an older list from overwriting a successful mutation.
Mutation success confirms the current scope, so legacy migration is not
blocked after a failed first list. The migration guards every asynchronous
write.

### VSLO274-03 — Safe recovery and diagnostics

Implemented in app composition, error monitoring, archive store diagnostics,
and the native direct-fallback allowlist. A background archive failure cannot
replace another workflow's visible error; recovery can clear only its own
visible error string after a successful current response.

## Automated Verification Required

Run from `packages/app`:

```powershell
corepack pnpm@10.27.0 exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/context/session-archive-store.test.ts src/app/tests/app-session-archives.test.ts src/app/tests/lib/error-monitoring.test.ts
```

Run from the repository root:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
corepack pnpm@10.27.0 --filter @neatech/veslo-ui build
```

Run from `packages/desktop/src-tauri`:

```powershell
cargo test debug_logs_forwarder
```

Expected focused regressions:

- a 404 `text/plain` archive list response produces a typed sanitized error;
- a diagnostic includes sanitized origin/pathname, canonical content type, and
  a bounded redacted real response preview;
- a stale old-owner response and an older same-owner list cannot overwrite a
  newer mutation or migration result;
- a successful mutation after a failed first list confirms the scope and does
  not leave legacy migration blocked;
- a background load failure cannot replace another workflow's global error;
- a successful retry clears only the archive store's own visible error; and
- `session-archives:load-failed` is direct-fallback eligible.

## Recorded Verification (2026-07-14)

- The focused archive regression command passed: 90 passed, 0 failed.
- UI typecheck and production build exited 0.
- `cargo test debug_logs_forwarder` passed 20 tests.
- `git diff --check` exited 0.
- The full `@neatech/veslo-ui` unit suite currently exits 1 with 15 failures
  outside the VSLO-274 archive transport/store/monitoring slice, including
  existing workspace/sidebar and session-send/page-modularization
  source-contract checks. This is a recorded repository baseline, not a
  passing handoff claim and not a reason to mark the focused slice failed.

## Manual Installed-Desktop Gate

The following validation remains required before this plan can be completed.
The user excluded Tauri Pilot/E2E only; that is not a waiver for this
installed-style retest:

1. In an installed desktop build with a signed-in user, make the archive list
   endpoint return a non-JSON error through the normal server/proxy path.
2. Confirm the archive UI shows the neutral connection/retry error, remains
   retryable after a health change, and does not lose previously confirmed
   archive records.
3. Inspect the GlitchTip context and native/DEN diagnostic payload. Confirm
   the sanitized origin/pathname, canonical content type, and bounded redacted
   preview are present without a query, credential, or raw secret.
4. Restore JSON success and confirm the exact archive error clears without
   clearing an unrelated global error.

## Completion Rule

Set `vslo274_04_focused_automated_validation_done: true` only after the final
focused commands pass. Set `vslo274_05_manual_desktop_validation_done: true`
only after the installed-build gate is evidenced. Set `done: true` only when
both flags are true. The Tauri Pilot/E2E exclusion must not be substituted for
the manual installed-desktop validation.
