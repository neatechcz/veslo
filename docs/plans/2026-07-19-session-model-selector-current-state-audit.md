---
title: Session Model Selector - Current State Audit
date: 2026-07-19
status: audit
done: false
scope: Current implementation, visibility conditions, authorization path, and release evidence for managed-AI session model selection
repository_snapshot: main at 71215b07f6907a261010558a22e64ff3e2313ddf
---

# Session Model Selector - Current State Audit

## Executive conclusion

The optional session-model selector is implemented end to end in the current
`main` checkout. It is intentionally dormant by default and is not yet proven
as a production-ready product feature: the implementation plan remains
`proposed` / `done: false`, and no repository evidence proves the manual
release scenario with two real healthy models.

The practical reason a user can see a setting but not an actual model picker is
the visibility gate below. The Setting is only a local UI feature flag; it
does not publish models or grant access.

```text
platform policy enables >= 2 healthy models for one provider
  + user has managed-AI access for that provider
  + gateway access refresh returns that live roster
  + local "Session model selector" preference is ON
  => model <select> is rendered in the session composer
```

With only one enabled model in the live platform policy, the setting can be
enabled successfully but no selector is rendered. This is expected behavior,
not a hidden user-level selector or a client defect.

## What an administrator controls

The AI Gateway platform model policy owns `enabledModels` and exactly one
`activeModel`. The active model remains the managed fallback/default. When the
platform policy changes, the repository transaction synchronizes the roster
and default for enabled assignments of the active provider. This first
increment is therefore **not** an individual per-user model-policy feature:
the roster is platform-published for all assigned users of the provider.
The composer lists every published model in that roster; `>= 2` is only the
visibility threshold, not a two-model product limit. Models from another
provider are not publishable to the same assignment in this increment.

Relevant owners:

- `services/ai-gateway/src/http/admin.ts` builds assignments from the active
  platform provider and its enabled roster, and rejects a caller-supplied user
  model policy.
- `services/ai-gateway/src/model-policy/mysql-repository.ts` updates the
  platform policy and synchronizes enabled assignment rosters transactionally.
- `services/ai-gateway/src/access/authorized-model-roster.ts` computes the
  intersection of a user's stored roster and the current platform policy.

The gateway exposes that computed roster through
`GET /api/me/ai-access` as both compatibility IDs (`allowedModels`) and
capability-bearing descriptors (`selectableModels`) in
`services/ai-gateway/src/http/user-credentials.ts`. A missing platform policy
produces no authorized roster.

## Desktop behavior and why the picker is absent today

`packages/app/src/app/pages/settings.tsx` renders the visible "Session model
selector" switch only when managed AI is configured. Its state is stored under
`veslo.sessionModelSelectorEnabled` through
`context/app-startup-hydration.ts`; it defaults to `false`.

That switch does not choose a model. The actual picker lives in
`packages/app/src/app/pages/session.tsx` and renders only when:

1. the local preference is enabled; and
2. the current live access profile contains more than one `selectableModel`.

The current implementation stores at most one transient `{ providerID,
modelID }` slot labelled with the active composer/session UI key. It does not
persist a map by session ID, write model choice into the transcript, or restore
a prior selection after restart. When navigating A -> B, B therefore uses the
managed default unless selected there; returning to A can show A's earlier
selection again, provided the single slot has not since been replaced by a
selection in B.

The picker option named `Workspace default` is technically misleading. Empty
selection means "omit the override"; the effective fallback is the
managed-AI `effectiveModel` / platform `activeModel` (or the existing global
runtime fallback), rather than a user-configured workspace-specific default.

## Send, queue, retry, and runtime path

When an eligible model is selected, `SessionView` snapshots it before the
send path chooses immediate send, local queue, server queue, or implicit-skill
confirmation. The snapshot is carried through:

- queued drafts and queued-draft edits;
- implicit-skill confirmation;
- retry-last-prompt; and
- existing-session and first-session server submit paths.

The app writes the snapshot as `options.model` in the existing
`VesloConversationSubmitRequest`; it does not rewrite the workspace default.
Without an override, the field is omitted and the normal managed default
path remains intact. The relevant owners are
`pages/session-conversation-flow.ts`, `pages/session-send-workflow.ts`,
`pages/session-mutation-workflow.ts`, and
`components/session/session-queue-model.ts`.

Turning the local preference off clears the transient selection and strips
local queued, retry, and pending-confirmation overrides. It deliberately does
not alter an already dispatched or server-accepted run.

The app registers all live selectable models in the managed OpenCode provider
configuration, while keeping top-level `config.model` equal to the effective
managed default. The implementation is in `lib/ai-access.ts` and
`context/managed-ai-runtime-config.ts`.

## Authorization and attachment safety

The client is not the authorization boundary. Before forwarding a provider
request, the gateway injects the default when `model` is absent and validates
the resulting model against the live authorized roster in
`http/providers/access-policy.ts`. A forged, stale, disallowed, or platform-
removed model returns `403 model_not_allowed`.

Image input has a stricter contract. Before draft resolution accepts an image,
the Veslo server obtains a request-scoped authenticated capability descriptor
from the gateway and fails closed if it is missing or unknown. The descriptor
is used for validation only; the later OpenCode body receives only the
sanitized model reference. See:

- `packages/server/src/server.ts` for the authenticated descriptor resolver
  and bounded cache;
- `packages/server/src/routes/conversations.ts` for wiring it before submit;
- `packages/server/src/conversation-submit-draft-resolution.ts` for the
  attachment decision; and
- `services/ai-gateway/src/providers/model-capability-registry.ts` for the
  reviewed catalog.

At this snapshot, `gpt-5.6-sol` is the only listed Codex model with explicit
image capability. Other catalogued Codex models have `capabilityStatus:
unknown`: text inference may be authorized, but image input is fail-closed.

## Release, production, and readiness evidence

The repository contains production evidence that the current active Codex
model `gpt-5.6-sol` was repaired and verified with two healthy credentials:
`docs/fixes/2026-07-17-fix-57-gpt-5-6-sol-ai-gateway-readiness.md`.
That is **not** evidence of two enabled models. The deployment guidance in
`docs/dev/cloud-deployments.md` describes migration to a single-model roster
`["gpt-5.6-sol"]`, which would intentionally keep the desktop picker hidden.

No live production policy was queried in this audit. Do not claim that a
second model is currently enabled without checking the AI Gateway admin
platform policy and its healthy-capability evidence.

No selector-specific deployment is needed merely to enable a second model.
The selector, gateway authorization, and local Veslo-server path are already
ancestors of the current `main` release line. Git confirms that the model
selector implementation commit `92271fef` is included before the 2026-07-19
release-related commits `da24a1a0` (owned-server) and `8b9cd60a` (desktop MSI
validation). Release evidence reviewed for this audit reports that both of
those deployment/build paths succeeded on 2026-07-19.

Consequently, enabling an additional model requires only an AI Gateway
platform-policy update: add a healthy same-provider model to `enabledModels`
and keep one model `active`. The admin policy save already verifies capability
evidence for every enabled model and synchronizes the roster to assigned users.
It does not require a DEN migration or an owned-server deployment. A new
desktop release is needed only after an app/UI change; a new owned-server
deployment is needed only after gateway or Veslo-server code changes.

## Verification performed in this checkout

- `pnpm --filter @neatech/ai-gateway test`: 504 passed, 0 failed.
- Focused app tests covering the model roster, managed config, queue/retry,
  hydration wiring, and send workflow: 193 passed, 0 failed.
- The rendered selector DOM test verifies that it stays absent below two models,
  renders every item of a three-model roster, emits an explicit selected override, and
  returns to the managed default on empty selection.
- Focused server model descriptor and conversation-submit tests: 48 passed,
  0 failed.
- Typechecks passed for `@neatech/ai-gateway`, `veslo-server`, and
  `@neatech/veslo-ui`.

The complete app unit command is currently red with 20 failures (2,879 passed
of 2,922 tests in the latest local run). They include
lifecycle trace, composer target, pending-session materialization, managed-AI
config sync, permission polling, skill registry, unread state, and multiple
session-route contracts. This audit did not triage whether each failure is
unrelated to the selector, so it must not describe them as one unrelated
source-shape failure or treat the full app unit gate as green. One confirmed
failure is the brittle source-shape assertion in
`packages/app/src/app/tests/session-route-client-resume.test.ts`, which expects
an older exact `app.tsx` form for `currentComposerStorageKey`.

## Remaining work before calling the feature complete

### P1 - Release proof

1. In AI Gateway admin, publish the healthy same-provider model roster users
   should be able to choose from (at least two models) and choose one active
   fallback model.
2. Confirm the signed-in user's `/api/me/ai-access` returns every published
   `selectableModels` roster item after a fresh desktop access/config refresh.
3. In a real Tauri desktop run, enable the setting, select a non-default
   model, send text, queue a second prompt, change selection, and verify that
   both accepted runs retained their respective snapshots.
4. Select an explicitly image-capable published model and verify a successful
   image send. Separately, select an unknown or known non-image model and
   verify that image input is blocked before a run with
   `model_capabilities_unavailable`.
5. Disable the setting and verify that the picker disappears, local pending
   overrides are removed, and a new send omits `options.model` while a
   previously accepted run is not altered.

### P2 - Product/maintenance cleanup

- Keep `docs/plans/2026-07-17-optional-session-model-selector-plan.md` as
  `proposed` until the P1 manual release verification is complete; then update
  its status and repository snapshot.
- Triage all 20 current app-unit failures before using the full app unit suite
  as release evidence; repair or update the relevant tests and implementation.

### Completed local P2 work

- The picker is now a focused `SessionModelSelector` component with a busy
  disable state, localized label/default copy, and image-capability labels. Its
  default option is named `Managed default`, not `Workspace default`.
- If a refreshed roster removes the active transient selection, the composer
  explains that it falls back to the managed default instead of silently
  dropping the selection.
- Settings now explains that the local preference reveals nothing until the
  Gateway publishes two or more eligible models, then exposes the whole roster.
- The rendered selector has an automated DOM test for visibility, all roster
  items, override selection, and returning to the managed default; it runs in the existing
  `test:renderer-recovery` unit gate.
- The managed-AI contract is reconciled in
  `docs/features/settings-and-preferences.md`,
  `docs/features/session-runtime.md`,
  `docs/admin-managed-ai-access.md`, and
  `docs/dev/state-and-config-reference.md`.

## Questions for the next evaluator

1. Does the currently deployed platform policy actually contain a second
   healthy enabled same-provider model, or only `gpt-5.6-sol`?
2. Is the roster-wide synchronization intentional product policy, or should a
   later phase add per-user entitlement/roster management?
3. Should a session selection remain transient as implemented, or be retained
   as explicit session metadata in a separate product decision?
4. Is the image-capability registry sufficiently complete for every model that
   product intends to expose in the first rollout?
