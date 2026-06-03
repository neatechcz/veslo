# Veslo Server Bounded Body Hardening Design

## Goal

Prevent `veslo-server` from repeating the RAM bloat class seen during the managed-AI proxy incident by making server request/response body reads bounded by bytes, preserving streaming proxy paths, and adding byte-aware transcript cache limits.

## Scope

This design covers only `packages/server`. Desktop, orchestrator, app-client behavior, and a full runtime memory governor are out of scope for this implementation. A separate YouTrack follow-up tracks the memory-governor work.

## Problem

The confirmed incident came from the AI gateway proxy reading a cloned OpenCode request body for model diagnostics before forwarding it. Large or chunked provider requests then stopped behaving as true streams and Bun/JSC memory grew until the server consumed tens of GB.

The same class can recur anywhere the server reads a body fully before enforcing limits. The audit found six server-side risk groups:

- AI gateway request diagnostics.
- AI gateway upstream error bodies.
- AI gateway successful JSON responses.
- OpenCode JSON helper responses for transcript/session flows.
- Transcript prefetch cache bounded by count but not by bytes.
- Generic JSON/form ingest for debug logs, file sessions, markdown content, and inbox upload.

## Architecture

Add bounded body helpers in the server layer:

- A byte-limited text reader for `Request` and `Response` bodies.
- A byte-limited JSON reader built on top of the text reader.
- A bounded preview reader for diagnostics that returns `{ text, truncated }` and cancels the body when the preview limit is reached.

Replace risky full-body reads with route-specific limits. Small API mutations use a conservative default. Known larger server features, such as file-session writes and transcript OpenCode responses, get explicit caps that match their product limits. Provider proxy paths keep streaming when payloads are large or chunked.

## Data Flow

Inbound server API requests:

1. Check `Content-Length` when present.
2. Reject requests over the route limit before reading the body.
3. For unknown length streams, read incrementally and abort with `413` once the limit is crossed.
4. Parse JSON only after the bounded read succeeds.

AI gateway responses:

1. Non-JSON or streaming responses are returned as streams.
2. Upstream error diagnostics read only a bounded preview.
3. Successful JSON responses are parsed/redacted only when small enough; larger provider JSON responses are streamed through without full buffering.

OpenCode helper responses:

1. Fetch JSON through a bounded helper.
2. Use separate limits for small config/session mutations and transcript/artifact reads.
3. Fail with a clear upstream-size error instead of parsing unbounded JSON.

Transcript prefetch cache:

1. Estimate snapshot size after loading.
2. Truncate oversized string-heavy parts before cache insertion where safe.
3. Evict least-recently-used entries until the workspace cache is below its byte budget.

## Error Handling

Oversized local API requests return `413 payload_too_large` with route label and max byte details. Oversized upstream JSON returns a `502`-class upstream payload error because the server cannot trust or parse the upstream response within local limits. Diagnostic snippets include a `truncated` marker but never store full provider bodies.

## Testing

Use server tests, because the behavior is inside `veslo-server` body handling and proxy semantics:

- AI gateway streams client request bodies before upload completion.
- AI gateway upstream error diagnostics are truncated and do not include the full body.
- AI gateway large JSON success responses stream through instead of being parsed.
- Generic JSON helpers reject oversized bodies with `413`.
- Debug-log ingest rejects oversized batches before validation.
- File-session write rejects oversized JSON before decoding payload content.
- Transcript prefetch evicts by byte budget, not only by entry count.

## Documentation

Update server/runtime docs to state that `veslo-server` limits full-body parsing, preserves provider streaming, and bounds transcript prefetch cache by bytes.
