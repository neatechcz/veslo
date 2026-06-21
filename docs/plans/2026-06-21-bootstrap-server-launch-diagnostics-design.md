# Bootstrap and Server Launch Diagnostics Design

**Date:** 2026-06-21
**Scope:** Veslo-owned diagnostics for first-run desktop failures, local Veslo server launch failures, mid-run local Veslo server failures, debug-log delivery failures, and chat-entry disabled states.
**Out of scope:** GlitchTip, Bugsink, Sentry-compatible sink setup, source map upload, alert routing, and external observability deployment.

## Problem

A newly installed Veslo desktop app can reach a state where the user signs in successfully, but the local Veslo server is unavailable and the chat entry point cannot open a new chat. The same blind spot can also happen later in the app run if the local Veslo server crashes, stops responding, loses its host-token/base-url state, or accepts debug logs without being able to forward them to Den.

The local Veslo server can only explain behavior while it is running and while its debug-log uploader is configured and healthy. It cannot explain why it never started, why it died, or why its own log pipeline stopped forwarding. Veslo therefore needs a desktop-owned diagnostics path that records app bootstrap, server-launch evidence, supervisor-captured Veslo server output, and delivery failures outside the local server process, then uploads that evidence directly to Den whenever the local server cannot be trusted as the log carrier.

## Goals

- Give support and developers a server-side timeline for first-run failures by user, install, and app launch.
- Separate logs emitted by the local Veslo server from logs about launching that server.
- Capture enough launch evidence to explain why the local server did not run.
- Capture enough mid-run evidence to explain why a previously running local server stopped carrying logs.
- Keep a direct desktop-to-Den backup delivery path for diagnostics when the local Veslo server is unavailable, unhealthy, or unable to forward logs.
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

Add Veslo-owned diagnostics with four distinct local event lanes:

1. `desktop-bootstrap`
   Events from the desktop shell and WebView before the local Veslo server is trusted to be available.

2. `veslo-server-launch`
   Events from the desktop supervisor around discovery, spawning, readiness checks, exits, and health checks for the local Veslo server process.

3. `veslo-server-supervised-output`
   Veslo server stdout/stderr and process lifecycle observations captured by the desktop supervisor. This lane is not emitted by the server debug-log pipeline; it is what the desktop sees from outside the process.

4. `veslo-server-runtime`
   Events emitted by the local Veslo server itself after it starts. This lane continues to use the normal debug-log pipeline.

The first three lanes must be collected outside the local Veslo server process. They are written to a desktop-owned durable spool immediately at app startup and during the full app run. After Den authentication succeeds, the desktop diagnostics service can upload them directly to Den whenever the local Veslo server is not a reliable delivery path.

The local Veslo server remains the preferred delivery path when healthy. It must not be the only delivery path.

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

### Supervised server output lane

The desktop supervisor already observes child process stdout/stderr. This lane makes that observation durable and cloud-deliverable independently of the local server.

It records:

- Veslo server stdout/stderr lines, size-limited and redacted
- process start and exit state
- exit code or signal
- last known PID
- whether the local `/debug-logs` endpoint was reachable
- whether the local `/debug-logs` endpoint reported cloud forwarding enabled
- fallback upload activation and outcome

The local Veslo server should emit enough structured self-log lines to stdout/stderr that this lane is useful when the server's own upload pipeline cannot run.

### Runtime lane

The local Veslo server continues to own full runtime logs after it starts:

- server internal logs
- local API request handling
- orchestrator-backed runtime flow
- sidecar stdout/stderr forwarding
- audit/debug events

These logs should remain separate from server-launch diagnostics. In Den, the user should be able to see that `veslo-server-launch` failed before expecting any `veslo-server-runtime` events.

### Delivery state lane

Delivery behavior is diagnostic data. The desktop diagnostics service records:

- local server base URL unavailable
- host token unavailable
- local `/debug-logs` POST failed
- local `/debug-logs` POST returned non-2xx
- local `/debug-logs` reported cloud forwarding disabled
- local server health failed after previously succeeding
- direct Den fallback upload started
- direct Den fallback upload succeeded
- direct Den fallback upload failed and will retry

These events are small and must be sent through the same fallback path.

## Upload Flow

### Normal path

1. Desktop writes `desktop-bootstrap`, `veslo-server-launch`, and `veslo-server-supervised-output` events to its local diagnostics spool.
2. Desktop starts the local Veslo server.
3. Desktop forwards events to the local Veslo server debug-log endpoint.
4. The local Veslo server spools and uploads to Den through the existing internal ingest path.
5. Den deduplicates events by stable event id, boot id, install id, source lane, and timestamp.

### Fallback path

1. Desktop writes diagnostics events to its local diagnostics spool.
2. User signs in through Den.
3. The desktop diagnostics service continuously evaluates the local Veslo server as a delivery path.
4. If the local server is missing, unhealthy, unreachable, has no host token, returns repeated POST failures, or reports cloud forwarding disabled, desktop uploads diagnostics batches directly to Den with the signed-in Den session.
5. When the local Veslo server later recovers and reports healthy forwarding, normal local-server delivery resumes.

The direct desktop-to-Den route accepts only desktop-owned diagnostics lanes: `desktop-bootstrap`, `veslo-server-launch`, `veslo-server-supervised-output`, and delivery-state events. It must not accept prompts, transcripts, tool output, workspace file contents, screenshots, arbitrary user-provided payloads, or unbounded raw process logs.

### Local server delivery status

The local `/debug-logs` endpoint should return enough status for the desktop to know whether accepting a batch actually means the event can reach Den. At minimum:

```json
{
  "ok": true,
  "acceptedBatchIds": ["..."],
  "cloudUploadEnabled": true
}
```

If `cloudUploadEnabled` is false, the desktop must keep or requeue those events for direct Den fallback instead of assuming delivery is complete.

### Deduplication

Every diagnostics event must have a stable event id generated before first delivery. Den must deduplicate across both ingestion paths:

- local Veslo server internal ingest
- direct desktop fallback ingest

This allows the desktop to safely retry after uncertain failures without corrupting the timeline.

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
- delivery path, such as `local-server` or `desktop-direct-fallback`

Encrypted payload:

- structured event details
- redacted stderr/stdout tail
- app state snapshot
- launch state snapshot
- delivery state snapshot

Retention should be long enough for support investigations. Use 30 days for this diagnostics stream unless operations explicitly chooses a shorter window.

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
- Did normal debug-log forwarding fail because the local server accepted logs but could not upload them?
- Did the desktop fallback uploader activate?
- Which delivery path got the event into Den?

Minimum read endpoints:

- list bootstrap timelines by user/email/time window
- fetch one timeline by `bootId`
- export one timeline as JSONL

The result should present bootstrap, launch, supervised output, delivery-state, and runtime lanes separately in chronological order.

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
- local server never starts, but Den receives desktop fallback diagnostics after sign-in
- local server starts and later crashes, and Den receives supervisor-captured exit/output diagnostics through direct fallback
- local server accepts `/debug-logs` but reports cloud forwarding disabled, and desktop falls back to direct Den upload
- local server `/debug-logs` POST repeatedly fails, and desktop falls back to direct Den upload
- chat/new-session disabled state emits the correct structured reason
- direct Den ingest rejects unauthenticated uploads
- direct Den ingest rejects runtime/full-log payloads
- redaction removes tokens, raw home paths, query strings, and long process output
- normal runtime debug-log upload still works when the local server starts

## Rollout

1. Build local event model, redaction, and desktop spool for bootstrap, launch, supervised output, and delivery-state lanes.
2. Add direct Den ingest for authenticated desktop diagnostics fallback.
3. Add admin search/read endpoints for timelines.
4. Instrument first-run app state, server launch paths, server supervisor output, and log-delivery state.
5. Add desktop E2E scenarios for fresh install, server launch failure, mid-run server crash, cloud-forwarding-disabled, and chat disabled state.
6. Later, in a separate session, add GlitchTip/Bugsink as an optional observability sink.
