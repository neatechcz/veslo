# AI Gateway Live Testing - 2026-06-17

This note records the focused live testing done after a desktop send appeared to
hang for 35-50 seconds while server traces showed repeated upstream `404`
responses from the managed AI gateway path.

The goal was to answer these questions:

- Does the hosted AI gateway route exist and accept the current `codex_oauth`
  token?
- Does `gpt-5.5` work for live inference?
- Does streaming work?
- Does the local Veslo server proxy add meaningful latency or alter failures?
- Does an OpenCode-like payload, including tools and reasoning fields, reproduce
  the observed `404`?
- What response times should be expected when the gateway is healthy?

## Test Harness

The live probe script is:

```powershell
node dev-specific/ai-gateway-live/ai-gateway-live-probe.mjs
```

It reads the current OpenCode provider routing from the test workspace config,
extracts the managed AI route, server client token, gateway token, model, and
workspace header, then writes only redacted artifacts.

Primary output directories:

- `dev-specific/ai-gateway-live/runs/full-20260617-ai-gateway-live`
- `dev-specific/ai-gateway-live/runs/large-20260617-ai-gateway-live`
- `dev-specific/ai-gateway-live/runs/cloud-repeat-20260617-ai-gateway-1` through `5`

Each run writes:

- `summary.json`
- `events.ndjson`
- `responses/*.request.redacted.json`
- `responses/*.body.txt`
- for local proxy runs, `local-server-send-workflow-trace.ndjson`

Tokens and authorization values are not stored in summaries or request
snapshots.

## Coverage

The full matrix covered:

- direct cloud route: `https://ai.veslo.work/providers/codex_oauth/v1/chat/completions`
- local Veslo server proxy route: `/ai-gateway/providers/codex_oauth/v1/chat/completions`
- model: `gpt-5.5`
- non-stream minimal chat completions
- stream minimal chat completions
- OpenCode-like payloads with `tools`, `tool_choice`, `reasoning_effort`,
  `verbosity`, and `stream_options`
- negative controls:
  - invalid gateway token
  - missing session id
  - invalid model
  - missing local server client auth
  - missing local gateway token
  - invalid local gateway token
- large OpenCode-like request:
  - 44,449 request bytes
  - 2 messages
  - 23 tools
  - `stream: true`
  - `reasoning_effort`

The large request was intentionally close to the real app failure request shape
seen earlier, where the app trace showed roughly 41 KB and 23 tools.

## Commands Run

Smoke, no paid inference:

```powershell
node dev-specific/ai-gateway-live/ai-gateway-live-probe.mjs --cloud-only --no-paid --run-id smoke-20260617-ai-gateway --timeout-ms 30000
```

Full matrix:

```powershell
node dev-specific/ai-gateway-live/ai-gateway-live-probe.mjs --run-id full-20260617-ai-gateway-live --timeout-ms 90000 --headers-timeout-ms 90000
```

Large OpenCode-like payload only:

```powershell
node dev-specific/ai-gateway-live/ai-gateway-live-probe.mjs --run-id large-20260617-ai-gateway-live --case-filter large-opencode --timeout-ms 120000 --headers-timeout-ms 120000
```

Cloud variability repeats:

```powershell
for ($i = 1; $i -le 5; $i++) {
  $runId = "cloud-repeat-20260617-ai-gateway-$i"
  node dev-specific/ai-gateway-live/ai-gateway-live-probe.mjs --cloud-only --case-filter cloud-gpt55-stream-repeat --run-id $runId --timeout-ms 90000
}
```

## Results

Aggregate across the full run, large run, and five cloud repeat runs:

```text
runs: 7
cases: 31
paid live inference cases: 24
paid successes: 24
paid failures: 0
gateway 404 count: 0

status counts:
  200: 24
  400: 2
  401: 3
  403: 1
  502: 1
```

The non-200 responses were expected negative controls:

- cloud invalid token: `401 {"error":"unauthorized"}`
- cloud missing session id: `400 {"error":"missing_session_id"}`
- cloud invalid model: `403 {"error":"model_not_allowed"}`
- local missing client auth: `401 unauthorized`
- local missing gateway token: `401 gateway_unauthorized`
- local missing session id: `400 gateway_session_required`
- local invalid gateway token: local `502`, upstream `401`

The route therefore exists, the token is accepted, the session header is
validated, and invalid models are rejected as policy/model failures rather than
route misses.

## Streaming Evidence

Streaming worked both directly against the hosted gateway and through the local
Veslo server proxy.

Observed stream responses:

- `content-type: text/event-stream`
- 33-36 parsed SSE chunks per request
- `finishReason: "stop"`
- final text matched the requested sentinel, for example:

```text
VESLO_AI_GATEWAY_OK ... CASE=cloud-gpt55-stream-repeat-1
VESLO_AI_GATEWAY_OK ... CASE=local-gpt55-stream-large-opencode-shape
```

This confirms that the live streaming path is functional.

## Latency

Paid live inference latency across 24 successful requests:

```text
min: 1.75 s
p50: 2.09 s
p90: 4.24 s
max: 9.66 s
```

The local server proxy trace showed negligible local overhead. For the large
44 KB / 23 tool local request:

```text
status: 200
total: 2797 ms
local preflight: 4 ms
model diagnostic: 7 ms
upstream headers: 2793 ms
```

So for healthy runs, almost all time is upstream gateway/model time, not local
server time.

## Expected Response Windows

Based on these runs:

- Direct gateway or local proxy warm request: usually 2-4 seconds.
- Slower but still normal outlier: about 7-10 seconds.
- Large OpenCode-like payload around 44 KB / 23 tools: about 3-5 seconds in this
  run.
- Warm app send in an existing session should usually be roughly 3-6 seconds,
  with occasional 10-12 second outliers.
- Cold first send in a new workspace can be longer because it includes engine
  startup and session creation; 10-15 seconds is plausible.

Anything around 35-50 seconds should be treated as anomalous. It is not the
healthy gateway baseline measured here.

## Interpretation

The current gateway setup did not reproduce the app-side `404`.

What the tests prove:

- `codex_oauth` hosted route is reachable.
- The current gateway token can perform live inference.
- `gpt-5.5` is accepted and returns model output.
- Streaming works.
- Local Veslo server proxying works.
- OpenCode-like tool payloads work, including a 44 KB / 23 tool request.
- The local proxy correctly normalizes upstream failures, for example invalid
  gateway token becomes local `502` with upstream `401` details.

What the tests do not prove:

- They do not exercise the full desktop UI state machine.
- They do not exercise OpenCode's retry policy after a transient upstream
  failure.
- They do not prove that the app surfaces non-2xx gateway errors promptly.

The earlier desktop run still exposed a real bug candidate: when OpenCode/app
receives repeated upstream non-2xx responses, the visible session can remain in
`has-begun` / responding state for too long instead of quickly becoming a
terminal AI access or gateway error.

## Current Working Hypothesis

The gateway is healthy in the current setup. The 35-50 second user-visible wait
was probably not normal model latency and not a stable missing route.

More likely causes:

- transient hosted gateway/provider state at the time of the app send,
- credential lease/repair edge in the hosted gateway,
- OpenCode retry/backoff after upstream non-2xx,
- app/server run lifecycle not converting gateway non-2xx into a terminal
  session error quickly enough.

Next debugging should focus on the full app/OpenCode error path:

- force hosted gateway `401`, `403`, `404`, and `5xx` equivalents through a
  controlled upstream/mock gateway,
- verify the local Veslo server emits normalized error details,
- verify OpenCode stops retrying or reports failure within a bounded time,
- verify the desktop session UI leaves responding state and shows an explicit
  terminal error.

