# Fix 60: Diagnostic Capture Dev Runtime Visibility

Date: 2026-07-20

## Problem

The user-controlled diagnostic capture could be compiled into a debug Tauri
runtime but remain absent from Settings. The launcher reused any Vite server on
the configured port that exposed the generic Veslo HTML marker. A stale server
from another checkout could therefore supply an older renderer to the current
native binary.

The Settings UI also silently swallowed a failed native status call. Its
`available` field meant only that the build included the feature, not that the
signed-in user had a valid production diagnostics context.

## Fix

- The Vite dev server exposes a checkout-derived identity at
  `/__veslo-dev-server`.
- `tauri-before-dev.mjs` reuses a server only when that identity matches its
  own canonical repository root. A mismatched or older server now fails fast
  with an explicit port/check-out message; it is never killed automatically.
- Native capture status now exposes `canStart`. It is true only for an enabled
  build with complete signed-in identity/token context and the fixed production
  Den endpoint. The renderer shows the capture control only in that state.
- A failed status command is surfaced in Settings with Retry and is written to
  bootstrap diagnostics. Native startup and a missing forwarder status request
  also emit narrow, searchable log messages.
- Starting a capture returns the native-computed `canStart` status, preventing
  a one-poll disappearance of the Settings card.

## Verification

```powershell
pnpm --filter @neatech/veslo-ui typecheck
# passed

pnpm --dir packages/app exec node --test --import=tsx/esm src/app/tests/pages/settings-user-diagnostic-capture.test.ts
# passed

node --test packages/desktop/scripts/tauri-before-dev.test.mjs
# passed: unrelated Vite and marked foreign-checkout Vite both fail closed

cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml diagnostic_capture --lib
# passed: 6 tests

git diff --check
# passed
```

## Manual dev behavior

After stopping an old dev/Vite process, start
`node scripts/dev-with-force-sidecars.mjs`. A signed-in user with the normal
production Veslo endpoint sees **Send a diagnostic capture** in Settings. If
port 5173 belongs to another checkout, launch fails explicitly instead of
opening a misleading stale Settings page.

## Status

Implemented and source-level verified. Tauri Pilot was intentionally not run.
