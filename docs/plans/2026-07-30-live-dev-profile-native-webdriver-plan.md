---
title: Live Dev-Profile Native WebDriver Plan
status: proposed
done: false
date: 2026-07-30
issue: unlinked
scope: opt-in W3C WebDriver control of the real Veslo development runtime and its already authenticated development profile
related:
  - docs/dev/development-startup.md
  - docs/dev/testing-playbook.md
  - docs/testing/tauri-pilot/README.md
  - docs/plans/2026-06-06-tauri-pilot-e2e-migration.md
---

# Live Dev-Profile Native WebDriver Plan

## Purpose

Add an opt-in, local developer tool that drives the same Veslo development
runtime through W3C WebDriver while preserving the user's already authenticated
development profile. It is for high-fidelity manual regression and diagnosis;
it does not replace Tauri Pilot, the isolated Pilot suite, or production-MSI
verification.

The primary target is deliberately different from ordinary E2E:

```text
developer starts pnpm dev:webdriver
  -> existing tauri-dev wrapper
  -> Vite + Tauri dev + real dev data directory + real signed-in dev profile
  -> debug-only embedded W3C WebDriver endpoint on loopback
  -> native WebDriver client attaches without owning the app process
```

No fake user, copied auth snapshot, fixture account, isolated WebView data
directory, isolated OPENCODE_HOME, or E2E profile is permitted in this mode.

## Decision: embedded endpoint for the primary mode

The direct `tauri-driver` route is a valid native WebDriver implementation on
Windows and Linux, but it creates a session from an `application` binary. It is
not an attach protocol for an arbitrary already-running `tauri dev` process.
Using it as the main path would therefore violate the central requirement: the
test must observe the real, currently signed-in development runtime rather than
create a second process or an artificial profile.

The primary design is instead the debug-only embedded W3C server provided by
the WebdriverIO Tauri ecosystem. The Tauri process is still the native runtime
under test and the client still speaks standard WebDriver; the distinction is
only that the endpoint lives in the already-running dev process. The runner
uses the WebdriverIO client in attach mode, not `@wdio/tauri-service`, because
that service owns application launch and teardown.

`tauri-driver` remains an explicitly separate Windows/Linux compatibility
spike. It may never be described as the live-dev attach path unless upstream
adds and we prove an attach capability.

Upstream references:

- [Tauri WebDriver overview](https://v2.tauri.app/develop/tests/webdriver/)
- [Tauri direct driver setup](https://v2.tauri.app/develop/tests/webdriver/manual-setup/)
- [WebdriverIO embedded plugin setup](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup/)

## Scope and non-goals

In scope:

- an explicit `pnpm dev:webdriver` development startup mode;
- a standalone native WebDriver client that attaches to that exact process;
- read-only smoke/navigation/visible-state checks against the real dev profile;
- redacted diagnostics and unambiguous process ownership;
- coexistence with the current manual Pilot diagnostics without using Pilot as
  the WebDriver transport.

Out of scope:

- replacing Pilot as the repository desktop E2E gate;
- CI execution, because CI cannot honestly provide the developer's signed-in
  profile;
- using production-installed identity or profile by default;
- silently running sends, file writes, skill publication, account changes, or
  destructive cleanup against the real profile;
- adding WebdriverIO dependencies, scripts, or globals back into the existing
  Pilot E2E package.

## Terminology and profile contract

`live dev profile` means the profile already used by the normal `pnpm dev`
flow: the development application identifier, its existing WebView data, its
development Veslo data directory, and any authenticated Den state already held
there. It is real local user state, but it is not the installed production app
profile. Keeping those identities separate prevents a source checkout from
mutating a production installation accidentally.

The launcher must inherit the developer environment except for explicitly
documented diagnostic and WebDriver variables. In particular it must not set
or rewrite any of the following for live mode:

```text
HOME, USERPROFILE, APPDATA, LOCALAPPDATA, WEBVIEW2_USER_DATA_FOLDER,
OPENCODE_HOME, E2E_USE_EXISTING_PROFILE, E2E_OPENCODE_HOME,
VESLO_DEN_AUTH_SNAPSHOT_PATH, E2E_MANAGED_AI_GATEWAY_FIXTURE
```

If any E2E profile/auth override is inherited, live WebDriver startup fails
before the Tauri process starts. The only authentication assertion is a
redacted UI/runtime state check such as `authenticated: true`; tokens, cookies,
emails, storage values, and prompts are never written to artifacts.

## Topology and ownership

```text
pnpm dev:webdriver                         pnpm test:webdriver:live
same tauri-dev.mjs wrapper                 attach-only WebDriver client
        |                                             |
        v                                             v
Vite + Tauri dev process  <--- loopback W3C endpoint only --- WebView DOM
        |
real dev profile, local sidecars, real signed-in state
```

The startup command owns the app, Vite, server, orchestrator, and endpoint.
The attach-only test client owns only its WebDriver session and its own
redacted artifacts. It must never start, restart, kill, clean, or relaunch the
application process. Closing the WebDriver session must not close Veslo.

Veslo remains single-tenant: this mode refuses to start if a conflicting
development or test runtime exists. A user who wants to control an already
running process must have started that process through `pnpm dev:webdriver`;
an ordinary `pnpm dev` process does not gain an automation endpoint later.

## Proposed implementation slices

### WD01 — Add a distinct debug-only Cargo feature

Add a feature dedicated to embedded WebDriver, separate from the existing
Pilot `e2e` feature. Make the embedded server dependency optional and register
it only under both `debug_assertions` and the new feature.

The release/default build must not resolve to an active WebDriver listener.
Add a narrow source/manifest contract test proving that:

1. normal release builds do not enable the dependency or registration;
2. the ordinary `pnpm dev` command does not enable it;
3. only the explicit WebDriver development command enables it.

Do not add the broader `tauri-plugin-wdio` execute/mock plugin in this slice.
The live-profile tool needs ordinary DOM WebDriver operations, not command
mocking or remote arbitrary-script helpers. Existing redacted runtime traces
remain the diagnostic source of truth.

### WD02 — Extend the existing dev wrapper; do not create a second launcher

Add `pnpm dev:webdriver` as a thin, explicit mode of the current `tauri-dev`
wrapper. It must retain the normal dev wrapper's source build, Vite dev URL,
sidecar dev-watch behavior, development identifier, data-directory migration,
and real profile selection.

When the mode is enabled, the wrapper must:

1. allocate a random available loopback port and set the documented WebDriver
   port environment variable before Tauri starts;
2. add the WebDriver Cargo feature while preserving the existing manual Pilot
   feature when Pilot diagnostics are enabled;
3. add a WebDriver-only capability to the inline development config, never to
   the default/release capability;
4. write a small redacted runtime descriptor under the timestamped dev run
   directory containing mode, app PID, app identifier, loopback endpoint,
   port, startup time, and trace locations;
5. wait for the endpoint locally, verify its process binding is loopback-only,
   and fail closed if it is unavailable or exposed on a non-loopback address.

The normal `pnpm dev` contract remains unchanged. It must not open a WebDriver
port merely because Pilot diagnostics are available.

### WD03 — Add an attach-only client in a separate workspace

Create a dedicated desktop-WebDriver workspace rather than modifying the
current Pilot E2E workspace. The existing package intentionally asserts that
it contains no WDIO scripts, dependencies, globals, or legacy specs; retain
that boundary.

The new workspace uses the WebdriverIO client in standalone/remote mode and
reads only the redacted runtime descriptor produced by `pnpm dev:webdriver`.
It creates a W3C session against that endpoint and exposes an explicit command
such as `pnpm test:webdriver:live`.

The client preflight must require all of the following before it sends a
WebDriver command:

- descriptor says `mode: live-dev-webdriver` and identifies the dev app;
- endpoint host is loopback and its port is valid;
- recorded app PID is still alive;
- no E2E profile/auth override is present in the client environment;
- an in-app redacted authenticated-state probe succeeds.

The client records its own command timing, session ID digest, selector names,
and safe error classes. It never records page source, localStorage, cookies,
auth headers, raw console payloads, or prompt text.

### WD04 — Define safe live-profile tests

The initial suite is deliberately read-only:

1. app/window and root become available;
2. expected authenticated shell appears;
3. sidebar/workspace/session rendering is observable;
4. navigation to and from a dashboard works;
5. the currently selected conversation is not modified;
6. closing the client session leaves the app PID, profile, and Pilot socket
   unchanged.

Any mutation requires both a dedicated test name and
`WEBDRIVER_ALLOW_MUTATION=1`. Mutating tests must use an explicit disposable
workspace selected by the user, show that target in their output, and never
default to sending a model prompt. They are manual developer tools, not a CI
gate.

### WD05 — Characterize coexistence and failure handling

Add focused tests for the wrapper/client contracts, not a second copy of Pilot
scenarios. Required cases:

- normal dev mode has no WebDriver endpoint;
- WebDriver mode exposes one endpoint only after the real dev process starts;
- a second live WebDriver launch is rejected by single-tenant preflight;
- attach client does not spawn or terminate a Tauri process;
- stale descriptor, dead PID, port collision, non-loopback binding, absent
  profile authentication, and inherited E2E override fail with actionable
  errors;
- release/default build configuration cannot expose the WebDriver capability;
- Pilot remains available when the same explicitly started dev process enables
  both diagnostics, while no test assumes Pilot ownership of that process.

## Optional external-driver spike

After WD01-WD05 are green, run one Windows-only proof with `tauri-driver` and
the matching Microsoft Edge WebDriver. It is allowed to validate basic DOM
compatibility, selector behavior, and driver diagnostics. It must use a
separate app process and therefore cannot claim live-dev attach fidelity or
become the default command.

The spike must report the exact Edge and driver versions, prove clean teardown,
and stay outside the live profile unless a developer makes an explicit,
interactive choice. Linux and macOS are not part of this spike; direct
`tauri-driver` does not support macOS desktop WebViews.

## Acceptance matrix

| Requirement | Evidence required |
| --- | --- |
| Same dev runtime | Tauri dev wrapper logs both Vite readiness and the debug Veslo process; descriptor identifies the same PID. |
| Real signed-in state | Redacted authenticated UI/runtime probe is true; no seed, snapshot, fixture account, or profile redirection occurred. |
| Attach, not replacement | App PID exists before and after the WebDriver client; client logs no spawn/kill/restart action. |
| Profile safety | Default suite performs no message, workspace, skill, filesystem, or account mutation. |
| Local-only endpoint | Listener verification proves loopback binding; endpoint is absent from ordinary dev and release modes. |
| Pilot coexistence | Existing manual Pilot socket remains usable if enabled; Pilot suite is neither modified nor reused as the WebDriver transport. |
| Production exclusion | Default/release build and capability checks prove no WebDriver plugin/permission/listener. |
| Actionable failure | Missing login, wrong mode, stale descriptor, occupied port, wrong app PID, and unsupported client version each have a safe specific message. |

## Completion gate

The plan is complete only when an already authenticated developer can start
`pnpm dev:webdriver`, run the attach-only smoke suite against that exact process,
and close the client while the app remains open and signed in. The evidence must
show the same process identity, real dev profile selection, redacted artifacts,
and absence of profile mutation.

It is explicitly not complete merely because a separate debug binary launches
through `tauri-driver`, because a fixture profile passes, or because an
isolated CI job is green.
