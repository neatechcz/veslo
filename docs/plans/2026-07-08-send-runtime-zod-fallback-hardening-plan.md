---
title: Send Runtime Zod Fallback Hardening Plan
date: 2026-07-08
status: draft
done: false
source_audit: chat:2026-07-08-legacy-symbol-audit-send-runtime-fallback
audit_artifact: .tmp/legacy-symbol-audit-latest.json
validation_switch: VITE_VESLO_SEND_BOUNDARY_VALIDATION
trace_mirror: .tmp/send-workflow-trace.ndjson
srfz00_single_switch_contract_done: true
srfz01_legacy_fallback_input_validation_done: true
srfz02_runtime_recovery_validation_done: true
srfz03_attachment_staging_validation_done: true
srfz04_server_submit_boundary_coverage_done: true
srfz05_compact_replace_boundary_coverage_done: true
srfz06_runtime_log_summary_done: false
srfz07_verification_done: true
---

# Send Runtime Zod Fallback Hardening Plan

## Goal

done: false

Use Zod where it carries business value in the message send workflow: from
runtime preparation, through legacy compatibility fallback, attachment staging,
server submit, OpenCode submit, AI gateway/provider handoff, and the result
processing back into the app.

This is a KISS hardening plan. The product requirement is not "perfect schema
coverage everywhere"; it is:

- malformed Veslo-owned send boundary payloads are visible in runtime logs,
- production/release sends keep working in report mode,
- focused debugging can switch to strict mode and fail closed,
- the important business phases are distinguishable in trace output,
- no raw prompts, transcripts, bearer tokens, gateway tokens, or model bodies
  are written into validation logs.

## Implementation Update 2026-07-08

done: false

Implemented SRFZ00-SRFZ05 and the targeted SRFZ07 verification slice.

- Added Zod guards for legacy fallback prepare input and submit input. They
  use the existing `VITE_VESLO_SEND_BOUNDARY_VALIDATION` mode and emit
  `validation-checked` / `validation-failed` send trace events.
- Added staged attachment result validation before model routing on the legacy
  fallback path and before server submit for existing-session attachment sends.
- Added routed composer draft result validation before using staged attachment
  routing output.
- Extended compact and replace-message server submit paths to validate submit
  request and terminal submit result shapes with the existing conversation
  submit schemas.
- Extended replacement legacy runtime preflight to validate the runtime
  preparation result before running the legacy revert/send path.
- Wired the existing validation mode resolver into the mutation workflow; no
  second switch or parallel Zod configuration was added.

SRFZ06 remains open in this tracked plan because the runtime-log summary tool
was not added or promoted as part of this patch.

Targeted verification passed:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-mutation-workflow.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-attachment-staging.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check -- packages/app/src/app/lib/send-boundary-validation.ts packages/app/src/app/pages/session-send-workflow.ts packages/app/src/app/pages/session-mutation-workflow.ts packages/app/src/app/app.tsx packages/app/src/app/tests/pages/session-send-workflow.test.ts packages/app/src/app/tests/pages/session-mutation-workflow.test.ts docs/plans/2026-07-08-send-runtime-zod-fallback-hardening-plan.md
```

## Existing Contract To Preserve

done: false

There is already one central app-side switch:

- `VITE_VESLO_SEND_BOUNDARY_VALIDATION=off`
  - no validation trace events,
  - no send blocking from validation.
- `VITE_VESLO_SEND_BOUNDARY_VALIDATION=report`
  - default mode,
  - successful checks emit `validation-checked`,
  - malformed payloads emit `validation-failed`,
  - send continues.
- `VITE_VESLO_SEND_BOUNDARY_VALIDATION=strict`
  - validation failures can fail closed,
  - intended for focused debugging and tests, not broad production rollout.

Do not add a second Zod enable/disable mechanism. Every new guard in this plan
must use the existing send boundary validation mode and existing send trace
surfaces.

The expected developer output locations remain:

- `.tmp/send-workflow-trace.ndjson`
- timestamped runtime `send-workflow-trace.ndjson` printed by startup
- WebView `window.__vesloSendTrace`
- DevTools `[SENDTRACE] app:<event>`
- Tauri/dev terminal `[ui:send-trace] <event> <json>`

## Current Audit Summary

done: false

The legacy symbol audit did not identify a new single obvious crash point. It
did confirm one high-value hardening cluster:

- legacy conversation run fallback,
- frontend runtime admission,
- attachment staging and prompt-part routing,
- low-level run submit bridge,
- compact and replace-message follow-up paths,
- runtime readiness fallback via legacy engine-ready state.

Lower-risk legacy/fallback symbols such as sidebar archive keys, UI transition
fallbacks, offline transcript fallback, and remote tokenless fallback should
not be included in this implementation unless fresh runtime evidence ties them
to send failure.

## Non-Goals

done: false

- Do not rewrite the send workflow.
- Do not remove the legacy fallback in this plan.
- Do not add a new global runtime validation framework.
- Do not make report-mode validation block production sends.
- Do not validate or log full prompt text, model response bodies, transcripts,
  file bytes, or secrets.
- Do not fix unrelated legacy names only because the audit script reports them.
- Do not add UI settings for this. The current environment switch is enough.

## KISS Shape

done: false

Add small boundary validations at places where the app crosses ownership or
compatibility boundaries:

1. fallback prepare input,
2. runtime preparation result and recovery result,
3. attachment staging input/output,
4. routed draft / OpenCode part construction result,
5. server submit request/result,
6. compact and replace-message follow-up boundaries.

Each guard must:

- use `safeParse`,
- trace a compact failure summary,
- return the original value in report mode,
- fail closed only in strict mode,
- classify the phase so the runtime log answers "where did the send fail?"
  without requiring source-code archaeology.

## SRFZ00: Keep One Validation Switch

done: false

Confirm the existing validation mode resolver remains the only app-side switch.

Implementation:

- Keep `VITE_VESLO_SEND_BOUNDARY_VALIDATION` as the single switch.
- Keep default mode as `report`.
- Add or adjust a source-level regression test if a new validation module is
  introduced, so new guards cannot read a parallel env var.
- Keep docs in `docs/dev/development-startup.md`,
  `docs/dev/state-and-config-reference.md`, and
  `docs/dev/opencode-workspace-runtime-architecture.md` aligned only if the
  user-facing behavior changes.

Acceptance:

- `off`, `report`, and `strict` still resolve exactly as documented.
- New validation events disappear in `off`.
- New validation events report but do not block in `report`.
- New validation events can block in `strict`.

## SRFZ01: Validate Legacy Fallback Prepare And Submit Inputs

done: false

The fallback helper is the current stable ownership boundary for much of the
message send workflow. Guard it directly instead of trying to infer correctness
later from lower-level failures.

Implementation:

- Add Zod schemas for fallback prepare input and fallback submit input.
- Require the business identifiers that make a send meaningful:
  - `clientMessageId`,
  - target workspace id or resolvable workspace scope,
  - conversation/session identity when sending to an existing session,
  - pending client session id when materializing a new session,
  - draft mode,
  - trace id when available.
- Summarize draft shape without raw prompt text:
  - mode,
  - text length,
  - part count,
  - attachment count,
  - command name if present.
- In report mode, continue the send and emit a `validation-failed` trace.
- In strict mode:
  - fallback prepare returns blocked/not-ready,
  - fallback submit restores the pending draft and returns a typed failure.

Acceptance:

- A missing workspace/session scope is visible as a fallback input validation
  failure before attachment staging or submit.
- A malformed draft summary does not throw from the validator.
- Tests prove report mode preserves the current user-facing behavior.

## SRFZ02: Tighten Runtime Preparation And Recovery Validation

done: false

Runtime readiness is only useful if the trace distinguishes local runtime-chain
recovery from generic connectivity or managed/cloud failures.

Implementation:

- Reuse the existing runtime preparation result validation.
- Ensure both initial preflight and one-time recovery validation include:
  - event phase,
  - workspace id,
  - active workspace flag,
  - recovery attempted flag,
  - runtime-ready flag,
  - managed-AI-ready flag,
  - `clientMessageId` when available.
- Keep recovery bounded to one retry with the same `clientMessageId`.
- Add negative coverage so managed/cloud/auth-ish failures cannot trigger the
  local runtime recovery path just because their message text resembles a
  socket or health failure.

Acceptance:

- `runtime-preflight` and `runtime-recovery` validation failures are separate
  in trace output.
- `engine_starting` / `engine_not_running` style local failures remain
  recoverable only inside the intended local-runtime path.
- `skipHealth` or quiet reconnect paths do not create false-ready send state
  without a second readiness gate.

## SRFZ03: Validate Attachment Staging And Routing

done: false

Attachment staging is a business-critical compatibility path. It can fail
legitimately, but the failure should identify the staging/routing phase instead
of later surfacing as a generic send failure.

Implementation:

- Add compact Zod schemas for staged attachment output:
  - name,
  - kind,
  - mime type,
  - file-session path or bounded inline representation marker,
  - no raw base64/file bytes in traces.
- Validate before model routing.
- Validate the routed draft result:
  - success means draft shape is still usable for submit,
  - failure means a user-facing attachment/model routing error exists.
- Preserve existing cleanup semantics; validation must not skip file-session
  close/finally behavior.

Acceptance:

- Staging failure, routing failure, and submit failure are distinguishable.
- Report mode never blocks solely because attachment validation failed.
- Strict mode fails closed before submit when staged attachment shape is
  malformed.

## SRFZ04: Cover Server Submit Request And Terminal Result Boundaries

done: false

Existing schemas already cover the server-owned submit request and terminal
submit result. This task makes coverage complete across both first-message and
existing-conversation branches.

Implementation:

- Verify first-message server submit validates the request before calling the
  server.
- Verify existing-conversation server submit validates the request before
  calling the server.
- Validate terminal submit results for:
  - submitted,
  - queued,
  - blocked,
  - failed.
- Include the failure phase classifier in trace context so failures map to:
  - runtime preflight,
  - managed-AI auth prime,
  - server session create,
  - server run submit,
  - queued run drain,
  - contract validation.

Acceptance:

- A malformed server submit result cannot silently clear the composer in
  strict mode.
- In report mode, malformed server result traces but existing UI behavior is
  preserved.
- The trace payload gives enough phase context to separate OpenCode submit,
  AI gateway/auth, and queue/lifecycle failures.

## SRFZ05: Add Minimal Coverage For Compact And Replace-Message Follow-Ups

done: false

Compact and replace-message are not the primary send path, but they use the
same runtime preparation and can break the user-visible message workflow after
send stabilization.

Implementation:

- Validate runtime preparation results for compact and replace-message flows.
- Add compact trace context:
  - session id,
  - workspace id if available,
  - operation name,
  - validation mode.
- For replace-message, validate the server submit request/result with the same
  submit schemas used by normal send.
- Do not move compact/replacement ownership in this plan.

Acceptance:

- Compact and replace-message validation failures are visible in runtime logs.
- Report mode preserves current behavior.
- Strict mode does not proceed with a malformed replace submit request.

## SRFZ06: Make Runtime Log Inspection Cheap

done: false

The runtime trace already writes to a gitignored mirror. The missing piece is a
small, repeatable way to answer: "What did Zod report in the last run?"

Implementation:

- Add or reuse a small script that reads `.tmp/send-workflow-trace.ndjson` and
  prints:
  - validation failures by event,
  - first and last timestamp,
  - phase counts,
  - related `clientMessageId`,
  - workspace/session ids,
  - issue paths/messages,
  - without prompts, transcripts, tokens, or raw model bodies.
- Keep it optional developer tooling; do not make runtime depend on the script.
- Document one PowerShell command in the plan implementation note once the
  script exists.

Acceptance:

- After `pnpm dev`, a developer can inspect the last validation failures from
  `.tmp/send-workflow-trace.ndjson` without opening DevTools.
- Missing trace file exits cleanly with an explanatory message.

## SRFZ07: Verification Gate

done: false

Minimum targeted verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-attachment-staging.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-mutation-workflow.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

If server files are touched:

```powershell
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin
```

Manual runtime smoke after code changes:

```powershell
$env:VITE_VESLO_SEND_BOUNDARY_VALIDATION = "report"
pnpm dev
```

Then perform one manual new-message send and one existing-conversation send.
Inspect:

```powershell
Get-Content .tmp\send-workflow-trace.ndjson -Tail 200
```

Strict debugging smoke:

```powershell
$env:VITE_VESLO_SEND_BOUNDARY_VALIDATION = "strict"
pnpm dev
```

Strict mode is accepted only if normal valid sends still work and intentionally
malformed test fixtures fail closed with a typed trace event.

## Completion Criteria

done: false

This plan is done only when:

- SRFZ00 through SRFZ07 are complete,
- report mode continues to allow valid sends,
- strict mode fails closed on malformed Veslo-owned send boundary payloads,
- `.tmp/send-workflow-trace.ndjson` shows validation events during `pnpm dev`,
- validation trace payloads contain no prompt text, transcripts, file bytes,
  bearer tokens, gateway tokens, or raw model responses,
- the legacy symbol audit still may report compatibility fallback names, but
  the business-critical fallback path has explicit validation and trace
  ownership.
