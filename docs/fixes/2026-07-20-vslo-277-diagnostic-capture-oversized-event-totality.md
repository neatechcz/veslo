# VSLO-277: Diagnostic capture oversized event totality

Status: implemented; full repository quality gate currently blocked by unrelated worktree failures.

## Problem

`UserDiagnosticCapture::build_batches()` could omit the first queued event that
exceeded the preferred 224 KiB batch guard. `flush()` would then retain that
event as pending without sending it, scheduling a retry, or classifying a
terminal drop.

The normal capture source remains bounded to 16 KiB diagnostic text, so this
was a defensive queue-correctness gap rather than a reachable production
showstopper. It still mattered for malformed local queues and future callers.

## Fix

- Added delivery eligibility validation before posting: IDs are trimmed,
  non-empty, and unique; each serialized event must fit the 2 MiB per-event
  delivery eligibility cap.
- Invalid, duplicate, unserializable, or over-budget queue content now clears
  the queue and ends in `delivery_rejected`, with `dropped_delivery`, zero
  pending events, and a specific terminal reason.
- Replaced the partial batch-size estimate with one shared serializer for both
  sizing and the exact bytes sent to Den. Batch ID is consistently derived from
  the first event in the actual batch and used as the idempotency key.
- An otherwise eligible event above the ordinary 224 KiB batch guard is sent as
  an explicit one-event batch. Ordinary batches remain bounded by 500 events
  and 224 KiB measured on the real request body.
- Extracted an internal flush poster seam so successful delivery can be tested
  without network access.

## Regression coverage

- Native tests cover oversized batch ordering, the 500-event boundary,
  successful queue removal/status finalization, and terminal drops for missing,
  whitespace-normalized duplicate, and over-budget events.
- Den route coverage posts a UUID-marked capture event above 224 KiB and below
  2 MiB, confirming the 10 MiB desktop diagnostics route accepts it.

## Verification

Passed:

- `cargo fmt --all -- --check`
- `cargo test user_diagnostic_capture --lib` (9 tests)
- `pnpm --filter @neatech/den exec tsx --test test/desktop-diagnostics-route.test.ts` (6 tests)
- `pnpm check:types`
- `pnpm check:architecture`
- `git diff --check`

Not green, outside this fix:

- `pnpm lint` has pre-existing app reactivity findings.
- Rust Clippy stops on `runtime_preferences.rs` (`needless_bool`).
- The full Den suite has an existing organization-billing expectation mismatch
  for `manualAccessUnlimited`.
