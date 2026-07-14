# Fix 49: VSLO-274 Session Archive Non-JSON Recovery

Date: 2026-07-13

Corrected: 2026-07-14

## Scope

Records the VSLO-274 archive-list recovery implementation in `veslo-main` on
`main`:

- strict non-empty JSON response handling at the archive transport boundary;
- current-owner-safe archive loading and legacy migration; and
- bounded browser/native diagnostics for archive-list response failures.

## Problem

The archive list path tried to parse every non-empty response as JSON. A
plain-text or HTML proxy response therefore surfaced as a generic parse error,
without a safe, structured diagnosis. A late result from a previous archive
client/owner could also race the current scope and legacy-local-storage
migration.

The first corrective version still could not identify the failing endpoint or
actual MIME type safely. It also allowed an older list response to overwrite a
successful mutation for the same owner, left a successful post-failure
mutation unconfirmed for migration purposes, and could overwrite an unrelated
global app error.

## Fix

- Archive-list responses now accept empty success bodies and only parse a
  non-empty body when its media type is `application/json` or
  `application/*+json`.
- Unexpected non-JSON and malformed declared-JSON responses become typed
  `VesloServerError` values with a normalized, sanitized diagnostic.
- The diagnostic includes a sanitized request origin/pathname, actual
  canonical content type, low-cardinality media category, and a bounded
  redacted response preview. It never includes headers, a full raw URL,
  credentials, query values, or an unbounded body.
- Archive state uses a structured `(base URL, token, owner)` snapshot and
  generation. A same-scope record revision prevents an older list completion
  from overwriting a successful archive/unarchive mutation. Mutation success
  confirms the snapshot, so it can release legacy migration after a failed
  first list.
- Initial-load failure remains retryable after a new connected health check;
  it does not consume legacy migration state or replace a different workflow's
  visible error. A successful archive response clears only the archive store's
  own visible error.
- GlitchTip receives low-cardinality archive tags plus safe endpoint/MIME/
  preview context. Tauri forwards the same normalized
  `session-archives:load-failed` diagnostic through the existing restricted
  direct-fallback lane.

## KISS Boundary

- No archive API route, server persistence shape, archive UI behavior, or
  archive selection semantics changed.
- No HTML fallback parser, second transport path, raw-response logging, or
  broad archive refactor was added.
- Binary/download response handling remains outside this fix.

## Verification

Recorded on 2026-07-14:

```powershell
# packages/app
corepack pnpm@10.27.0 exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/context/session-archive-store.test.ts src/app/tests/app-session-archives.test.ts src/app/tests/lib/error-monitoring.test.ts
# 90 passed, 0 failed

# repository root
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
corepack pnpm@10.27.0 --filter @neatech/veslo-ui build
# both exit 0

corepack pnpm@10.27.0 --filter @neatech/veslo-ui test:unit
# exit 1: current baseline has 15 failures outside the VSLO-274 archive
# transport/store/monitoring slice, including session-send/page-modularization
# source-contract checks. It is not a green-handoff claim.

# packages/desktop/src-tauri
cargo test debug_logs_forwarder
# 20 passed, 0 failed

git diff --check
# exit 0
```

Focused coverage includes text/plain and HTML-like responses, missing and
`+json` media types, malformed JSON, empty 204 success, safe monitoring
metadata, stale owner changes, same-owner list/mutation ordering, mutation
confirmation after an initial list failure, unrelated global-error ownership,
stale migration completion, and direct diagnostic eligibility.

## Validation Boundary

No manual installed-desktop run or Tauri Pilot/E2E scenario was performed for
this slice. Tauri Pilot/E2E is intentionally excluded, but the manual
installed-style GlitchTip and Den-fallback retest remains required. This note
does not treat either unperformed validation path as executed evidence.

## Status

The focused implementation work and focused automated verification are
recorded, but VSLO-274 remains `done: false` until the manual installed-style
diagnostic retest is evidenced. The full UI unit suite currently exits 1 with
15 non-VSLO-274 failures, so focused green tests do not make this a fully green
handoff claim.
