---
title: Release EXE OpenCode Runtime Failure Evidence
date: 2026-07-09
status: evidence
done: false
issue: unlinked
repo: veslo-main
source_runtime: dev-specific/release-runtime-20260709-120401-exe-trace
---

# Release EXE OpenCode Runtime Failure Evidence

## Scope

done: false

Record the exact evidence from the `2026.7.6` release EXE trace run where no
inference was submitted successfully. This is an evidence note, not a fix plan.

## Build Artifact Snapshot

done: true

The build was produced from the current `veslo-main` worktree with
`VITE_VESLO_SEND_WORKFLOW_TRACE=1`, so the production UI bundle retained
send-workflow trace instrumentation.

- EXE:
  `packages/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/veslo.exe`
  - `ProductVersion`: `2026.7.6`
  - `FileVersion`: `2026.7.6`
  - `Length`: `12768256`
  - `LastWriteTime`: `2026-07-09 12:01:48` Europe/Prague
- Local MSI:
  `packages/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Veslo by Neatech_2026.7.6_x64_cs-CZ.msi`
  - `Length`: `219849589`
  - `LastWriteTime`: `2026-07-09 12:02:47` Europe/Prague

The MSI was built locally with updater artifacts disabled through a temp Tauri
config override. It is useful for local runtime validation, but it is not a
signed production release artifact.

## Runtime Snapshot

done: true

Trace directory:

`dev-specific/release-runtime-20260709-120401-exe-trace`

Runtime info:

- `schema`: `veslo-release-runtime-trace/v1`
- `mode`: `release-exe-trace`
- `startedAt`: `2026-07-09T10:04:02.2378679Z`
- local start time: `2026-07-09 12:04:02` Europe/Prague
- `pid`: `15252`
- EXE path:
  `packages/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/veslo.exe`

Trace file presence:

- `send-workflow-trace.ui.ndjson`: present, `266` lines, JSON parse errors `0`
- `send-workflow-trace.server.ndjson`: present, `61` lines, JSON parse errors `0`
- `send-workflow-trace.orchestrator.ndjson`: missing
- `runtime-trace.ndjson`: missing
- `opencode-health.ndjson`: missing

Process observation during the run:

- `veslo.exe` was running as PID `15252`.
- `veslo-server.exe` was running as PID `7764`.
- No matching `opencode`, `veslo-orchestrator`, or `chrome-devtools` process was
  observed in the process snapshot.

## High-Confidence Conclusion

done: true

No successful inference happened in this run.

There are no positive submit signals such as `submitted`, `queued`,
`opencode-submit:success`, or lifecycle `completed` in the UI/server trace files.
The terminal send results that reached the UI all ended as `accepted:false` /
`status:"failed"`.

This was not an upstream DEN / AI access outage. The local server successfully
proxied Managed AI access checks:

- `server:ai-gateway:proxy:timing` returned `status:200`, `outcome:"ok"` nine
  times.
- Representative evidence:
  - `send-workflow-trace.server.ndjson:6`
  - `send-workflow-trace.server.ndjson:11`
  - `send-workflow-trace.server.ndjson:16`
  - `send-workflow-trace.server.ndjson:21`
  - `send-workflow-trace.server.ndjson:26`
  - `send-workflow-trace.server.ndjson:31`
  - `send-workflow-trace.server.ndjson:36`
  - `send-workflow-trace.server.ndjson:41`
  - `send-workflow-trace.server.ndjson:48`

The failure occurred at the local OpenCode route boundary before a model request
could run.

## Failure Signal 1: Workspace OpenCode Base URL Missing

done: true

The first send attempts failed before reaching an OpenCode HTTP target:

- `upstreamCode:"opencode_unconfigured"`
- `upstreamStatus:400`
- UI message: `OpenCode base URL is missing for this workspace`
- terminal result: `accepted:false`, `status:"failed"`,
  `code:"conversation_create_failed"`, `draftDisposition:"restore"`

Exact UI trace evidence:

- `send-workflow-trace.ui.ndjson:37`
  - `event:"conversation_create_failed"`
  - `traceId:"send_003aa85c-7341-43a2-9522-5495caacb14a"`
  - `upstreamCode:"opencode_unconfigured"`
  - `upstreamStatus:400`
- `send-workflow-trace.ui.ndjson:45`
  - `event:"sendPromptImmediate:result"`
  - `accepted:false`
  - `status:"failed"`
  - `code:"conversation_create_failed"`
  - `error:"OpenCode base URL is missing for this workspace"`
- `send-workflow-trace.ui.ndjson:81`
  - second `conversation_create_failed`
  - `upstreamCode:"opencode_unconfigured"`
  - `upstreamStatus:400`
- `send-workflow-trace.ui.ndjson:89`
  - second terminal result
  - `accepted:false`
  - `error:"OpenCode base URL is missing for this workspace"`
- `send-workflow-trace.ui.ndjson:127`
  - third `conversation_create_failed`
  - `upstreamCode:"opencode_unconfigured"`
  - `upstreamStatus:400`
- `send-workflow-trace.ui.ndjson:135`
  - third terminal result
  - `accepted:false`
  - `error:"OpenCode base URL is missing for this workspace"`

Related managed config signal:

- `send-workflow-trace.ui.ndjson:1`
  - `event:"managed-config-compare"`
  - `workspaceId:"ws-a7d38764e4cd"`
  - `localBaseUrl.origin:"http://127.0.0.1:8787"`
  - `engineBaseUrl.present:false`
  - `resolvedEngineBaseUrl.origin:"http://127.0.0.1:8787"`
  - `canUseVesloServer:false`
  - `matches:false`
- `send-workflow-trace.ui.ndjson:2`
  - same workspace/config owner
  - `matches:true`

This shows config materialization/comparison happened, but the send path still
received a server terminal failure saying the OpenCode base URL for that
workspace was missing.

## Failure Signal 2: Local OpenCode Route Not Reachable

done: true

Later send attempts reached a concrete local OpenCode URL, but the target was not
listening.

The server attempted to create an OpenCode session:

- `send-workflow-trace.server.ndjson:42`
  - `event:"server:opencode-json:start"`
  - `method:"POST"`
  - `path:"/session"`
  - `workspaceId:"ws-8df10915b772"`
  - `targetUrl:"http://127.0.0.1:60956/workspace/ws-8df10915b772/opencode/session"`
  - `directory:"c:\\users\\jajse\\desktop\\veslo\\test-repo3"`
- `send-workflow-trace.server.ndjson:43`
  - `event:"server:opencode-json:error"`
  - `path:"/session"`
  - `error:"Unable to connect. Is the computer able to access the url?"`
  - `durationMs:1`

The same session-create failure repeated:

- `send-workflow-trace.server.ndjson:49`
  - `event:"server:opencode-json:start"`
  - `targetUrl:"http://127.0.0.1:60956/workspace/ws-8df10915b772/opencode/session"`
- `send-workflow-trace.server.ndjson:50`
  - `event:"server:opencode-json:error"`
  - `error:"Unable to connect. Is the computer able to access the url?"`
  - `durationMs:1`

The UI surfaced this as:

- `send-workflow-trace.ui.ndjson:171`
  - `event:"conversation_create_failed"`
  - `upstreamCode:"opencode_request_failed"`
  - `upstreamStatus:502`
- `send-workflow-trace.ui.ndjson:179`
  - `event:"sendPromptImmediate:result"`
  - `accepted:false`
  - `status:"failed"`
  - `code:"conversation_create_failed"`
  - `error:"OpenCode request failed"`
- `send-workflow-trace.ui.ndjson:214`
  - repeated `conversation_create_failed`
  - `upstreamCode:"opencode_request_failed"`
  - `upstreamStatus:502`
- `send-workflow-trace.ui.ndjson:222`
  - repeated terminal result
  - `accepted:false`
  - `error:"OpenCode request failed"`

## Failure Signal 3: Existing Session Prompt Submit Also Failed

done: true

An existing-session send then attempted `prompt_async` against the same local
route base and failed immediately:

- `send-workflow-trace.server.ndjson:56`
  - `event:"server:conversation-run:opencode-submit-body"`
  - `kind:"prompt_async"`
  - `model.providerID:"codex_oauth"`
  - `model.modelID:"gpt-5.5"`
  - `variant:"xhigh"`
  - `textChars:6`
- `send-workflow-trace.server.ndjson:58`
  - `event:"server:opencode-json:start"`
  - `method:"POST"`
  - `path:"/session/ses_0bb7aff1effe37ZRV68wGhmxTX/prompt_async?directory=c%3A%5Cusers%5Cjajse%5Cdesktop%5Cveslo%5Ctest-repo3"`
  - `targetUrl:"http://127.0.0.1:60956/workspace/ws-8df10915b772/opencode/session/ses_0bb7aff1effe37ZRV68wGhmxTX/prompt_async?directory=c%3A%5Cusers%5Cjajse%5Cdesktop%5Cveslo%5Ctest-repo3"`
- `send-workflow-trace.server.ndjson:59`
  - `event:"server:opencode-json:error"`
  - `error:"Unable to connect. Is the computer able to access the url?"`
  - `durationMs:1`
- `send-workflow-trace.server.ndjson:60`
  - `event:"server:conversation-run:opencode-submit:error"`
  - `outcome:"error"`
  - `message:"OpenCode request failed"`
  - `durationMs:3.49`
- `send-workflow-trace.server.ndjson:61`
  - `event:"server:conversation-run:lifecycle-reconcile-scheduled"`
  - `reason:"submit-failed"`

The UI terminal result:

- `send-workflow-trace.ui.ndjson:259`
  - `event:"run_submit_failed"`
  - `upstreamCode:"opencode_request_failed"`
  - `upstreamStatus:502`
- `send-workflow-trace.ui.ndjson:262`
  - `event:"sendPrompt:server-submit-existing-failed"`
  - `code:"opencode_request_failed"`
  - `message:"OpenCode request failed"`
  - `draftDisposition:"restore"`
- `send-workflow-trace.ui.ndjson:265`
  - `event:"sendPromptImmediate:result"`
  - `accepted:false`
  - `status:"failed"`
  - `code:"opencode_request_failed"`
  - `error:"OpenCode request failed"`
  - `targetSessionId:"ses_0bb7aff1effe37ZRV68wGhmxTX"`

## What The Logs Do Not Show

done: true

- No `opencode-health.ndjson` was produced, so this run does not contain a
  direct OpenCode health probe timeline.
- No `send-workflow-trace.orchestrator.ndjson` was produced, so the trace does
  not prove an orchestrator process successfully started.
- No `runtime-trace.ndjson` was produced from this release EXE run.
- The app was launched through `Start-Process`, so lack of console output is not
  meaningful; the useful evidence is in the trace files above.

## Working Hypothesis For Follow-Up

done: false

The release EXE / production-mode runtime did not make the local OpenCode route
available before the send path used it. The strongest current signal is not DEN
auth or model availability; it is local runtime availability/routing:

- the server knew a local OpenCode route base at `127.0.0.1:60956`;
- the route rejected all tested OpenCode calls with immediate connection
  failures;
- no OpenCode health/orchestrator trace appeared;
- no successful submit/lifecycle completion appeared.

The next fix/audit should focus on the release-mode startup contract between:

- desktop startup and server spawn;
- server workspace registration;
- OpenCode/orchestrator process startup;
- base URL publication/readiness gating before first send;
- production-mode logging coverage for orchestrator/OpenCode health.

## Next Verification Gates

done: false

1. Re-run the release EXE with the same trace env and a fully isolated profile
   including `APPDATA` and `LOCALAPPDATA`, not only Veslo-specific data envs.
2. Capture process snapshots at send time and verify whether any `opencode` or
   `veslo-orchestrator` process exists.
3. Require an `opencode-health.ndjson` or equivalent production-mode health trace
   before the send path is considered ready.
4. Verify whether `127.0.0.1:60956` is actually bound/listening before the first
   `POST /session`.
5. Compare the same action against `pnpm dev` manual runtime, where previous dev
   traces showed OpenCode health eventually became healthy and sends completed.
