---
title: Live Dev-Profile Native WebDriver
status: complete
done: true
date: 2026-07-30
scope: opt-in W3C WebDriver attachment to the real Veslo development runtime
---

# Live Dev-Profile Native WebDriver

## Decision

Add an opt-in native WebDriver endpoint to the existing `pnpm dev` Tauri
wrapper. The endpoint exists only when the developer starts
`pnpm dev:webdriver`; the normal development command, production builds, and
the Tauri Pilot E2E runtime stay unchanged.

The client attaches to the already-running Tauri process. It never starts,
restarts, terminates, seeds, or reconfigures the app. Consequently it observes
the normal development identity (`com.neatech.veslo.dev`), its normal WebView
state, `VESLO_DATA_DIR`, and the developer's currently signed-in profile.

```text
pnpm dev:webdriver
  -> existing tauri-dev wrapper
  -> Vite + Tauri development application + existing dev profile
  -> debug-only embedded W3C endpoint on 127.0.0.1:<ephemeral-port>
  -> pnpm test:webdriver:live -- <runtime-info.json>
```

This is deliberately adjacent to, rather than a replacement for, the
isolated Tauri Pilot suite. Pilot remains the automated desktop E2E gate.

## Why embedded WebDriver

`tauri-driver` starts an application from a binary path, so it is not an
attach protocol for an arbitrary `tauri dev` process. The embedded
`tauri-plugin-wdio-webdriver` server runs inside the process already launched
by the dev wrapper and is a standard W3C WebDriver endpoint. It binds to
loopback on desktop platforms and accepts its port from `TAURI_WEBDRIVER_PORT`.

The independent client uses the WebdriverIO protocol client directly. It does
not use `@wdio/tauri-service`, because that service owns process launch and
would violate the live-profile contract.

## Security and profile contract

The endpoint is explicitly opt-in, debug-only, ephemeral, and loopback-only.
It is not an authentication boundary against another process under the same
OS user: the upstream embedded server implements W3C WebDriver without a
listener token. Do not enable it on a shared account or leave it running when
it is not needed.

The official attach command is read-only: it checks status, the rendered app
root, and non-sensitive shell facts, then closes its WebDriver session. It
does not emit page source, cookies, storage, prompts, transcript text, or
authentication material. Any mutating workflow needs a separately reviewed,
explicit command and is out of scope.

The launcher fails closed if known E2E profile/auth fixture overrides are
present. It intentionally does not replace normal operating-system profile
variables such as `LOCALAPPDATA` or `USERPROFILE`; those are how the existing
development profile is located.

## Implementation slices

1. Add a `webdriver` Cargo feature with the optional embedded driver and only
   register it under `debug_assertions`.
2. Extend the existing `tauri-dev.mjs` with `--webdriver`, preserving its
   current Pilot diagnostics and normal `pnpm dev` behavior. Allocate a free
   loopback port, pass it through `TAURI_WEBDRIVER_PORT`, add the narrow inline
   capability, and write a redacted runtime descriptor.
3. Have the Tauri process write its own PID to a sidecar descriptor after
   setup. The launcher descriptor points to it; the client verifies both it
   and `GET /status` before making a session.
4. Add an independent `packages/desktop-webdriver` workspace with a
   read-only WebdriverIO attach smoke command.
5. Cover the launch contract with focused tests and verify normal/Pilot and
   WebDriver feature builds separately.

## Acceptance

- `pnpm dev` has no WebDriver feature, port, or capability.
- `pnpm dev:webdriver` keeps the regular dev app identifier, data directory,
  and already authenticated profile; it does not create an E2E profile.
- The endpoint is `127.0.0.1` on a per-run port and is absent from release
  runtime registration.
- The attach smoke sees the same app process recorded by the native runtime,
  performs no mutation, and leaves the application running after disconnect.
- Pilot remains usable in the same development runtime; no WebdriverIO
  dependency is added to `packages/e2e` or any `test:e2e*` command.

## Verification record

Completed on 2026-07-30 against a real locally signed-in development
runtime. The native descriptor identified the running development application,
the WebDriver attach client connected to that exact PID and confirmed the app
root without mutating it, then disconnected while the application remained
alive. A Tauri Pilot ping succeeded against the same running process.

Focused launcher, attach-client, capability-contract, and Cargo feature
checks passed. The full workspace check was attempted but remains blocked by
pre-existing failures in unrelated app unit tests; this plan's focused checks
and real desktop acceptance are green.

## Non-goals

- CI, production installed apps, fake accounts, copied authentication,
  per-test user-data directories, or a `tauri-driver` replacement for the
  live attach path.
- Protecting the loopback WebDriver listener from other local processes of the
  same user. The tool must instead stay explicit, short-lived, and developer
  controlled.
