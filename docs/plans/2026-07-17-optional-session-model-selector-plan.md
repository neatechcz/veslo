---
title: Optional Session Model Selector Plan
date: 2026-07-17
status: proposed
done: false
repository_snapshot: commit 1d256695f5ae9720b15f9df43fecbbfa4cce8d62 with unrelated dirty working tree
repository_commit: 1d256695f5ae9720b15f9df43fecbbfa4cce8d62
working_tree_scope: documentation-only plan; existing dirty app, E2E, and fixes work is excluded
scope: managed-AI session model selection, gateway authorization, runtime model registration, and optional UI exposure
---

# Optional Session Model Selector Plan

## Decision

Add an optional model selector to a session, but preserve the current single
default-model behavior as the default and as the complete fallback path.

The first increment permits choosing among the **administrator-published,
healthy models for the already assigned managed-AI provider**. It does not
permit raw model IDs, credential selection, or switching providers. For the
current managed path this means multiple `codex_oauth` models can be exposed
only after they are enabled in the gateway platform policy and assigned to the
user's access policy.

There are two deliberately separate concerns:

1. Gateway policy is authoritative. It decides which models a user may run and
   rejects every other request, including a request forged outside the UI.
2. A local UI preference controls whether the selector exists in Veslo. It is
   off by default. When off, the app emits no model override, atomically clears
   all not-yet-accepted local override snapshots, and the existing
   server/runtime default is used. A run already accepted by the server is not
   rewritten or cancelled.

This makes the product feature reversible without turning the fallback into a
second implementation: disabling or later removing the UI leaves the current
`effectiveModel`/global-default path intact. The preference is not an
authorization boundary; the gateway allow-list remains the boundary.

## Current codebase facts and constraints

### Current model resolution is intentionally single-default

`packages/app/src/app/app.tsx` resolves every session through
`modelForSession`. It returns the managed access `effectiveModel` when present,
otherwise the global runtime default. Its source contract explicitly rejects
the previous `sessionModel*ById` maps. The app also clears the legacy
`veslo.sessionModels` local-storage data at startup and reset.

The plan must therefore not revive a persistent `Record<sessionId, ModelRef>`
in `app.tsx`, not make transcript history the source of the current model, and
not restore the legacy storage key.

### The gateway already has the essential authorization primitive

`services/ai-gateway/src/http/providers/access-policy.ts` normalizes a request
model, supplies the user's `defaultModel` when it is omitted, and rejects a
model outside `UserAiAccessPolicyRecord.allowedModels`. The proxy obtains that
record before provider routing. `GET /api/me/ai-access` already returns the
same provider, default/effective model, and allowed-model fields.

Today this cannot expose a useful picker: assigning user access in
`services/ai-gateway/src/http/admin.ts` writes only the platform active model
to `allowedModels`, and the public admin endpoint deliberately refuses a
caller-supplied user model policy. The platform policy does have an
`enabledModels` roster, but it is not currently applied as a runtime request
guard by the provider proxy. A picker based only on app-side provider metadata
would therefore be both misleading and bypassable.

### Attachment capability, runtime configuration, and server submit need distinct changes

The managed runtime configuration writes `effectiveModel` as the OpenCode
default and currently registers only that one provider model. This default
must remain unchanged, but every selectable model also has to be registered
with the managed provider or OpenCode cannot route a per-run override.

An image attachment has an additional hard contract. The server's
`conversation-submit-draft-resolution.ts` accepts only a model descriptor with
`attachment: true` or `modalities.input` containing `image`; a bare
`{ providerID, modelID }` is deliberately blocked as
`model_capabilities_unavailable`. The gateway's current access response
contains model IDs only. A UI roster of `ModelRef`s is therefore insufficient
for attachment-bearing sends.

The server-owned conversation-submit contract already accepts
`options.model` and forwards it to the OpenCode run body. The app's existing
server-submit paths resolve a model mostly for attachment routing, but do not
put it into `VesloConversationSubmitRequest.options.model`. The selector must
use this existing request field rather than rewrite workspace configuration.

`SessionView` renders both a centre and footer `Composer`. A selector belongs
to the session/page boundary and must feed both placements from one state; it
should not be implemented as two independent composer-local controls.

## Target behavior

| Situation | Visible UI | Submitted model | Runtime default |
| --- | --- | --- | --- |
| Preference off, absent access catalog, or fewer than two eligible models | No selector | Omit `options.model` | Existing managed `effectiveModel`, else global default |
| Preference on with eligible models | One selector beside the active session composer | Explicit selected model snapshot, captured at send acceptance | Still `effectiveModel` |
| Selection becomes unavailable before send | Selector falls back to default and explains the refresh | Omit override or use current default | Unchanged |
| Preference changes from on to off after local acceptance | Selector disappears | Strip the local queue/retry/confirmation snapshot; a later drain uses the default | Unchanged |
| Server has already accepted a model-A run when preference turns off | No selector | Model A continues; no cancel or rewrite | Unchanged |
| Gateway receives forged/disallowed/disabled model | N/A | 403 with stable policy error | Unchanged |
| Image attachment with selected model | Selector can show image support; server verifies it from the live catalog | Block unsupported or unknown capability before the run | Unchanged |

The selected value is transient UI intent for the active composer/session
scope, not durable conversation metadata. It is reset when the feature is
turned off and never written to `veslo.sessionModels`. Once a prompt is
accepted, its resolved model is captured in that send/queue payload so changing
the picker later cannot silently change an already queued prompt. The sole
intentional exception is disabling this feature: it atomically discards local,
not-yet-dispatched override snapshots, while a server-accepted run is immutable.

## Implementation plan

### 1. Make the gateway's published model roster authoritative

**Owners:** `services/ai-gateway/src/http/admin.ts`,
`services/ai-gateway/src/access/*`, `services/ai-gateway/src/model-policy/*`,
`services/ai-gateway/src/http/proxy.ts`,
`services/ai-gateway/src/http/providers/access-policy.ts`, and
`services/ai-gateway/src/http/user-credentials.ts`.

1. Define one server helper that resolves the selectable roster for an assigned
   user: same provider as the user's managed access, present in both the user
   policy and the platform's `enabledModels`, deduplicated, and ordered with
   `defaultModel` first. Treat a missing/empty legacy allow-list as only the
   default, never as "all models".
2. Change managed-AI assignment and platform-policy mutation to maintain the
   user allow-list as the published same-provider roster, with the platform
   active model retained as `defaultModel`. Use an audited, transactional
   repository operation for existing assigned users; do not introduce a hidden
   client-side or database-only bypass. Add an explicit migration/backfill for
   existing records before the UI can be enabled.
3. Load the current platform policy in the proxy request context and make the
   provider policy require the intersection from step 1. A model removed from
   `enabledModels` must be rejected immediately even if a stale user record or
   old desktop client still sends it. Preserve the existing default injection,
   provider-assignment check, entitlement check, and credential rotation.
4. Publish the computed roster on `GET /api/me/ai-access` and the workspace
   alias, rather than asking the desktop client to infer it from all configured
   OpenCode providers. It may retain the existing wire name `allowedModels`,
   but document it as the current server-approved roster and keep the effective
   model separately explicit.
5. Keep the initial scope same-provider only. Cross-provider selection needs a
   separate design because it changes routing, credentials, and runtime auth;
   it is not an extension hidden in this feature.

### 2. Publish and verify capability-bearing catalog entries

**Owners:** a new
`services/ai-gateway/src/providers/model-capability-registry.ts`, the existing
`services/ai-gateway/src/providers/codex-model-catalog.ts`,
`services/ai-gateway/src/http/user-credentials.ts`,
`packages/server/src/ai-gateway-runtime-owner.ts`,
`packages/server/src/routes/conversations.ts`,
`packages/server/src/conversation-submit-service.ts`,
`packages/server/src/conversation-submit-draft-resolution.ts`,
`packages/server/src/server.ts`, and
`packages/app/src/app/lib/veslo-server/types.ts`.

1. Make the capability source concrete and versioned. Add a provider registry
   with the canonical shape
   `{ provider, model, registryVersion, capabilityStatus, attachment,
   modalities: { input } }`, where `capabilityStatus` is `known` or `unknown`.
   For `codex_oauth`, the static reviewed registry is the sole source of these
   fields and `codex-model-catalog.ts` derives its selectable IDs from it (or
   validates that its legacy string list is identical). Each published Codex
   model has an explicit descriptor; no capability is inferred from its name.
2. Providers without an authoritative descriptor, and any model omitted from a
   provider registry, publish `capabilityStatus: "unknown"` with no affirmative
   attachment/image claim. They remain usable for text when separately
   authorized, but image upload is fail-closed. A registry edit is a reviewed
   gateway release, covered by unit tests for duplicate IDs, missing default
   descriptors, and unknown-provider/model fallback.
3. Extend the user access response with the ordered `selectableModels` entries
   above, filtered by the authorized roster from step 1. The gateway, not the
   desktop client, builds the entries. Retain `allowedModels` only as the
   compatibility ID list; it cannot be used as a capability source.
4. Keep the submitted identity small (`ModelRef`), but resolve its descriptor
   before draft resolution can decide attachment capability. In
   `routes/conversations.ts`, create a request-scoped
   `resolveManagedAiModelDescriptor` from the actor, workspace, and resolved
   runtime-org binding, then pass it into `conversationSubmitService.submit`.
   `conversation-submit-service.ts` must pass that dependency into
   `resolveConversationSubmitDraft(...)`; it cannot be deferred to the later
   `submitResolvedRun`/run-body callback. Its request key is
   `(actor.tokenHash, resolved workspace binding, orgId, provider, model)`.
   The runtime owner obtains the stored runtime authorization for that exact
   binding and issues an internal authenticated request to the gateway access
   endpoint with the bearer value and org context; neither secret is returned
   to a route, desktop client, trace, or error.
5. Give this resolver a small positive cache keyed as above, with expiry
   `min(30 seconds, remaining runtime-authorization age)`. Invalidate it when
   the owner primes, replaces, clears, or ages out that authorization. Do not
   cache authorization/catalog failures. Ambiguous, missing, expired, timeout,
   non-2xx, foreign-provider, or absent-model results yield no descriptor.
6. `resolveConversationSubmitDraft` calls the request-scoped resolver for an
   image-bearing prompt and receives the verified descriptor solely for
   capability validation. Unknown/unreadable catalog maps safely to
   `model_capabilities_unavailable`; a known unsupported model keeps the
   current actionable attachment rejection. The resulting OpenCode run input
   and later run-body callback receive only the already-sanitized `ModelRef`,
   never catalog capability metadata. Text-only sends retain normal gateway
   authorization enforcement and do not treat a capability lookup failure as
   permission to claim image support.
7. Include the same capability descriptors when generating the managed
   OpenCode provider configuration. This keeps app-side attachment staging
   consistent with the authoritative server result, without making the app
   descriptor a security decision.

### 3. Carry the live catalog into the app without changing the default runtime model

**Owners:** `packages/app/src/app/lib/veslo-server/types.ts`,
`packages/app/src/app/lib/ai-access.ts`,
`packages/app/src/app/context/managed-ai-access-store.ts`, and
`packages/app/src/app/context/managed-ai-runtime-config.ts`, with
`packages/app/src/app/lib/opencode.ts` as the configuration-shape owner.

1. Parse the server-approved capability-bearing catalog into
   `ManagedAiAccessProfile.selectableModels`. Normalize provider/model IDs,
   include `effectiveModel`, and reject entries with another provider. Keep the
   profile's effective model as the only fallback/default model.
2. Keep a recovered proof-cache profile conservative: it may restore the
   effective model needed to boot the runtime, but it must not make a stale
   selector available. Enable the picker only after a current live access read
   supplies a valid roster.
3. Change `applyGatewayProviderRouting` from `models?: string[]` to typed
   capability-bearing model descriptors, then extend the managed OpenCode
   provider configuration to register every live selectable model under the
   assigned provider. Only known capabilities become OpenCode capability fields;
   unknown remains unknown. Leave top-level `config.model` equal to
   `effectiveModel`. Include the sorted descriptor roster and registry version
   in the managed-config fingerprint, so a roster update triggers one normal
   config sync and an unchanged roster does not create churn.
4. Preserve the existing rule that access configuration does not let a session
   overwrite the global runtime default. The new roster is routing capability,
   not a replacement for `formatConfigWithDefaultModel`'s default semantics.

### 4. Add a small, removable session-selection owner and UI gate

**Owners:** `packages/app/src/app/constants.ts`, `packages/app/src/app/app.tsx`,
`packages/app/src/app/context/app-startup-hydration.ts`,
`packages/app/src/app/app-view-props.ts`, `packages/app/src/app/pages/settings.tsx`,
`packages/app/src/app/pages/session.tsx`, and a new focused
`packages/app/src/app/components/session/session-model-selector.tsx`.

1. Add a dedicated `SESSION_MODEL_SELECTOR_PREF_KEY` and the app-level
   `sessionModelSelectorEnabled` signal, defaulting to `false`. Wire it through
   `AppStartupHydrationDeps` for validated startup read and persistence, through
   `app-view-props.ts` into `SettingsView`, and through
   `resetAppConfigDefaults` to clear/reset it. Do not add a disconnected field
   to `context/local.tsx`, and do not store anything under the legacy
   session-model key.
2. Surface one settings toggle with clear copy that it only shows models
   granted by the platform. Its disable transition is one `batch`/reducer:
   remove the selector, clear transient selection, strip `modelOverride` from
   every locally queued/editing draft and retry snapshot, and strip it from a
   pending implicit-skill confirmation. Preserve draft text, client IDs, skill
   policy, and queue order. A request already dispatched to, or accepted by,
   the server keeps its captured model and is neither rewritten nor cancelled.
3. Add a narrowly scoped selection owner for the active composer target. It
   holds at most the active target key and one validated `ModelRef`; it does
   not keep a session-ID map, survive restart, or derive a model from message
   history. Its resolver returns an override only when the UI gate is on and
   the model remains in the live catalog; otherwise it returns `undefined`.
4. Thread that resolver through `app.tsx` and `app-view-props.ts` without
   changing the fallback branch in `modelForSession`: managed effective model
   still wins when no valid explicit override exists, then global default.
5. Render one reusable selector at the session layout boundary for both centre
   and footer composer states. Show it only when the preference is on, managed
   access is live, and at least two models are selectable. Use a dedicated
   catalog-to-option helper; do not reuse `buildModelPickerOptions`, because
   that helper lists general configured providers and would leak unsupported
   choices into this managed feature.
6. Add localized labels, an accessible trigger, selected/default state, a busy
   disable state, and an unobtrusive "managed default" indication. The normal
   session composer remains usable while the catalog is absent; there is no
   loading gate on sending.

### 5. Capture the selected model before every local queue or retry boundary

**Owners:** `packages/app/src/app/pages/session-conversation-flow.ts`,
`packages/app/src/app/pages/session-send-workflow.ts`,
`packages/app/src/app/pages/session-mutation-workflow.ts`,
`packages/app/src/app/components/session/session-queue-model.ts`,
`packages/app/src/app/lib/veslo-server/types.ts`,
`packages/app/src/app/lib/send-boundary-validation.ts`, and
`packages/server/src/conversation-submit-contract.ts`,
`conversation-submit-service.ts`, `conversation-submit-draft-resolution.ts`,
and `routes/conversations.ts`.

1. Resolve one `modelOverride` at the start of `SessionView.handleSendPrompt`,
   before `handleSendPrompt` chooses normal send, local queue, server queue, or
   implicit-skill confirmation. Add it to `HandleSendPromptOptions`,
   `SendPromptImmediateOptions`, and `SessionSendOptionsBase`; it is absent
   when the feature gate is off.
2. Add `modelOverride?: ModelRef` to `QueuedDraftEnvelope` and preserve it in
   `appendQueuedDraft` and `updateQueuedDraft`. `drainNextQueuedDraft` must
   pass `start.item.modelOverride` to `sendPromptImmediate`, not call the
   current session resolver again. Saving an edited queued draft is a new user
   acceptance and replaces the snapshot with the then-current override.
3. Replace the text-only `lastPromptSent` retry state with a bounded
   `lastAcceptedPrompt` snapshot containing its prompt draft/text and
   `modelOverride`. `retryLastPrompt` must reuse that exact model. The existing
   implicit-skill confirmation already snapshots its options; include the
   override in that snapshot and preserve it through both confirm branches.
4. Carry the same snapshot through pending-session materialization, normal
   existing-session submit, replacement, commands, and compact. For compact,
   resolve at the explicit compact action because it is not a queued composer
   send. A retry or queued send must never observe a later picker change.
5. When the gate is off at acceptance, omit the option completely. If the gate
   is switched off after local acceptance but before drain/retry, the atomic
   preference transition deliberately removes that local snapshot, so the later
   send uses the default. When on, put the captured
   `ModelRef` in `VesloConversationSubmitRequest.options.model`; the existing
   server contract will sanitize it and forward it to the relevant run shape.
   Replace the current `unknown` in that public option with strict model-ref
   validation at the app/server boundary.
6. Keep attachment routing, auto-compaction capability checks, and telemetry
   using the same captured model. This prevents attachment validation from
   evaluating model A while the submitted run uses model B.
7. Record only the provider/model identifier and selection source in existing
   send traces; never write gateway tokens, raw prompt text, or catalog
   metadata. A gateway policy rejection should surface its stable error and
   refresh the live catalog once before inviting the user to choose again.

## Delivery order and compatibility

1. Ship the gateway roster, capability catalog, enforcement, assignment
   backfill, and tests first. Old apps still omit `model` and continue using
   the default.
2. Ship app catalog parsing and runtime registration next. It is dormant until
   the UI preference is enabled and retains the same default config model.
3. Ship the selector behind its default-off local preference. Enable it only
   after the gateway platform policy contains at least two healthy same-provider
   models and the backfill is confirmed.

Rollback is a settings toggle to off. It atomically removes all locally pending
overrides but never mutates an already server-accepted run. If the UI is later
removed, remove the preference, selector, and optional send field propagation;
the gateway's default-injection path and runtime default remain the behavior of
existing clients.

## Verification and acceptance criteria

### Gateway

- Unit-test roster resolution for active/default ordering, empty legacy lists,
  provider mismatch, duplicate entries, and platform removal.
- Extend provider/proxy tests so default omission succeeds, an enabled assigned
  model succeeds, a user-disallowed model fails, a platform-disabled model
  fails even with stale user access, and credential rotation receives the
  selected allowed model.
- Cover assignment, platform-policy update, and backfill/audit behavior in the
  existing admin-user-access and model-policy suites.
- Verify `/api/me/ai-access` returns only the live same-provider roster and
  does not repair or expose credentials on a read path. Cover the versioned
  Codex registry, explicit known descriptor, unknown-model/provider fallback,
  and the invariant that a plain string model catalog cannot claim image
  capability.

### App, queue/retry, attachment, and server submit

- Test access parsing and proof-cache behavior: effective default can boot;
  picker catalog requires a live response; malformed or foreign-provider
  entries disappear.
- Test capability catalog parsing and server resolution: a bare model identity
  cannot bypass image validation, an image-capable published model succeeds,
  and a known non-image model gets the actionable attachment rejection. Cover
  the runtime-owner transport with the correct actor/workspace/org binding,
  cache expiry/invalidation, ambiguous or expired authorization, upstream
  failure, and unknown descriptor; each unknown/unavailable image case returns
  `model_capabilities_unavailable` without exposing a bearer token.
- Add an ordering test spanning route, `conversationSubmitService.submit`, and
  `resolveConversationSubmitDraft`: authenticated descriptor resolution occurs
  before image validation and before `submitResolvedRun` builds the OpenCode
  body. Assert the draft resolver sees the verified descriptor only for
  capability checks, while the run body and debug/trace entries contain only
  the sanitized `ModelRef` and no capability metadata.
- Test managed config: default `config.model` remains effective while all
  eligible models and their catalog capabilities are registered, and roster
  changes affect the sync fingerprint exactly once.
- Add preference tests for startup hydration, persistence, reset, SettingsView
  prop wiring, default-off behavior, and clearing the transient selection.
  Explicitly queue and snapshot model A, then disable the feature: local queue
  drain, retry, and implicit-skill confirmation must omit the override while an
  already server-accepted/in-flight model-A run remains untouched.
  Retain the existing regression that forbids the old `sessionModel*ById` maps.
- Add SessionView/component tests that both composer placements use the same
  gated selector and that the selector is absent under the default settings.
- Add queue model tests proving the envelope preserves a captured override,
  queued drain uses that override, editing replaces it, implicit-skill
  confirmation preserves it, and retry-last-prompt restores it. Add
  conversation-submit tests that the snapshot reaches prompt, command,
  replacement, compact, first-message materialization, queued retry, and
  server run-body construction; assert it is absent when the gate is off.

### Manual release check

With two healthy `codex_oauth` models enabled, enable the setting, select the
non-default model, send a prompt with an attachment, then queue another prompt
and switch back to default. The first run and queued payload must retain their
respective captured models; a new normal send must use the current selection.
Turn the setting off and repeat: no selector is visible and the request omits
the model override while inference continues through the current default.

## Non-goals

- No arbitrary provider/model text entry.
- No provider or credential switching from a session.
- No persistent per-session model map, transcript rewrite, or change to the
  server-owned conversation lifecycle.
- No automatic enabling for existing users and no broad model picker for BYOK
  or unrelated providers in this increment.
