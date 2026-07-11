# Fix 46: Transcript, Reconnect, And Exit Truthfulness

Date: 2026-07-10

## Scope

This checkpoint records three narrow stabilization fixes:

- failed transcript reads now remain visibly unavailable and retryable,
- incomplete SSE reconnect catch-up no longer reports a false healthy state,
- desktop shutdown now leaves enough attribution to identify why the app or
  Tauri child exited.

The fixes were written because these failure paths could previously look like
valid empty content, a successful reconnect, or an unexplained application
exit. That made the UI less predictable and made runtime failures harder to
diagnose.

## Problem

### Transcript read failures could look like an empty conversation

`session-selection-controller.ts` already had a scoped
`historyUnavailable` state and the session UI already rendered it with a Retry
action. Generic live transcript failures and exceptions thrown by the offline
transcript reader did not consistently enter that state.

As a result, the selected session could contain no rendered messages even
though the application had not established that its transcript was empty.

### Reconnect catch-up could report a false healthy state

After an SSE outage, reconnect catch-up refreshed the status and transcript of
sessions that had been running. Per-session status or message failures were
handled softly, but the catch-up still ended by emitting `live` and showing the
`reconnected` notice.

This made a partially refreshed transcript look fully synchronized.

### Desktop exits lacked final attribution

The Tauri run loop stopped managed services for window close, exit request, and
final exit events, but the logs did not identify which event initiated the
cleanup or which managed process ids were involved. The `tauri-dev.mjs`
wrapper also forwarded the child result to `process.exit(...)` without first
recording its exit code and signal.

## Fix

### Retryable transcript failure state

- A failed live transcript read now marks the selected session history as
  unavailable with reason `live-transcript-read-failed`.
- An exception from the offline transcript reader now returns an unavailable
  history result with reason `offline-transcript-read-failed`.
- Both paths preserve the session and workspace scope.
- The existing history-unavailable UI and Retry action are reused; no parallel
  error component or retry mechanism was added.
- Regression tests cover both live and offline reader failures and verify that
  no fake transcript is hydrated.

### Honest reconnect catch-up state

- Status refresh and foreground transcript refresh failures are counted as
  critical catch-up failures.
- Transcript refresh failures now emit the scoped
  `sse-reconnect-catchup-messages-failed` diagnostic.
- An incomplete catch-up emits `degraded` with
  `messagesMayBeDelayed: true` and the latest failure message.
- The incomplete path does not emit `live` and does not show the
  `reconnected` notice.
- Successful catch-up behavior is unchanged.

### Desktop exit attribution

- The Tauri run loop now distinguishes `exit_requested`, `exit`, and
  `window_close_requested` cleanup reasons.
- A before-cleanup line records the reason, timestamp, and whether the build is
  a debug build.
- An after-cleanup line records the same attribution together with the managed
  process ids returned by `stop_managed_services(...)`.
- The dev wrapper records the Tauri child timestamp, exit code, and signal
  before forwarding the result through `process.exit(...)`.
- Cleanup behavior itself remains unchanged.

## KISS Boundary

The implementation reuses the existing unavailable-history, reconnect-state,
trace, and shutdown-cleanup contracts:

- no new transcript retry subsystem,
- no new reconnect scheduler or retry loop,
- no new desktop process supervisor,
- no shutdown behavior change beyond diagnostic logging.

The existing SSE runtime hardening plan was updated only to mark its exit
attribution step, SRSH00, complete.

## Verification

Run on 2026-07-10:

```powershell
cd packages/app
pnpm exec node --test --import=tsx/esm src/app/tests/context/session-selection-controller.test.ts src/app/tests/context/session-event-stream.test.ts
# pass 44, fail 0

pnpm typecheck
# exit 0

cd ../desktop
node --test scripts/tauri-dev.test.mjs scripts/tauri-config.test.mjs
# pass 14, fail 0

cd ../..
rustfmt --edition 2021 --check --config skip_children=true packages/desktop/src-tauri/src/lib.rs
# exit 0

cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml
# exit 0

git diff --check -- packages/app/src/app/context/session-selection-controller.ts packages/app/src/app/context/session-event-stream.ts packages/app/src/app/tests/context/session-selection-controller.test.ts packages/app/src/app/tests/context/session-event-stream.test.ts packages/desktop/src-tauri/src/lib.rs packages/desktop/scripts/tauri-dev.mjs packages/desktop/scripts/tauri-dev.test.mjs packages/desktop/scripts/tauri-config.test.mjs docs/plans/2026-07-08-sse-runtime-shutdown-hardening-implementation-plan.md
# exit 0, CRLF conversion warnings only
```

## Status

The three stabilization fixes are implemented and covered by focused tests,
TypeScript typechecking, desktop source-contract tests, Rust formatting, and a
Rust compile check.
