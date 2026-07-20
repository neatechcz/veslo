# User-controlled diagnostic capture

Implemented a consent-based diagnostic capture in Settings for production installers and debug Tauri runtimes.

- The desktop owns the 120-second and 2 MiB limits, redacts process-output copies, and persists a per-capture queue/journal with identity, delivery, retention and terminal-state accounting.
- Capture data bypasses the local server path and reaches Den only through the signed-in user's bearer token with stable idempotency keys.
- Den preserves `captureId` as UUID query metadata while keeping existing unmarked fallback diagnostics compatible.
- Release builds are fail-closed behind the production build flag; debug Tauri runtimes intentionally expose the opt-in control so team members can send their own cloud diagnostics.

## Self-review fixes

- Serialized capture-event bytes, not only payload bytes, enforce the 2 MiB limit; the final summary remains explicitly outside that payload budget.
- Capture queue appends, reads and rewrites share one lock. Corrupt, missing or unwritable queues become truthful terminal states instead of being silently discarded or reported as uploaded.
- A successful direct delivery removes the queue exactly once. Retryable failures retain a persisted exponential backoff; terminal 4xx rejection records a delivery failure without retrying indefinitely.
- Capture startup and delivery are pinned to `https://api.veslo.work`, so a runtime Den API override cannot redirect production diagnostic material to another host.
- The native sanitizer now redacts JSON/header/colon secret forms, cookies and API-key aliases in the capture copy.
- The temporary Tauri Pilot scenario and its E2E production compile inputs were removed; desktop runtime validation was explicitly deferred.
- `scripts/dev-with-force-sidecars.mjs` now explicitly passes the native production capture build inputs, so this team-support dev launcher always includes the control; its script contract test covers those inputs.

Validation: focused Rust capture tests (including serialized-budget, corrupt-queue and production-endpoint cases), desktop-forwarder tests, Den route/migration tests, UI typecheck and targeted lint all pass. `git diff --check` passes. The full workspace check remains blocked by pre-existing Solid reactivity lint failures outside this change.
