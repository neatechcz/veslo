# Bootstrap and Server Launch Diagnostics Design

**Date:** 2026-06-21
**Scope:** Veslo-owned diagnostics for first-run desktop failures, local Veslo server launch failures, and chat-entry disabled states.
**Out of scope:** GlitchTip, Bugsink, Sentry-compatible sink setup, source map upload, alert routing, and external observability deployment.

## Problem

A newly installed Veslo desktop app can reach a state where the user signs in successfully, but the local Veslo server is unavailable and the chat entry point cannot open a new chat. The current debug-log path is not enough for that failure class because normal log upload depends on the local Veslo server becoming reachable.

The local Veslo server can only explain behavior after it starts. It cannot explain why it never started. Veslo therefore needs a desktop-owned diagnostics path that records app bootstrap and server-launch evidence outside the local server process, then uploads that evidence after user authentication even when the local server is still down.

## Goals

- Give support and developers a server-side timeline for first-run failures by user, install, and app launch.
- Separate logs emitted by the local Veslo server from logs about launching that server.
- Capture enough launch evidence to explain why the local server did not run.
- Capture enough app state to explain why a chat/new-session control was disabled or ineffective.
- Keep diagnostics durable across restarts and temporary network failures.
- Keep sensitive user content, prompts, tool output, provider tokens, cookies, and raw workspace paths out of this bootstrap channel.
- Keep the design independent of GlitchTip or any other observability sink.

## Non-Goals

- Replacing the existing full debug-log pipeline.
- Sending full prompts, tool output, workspace file contents, screenshots, or raw process logs through the bootstrap channel.
- Implementing GlitchTip, Bugsink, Sentry SDKs, issue grouping, or alerting in this slice.
- Building a polished user-facing diagnostics UI.
- Making unauthenticated anonymous telemetry upload before sign-in.

## Decision

Add Veslo-owned bootstrap diagnostics with three distinct local event lanes:

1. `desktop-bootstrap`
   Events from the desktop shell and WebView before the local Veslo server is trusted to be available.

2. `veslo-server-launch`
   Events from the desktop supervisor around discovery, spawning, readiness checks, exits, and health checks for the local Veslo server process.

3. `veslo-server-runtime`
   Events emitted by the local Veslo server itself after it starts. This lane continues to use the normal debug-log pipeline.

The first two lanes must be collected outside the local Veslo server process. They are written to a desktop-owned durable spool immediately at app startup. After Den authentication succeeds, the desktop can upload a compact redacted bootstrap report directly to Den if the local Veslo server remains unavailable.

## Architecture

### Event correlation

Each app launch gets a `bootId`. Each local installation gets a stable random `installId`.

All bootstrap, launch, and runtime events include:

- `bootId`
- `installId`
- app version and build channel
- platform, OS version category, and architecture
- event timestamp
- source lane
- event type
- severity

After sign-in, subsequent uploads can include:

- `userId`
- `orgId`
- optional workspace id when known

Den should support lookup by user/email, `bootId`, `installId`, and time window.

### Desktop bootstrap lane

The desktop/bootstrap lane records the product state that exists before reliable local runtime connectivity:

- app process started
- WebView initialized
- Den auth started, completed, failed, or exchanged
- onboarding route/state changed
- workspace selection or private-chat bootstrap state changed
- local runtime client missing, present, stale, or unreachable
- chat/new-session control rendered enabled or disabled
- chat/new-session click attempted
- session creation blocked, including the blocked reason
- startup request audit summary for Den and local-runtime calls

For disabled chat/new-session states, the event should carry a structured reason such as:

- `noRuntimeClient`
- `runtimeConnecting`
- `runtimeUnreachable`
- `missingWorkspaceRoot`
- `missingQuickChatHandler`
- `managedAiBootstrapBlocked`
- `unknown`

This must be emitted as state changes happen, not only when the user submits feedback.

### Server launch lane

The server-launch lane records what happened around the local Veslo server process itself:

- launch requested
- bundled binary discovered or missing
- binary version/hash when available
- data directory category and existence checks
- config/env presence booleans, never raw secret values
- host-token presence boolean, never the token
- intended host and port
- port availability check result
- process spawn attempted
- PID assigned
- stdout/stderr short redacted tail
- process exit code or signal
- startup timeout
- readiness/health check attempted
- health check success or failure category
- launch retry scheduled
- final launch state for this boot

This lane is the key difference from normal server logs. It exists even if the local Veslo server binary never starts.

### Runtime lane

The local Veslo server continues to own full runtime logs after it starts:

- server internal logs
- local API request handling
- orchestrator-backed runtime flow
- sidecar stdout/stderr forwarding
- audit/debug events

These logs should remain separate from server-launch diagnostics. In Den, the user should be able to see that `veslo-server-launch` failed before expecting any `veslo-server-runtime` events.

## Upload Flow

### Normal path

1. Desktop writes `desktop-bootstrap` and `veslo-server-launch` events to its local diagnostics spool.
2. Desktop starts the local Veslo server.
3. Desktop forwards events to the local Veslo server debug-log endpoint.
4. The local Veslo server spools and uploads to Den through the existing internal ingest path.

### Failure path

1. Desktop writes bootstrap and launch events to its local diagnostics spool.
2. User signs in through Den.
3. The local Veslo server remains missing or unhealthy for a configured threshold.
4. Desktop uploads a compact redacted bootstrap report directly to Den with the signed-in Den session.
5. When the local Veslo server later recovers, normal debug-log forwarding resumes.

The direct desktop-to-Den route accepts only bootstrap and launch diagnostics. It must not accept full runtime logs, prompts, transcripts, tool output, workspace file contents, screenshots, raw process logs, or arbitrary user-provided payloads.

## Den Storage

Add a dedicated Den storage surface for bootstrap diagnostics rather than overloading full debug-log storage.

Cleartext searchable metadata:

- id
- created timestamp
- event timestamp
- expires timestamp
- user id when available
- org id when available
- install id hash
- boot id
- source lane
- event type
- severity
- app version
- platform
- failure category when present

Encrypted payload:

- structured event details
- redacted stderr/stdout tail
- app state snapshot
- launch state snapshot

Retention should be shorter than full debug logs, initially 14 days unless operations wants 30 days for consistency.

## Read/Support API

Platform-admin diagnostics search should answer:

- What happened for this user around sign-in?
- Did auth complete?
- Did the app attempt to start the local Veslo server?
- Did the binary exist?
- Did the process spawn?
- Did it exit?
- Was there a port conflict?
- Did health checks fail?
- Why was chat/new-session disabled?
- Did normal debug-log forwarding fail because the local server was unavailable?

Minimum read endpoints:

- list bootstrap timelines by user/email/time window
- fetch one timeline by `bootId`
- export one timeline as JSONL

The result should present bootstrap, launch, and runtime lanes separately in chronological order.

## Privacy and Redaction

The bootstrap channel is powerful but intentionally narrower than full debug logs.

Rules:

- No prompt text.
- No model/tool output.
- No file content.
- No screenshots.
- No provider keys, access tokens, cookies, or auth headers.
- No raw home-directory paths.
- No full URLs with query strings.
- Process stdout/stderr tails are short, redacted, and categorized.
- Paths are reduced to categories or stable hashes when needed.
- Config values are reported as presence booleans unless explicitly safe.

Den stores encrypted payloads and cleartext metadata only for search.

## Observability Sink Boundary

GlitchTip, Bugsink, or another Sentry-compatible backend can be added later as a sink for grouped errors, panics, stack traces, release correlation, and alerts. That future sink should consume selected sanitized events or SDK-captured exceptions.

This design does not depend on that sink. Veslo owns the event taxonomy, local spool, Den ingest, and support query path.

## Testing

Primary validation should use real desktop runtime tests.

Required coverage:

- fresh profile app boot emits `desktop-bootstrap` events
- successful Den auth attaches user context to later diagnostics
- local server binary missing emits `veslo-server-launch` failure
- port conflict emits a distinct launch failure category
- server process exits before health emits exit code/signal metadata
- local server never starts, but Den receives the direct bootstrap report after sign-in
- chat/new-session disabled state emits the correct structured reason
- direct Den ingest rejects unauthenticated uploads
- direct Den ingest rejects runtime/full-log payloads
- redaction removes tokens, raw home paths, query strings, and long process output
- normal runtime debug-log upload still works when the local server starts

## Rollout

1. Build local event model, redaction, and desktop spool for bootstrap and launch lanes.
2. Add direct Den ingest for authenticated bootstrap reports.
3. Add admin search/read endpoints for timelines.
4. Instrument first-run app state and server launch paths.
5. Add desktop E2E scenarios for fresh install, server launch failure, and chat disabled state.
6. Later, in a separate session, add GlitchTip/Bugsink as an optional observability sink.

