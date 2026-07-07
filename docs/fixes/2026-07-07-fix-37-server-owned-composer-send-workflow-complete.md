# Fix 37: Server-Owned Composer Send Workflow Complete

Date: 2026-07-07

## Scope

Completed the core gate from
`docs/plans/2026-07-06-server-owned-composer-send-workflow-implementation-plan.md`.
This checkpoint covers the codebase implementation and regression gates for the
server-owned composer input submit path.

Installed-runtime E2E and tauri-pilot validation are intentionally skipped for
this checkpoint; the completion decision is based on source, server/app tests,
typechecks, and the plan's explicit core-gate definition.

## Evaluation

The implementation plan is complete by its own criteria:

- Top-level plan status is `implemented` and `done: true`.
- BSW00 through BSW11 are marked done for the core gate.
- BSW01A and BSW05A are included in the completed gate.
- BSW07B was promoted after the core gate and is now implemented as a
  server-owned replacement workflow; BSW08A remains an explicit follow-up and
  is allowed to stay `done: false`.
- BSW06B remains a documented follow-up for full raw attachment byte staging.

This is not a claim that every possible follow-up in the document is finished.
It is a claim that the plan's defined core migration is finished and protected
by tests.

## Problem

The composer send workflow still had app-owned submit behavior after the server
conversation route work:

- The app resolved prompt, shell, slash command, compact, and some skill-command
  behavior before calling the server.
- Existing-session and first-session input sends could still prepare runtime
  locally and fall back to app-side run submission.
- Attachment policy and OpenCode run part construction were still partly owned
  by the frontend.
- Active-run conflict handling and idempotency needed one server-owned result
  contract for submitted, queued, blocked, and failed outcomes.
- The composer cleared drafts before the server-owned submit result could tell
  the UI whether the draft was accepted.

## Fix

- Added server-side draft resolution for prompt, shell, slash/command, compact,
  document-runtime blocking, staged file references, and model-aware attachment
  policy.
- Routed existing-session and first-session input sends through
  `submitConversationFromVesloWriteApi` and the server submit contract.
- Let the server own local runtime admission, active-run lifecycle admission,
  queue insertion, idempotent submit-attempt results, and typed blocked/failed
  responses.
- Added typed submit results and `draftDisposition` so the composer clears the
  editor only after an accepted server-owned submit result.
- Kept remote workspace submit fail-closed with `remote_submit_unavailable`
  until remote server delegation is implemented.
- Removed wired production use of frontend prompt-part construction and legacy
  run fallback from the server-owned input submit path.
- Follow-up cleanup isolated the old direct-run compatibility path behind
  `createLegacyConversationRunFallback`, removed the old run-part/runtime
  dependencies from the main `createSessionSendWorkflow` dependency object, and
  renamed the bounded server-submit file ref adapter to
  `stageServerSubmitAttachments`.
- Existing-session server submit now fails closed when target workspace or
  directory resolution is missing, so frontend skill-resolution skip cannot fall
  through into legacy submit.
- Added `docs/dev/server-owned-composer-submit.md` for the resulting contract.
- Recorded additional hardening in
  `docs/fixes/2026-07-07-fix-36-server-owned-legacy-fallback-hardening.md`.

## Scope Boundaries

The following remain outside this completed core gate:

- BSW06B: full server-side raw attachment byte staging beyond existing
  file-session references and bounded inline payloads.
- BSW08A: durable server queue APIs for the full app-local draft queue UI.

BSW07B is no longer an outside follow-up: edit-message replacement uses the
server-owned compensating workflow. Replacement failure surfacing is tracked
and closed by the follow-up audit plan rather than by the core gate record.

The app may keep compatibility or test-only paths for missing submit adapters
and explicit follow-up workflows, but the wired production composer input send
path now goes through the server submit contract.

## Verification

Run on 2026-07-07:

```powershell
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-creation-workflow.test.ts src/app/tests/pages/session-mutation-workflow.test.ts src/app/tests/app-send-prompt-session-creation.test.ts src/app/tests/pending-session-send-flow.test.ts src/app/tests/components/session/composer-send-intent.test.ts src/app/tests/components/session/composer-screenshot-staging-regression.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-send-preflight-context.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-session-prompt-error.test.ts
pnpm --filter @neatech/veslo-ui exec node scripts/legacy-symbol-audit.mjs --limit=40
pnpm --filter veslo-server typecheck
bun test packages/server/src/tests/server-conversations.test.ts packages/server/src/tests/conversation-submit-service.test.ts packages/server/src/tests/conversation-run-lifecycle-controller.test.ts packages/server/src/tests/conversation-run-queue-store.test.ts packages/server/src/tests/conversation-service.test.ts
git diff --check
```

Results:

- App unit suite: `2431` passed, `0` failed, `12` skipped.
- Focused send workflow suite after the legacy-symbol cleanup: `26` passed,
  `0` failed.
- Focused send/source-contract bundle after the fallback extraction: `66`
  passed, `0` failed.
- Send preflight source contract: `5` passed, `0` failed.
- Prompt error display source contract: `1` passed, `0` failed.
- Legacy symbol audit dependency-object matches dropped from `10` to `4`; the
  normal send workflow no longer exposes the old direct-run dependency list.
- App typecheck passed.
- Server typecheck passed.
- Server conversation/submit/lifecycle/queue bundle: `83` passed, `0` failed.
- `git diff --check` passed with LF/CRLF warnings only.

## Status

Implementation is complete for the server-owned composer send workflow core
gate. The remaining work is tracked as explicit follow-up scope in the plan, not
as hidden unfinished core implementation.
