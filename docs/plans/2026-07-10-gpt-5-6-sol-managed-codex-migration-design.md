# GPT-5.6 Sol Managed Codex Migration Design

**Date:** 2026-07-10

## Goal

Move Veslo managed Codex inference from GPT-5.5 to the canonical GPT-5.6 Sol
model id, `gpt-5.6-sol`, upgrade the backend Codex runtime, migrate every stored
Codex access assignment, and prove the complete desktop-to-backend path with
real credential-specific inference.

Temporary inference unavailability is accepted during the migration. Veslo
must not automatically fall back to GPT-5.5.

## Source-of-truth boundaries

Codex credential records and encrypted secrets contain authentication material.
They do not own a persistent model field. Model selection is split across:

- the AI Gateway Codex model catalog and default;
- the DEN new-user automatic-assignment default;
- each `user_ai_access_policy` row's `default_model` and
  `allowed_models_json` fields;
- generated local OpenCode routing derived from the current managed-AI policy.

The migration therefore keeps each credential id, encrypted secret, binding,
health state, and assignment origin intact. It changes the model catalog,
defaults, and every policy that uses `codex_oauth`. Credential secrets are
replaced only when a real credential probe proves that reauthentication is
required.

## Model and runtime target

- Canonical model id: `gpt-5.6-sol`
- Moving alias deliberately not used: `gpt-5.6`
- Backend Codex package: upgrade both AI Gateway and DEN from `0.137.0` to the
  current stable `0.144.1`
- Reasoning/variant behavior: preserve the existing application policy; the
  migration changes the model, not the selected reasoning effort

The explicit Sol id makes the deployed behavior deterministic even if the
`gpt-5.6` alias changes later.

## Code changes

The AI Gateway catalog will place `gpt-5.6-sol` first and make it the default.
GPT-5.5 remains in the historical/available catalog only if needed for admin
visibility, but it is not used as a runtime fallback or migrated policy value.

DEN's new-signup assignment will use `gpt-5.6-sol` as both the default and sole
allowed model. AI Gateway status probes will run the same default so every
credential's reported availability is tested against the model Veslo will
actually use.

The Codex worker's runtime-incompatibility diagnostic will be generalized. It
must recognize an unsupported requested model without hard-coding GPT-5.5, and
it must continue to return the existing structured
`codex_runtime_incompatible` error.

## Credential and policy migration

Add an explicit, idempotent operator command to migrate managed-AI data. It will:

1. select every `user_ai_access_policy` row whose provider is `codex_oauth`,
   including disabled policies so later re-enablement cannot restore GPT-5.5;
2. preserve the row id, user id, credential id, enabled state, and assignment
   origin;
3. set `default_model` to `gpt-5.6-sol`;
4. replace `allowed_models_json` with `["gpt-5.6-sol"]`;
5. update the row timestamp;
6. run in a transaction and print only value-free counts and model summaries.

The command will support a dry run and an explicit apply mode. Production and
staging database backups are required before apply. Running the command twice
must produce no additional changes.

## Credential-specific inference proof

After the new backend image is deployed, a guarded operator probe will iterate
over every non-deleted Codex OAuth credential sequentially. Sequential execution
avoids concurrent refresh-token replay. For each credential it will:

- load and materialize the encrypted auth state without printing it;
- call the upgraded Codex runtime with `gpt-5.6-sol` and a deterministic
  `Reply with exactly OK.` prompt;
- persist rotated auth state through the existing encrypted-secret path;
- report the credential id/name, health state, success/failure category, and
  timing without secret values;
- continue to the next credential when one fails.

Unsupported, expired, or invalid credentials remain migrated to GPT-5.6 Sol,
as requested. They are reported for reconnect instead of silently falling back.

## Deployment order

1. Complete test-first code changes and local builds.
2. Back up staging managed-AI data.
3. Deploy the new AI Gateway and DEN images to staging.
4. Run the staging policy migration and all-credential GPT-5.6 Sol probe.
5. Run staging health/readiness, direct gateway inference, and real Tauri
   desktop inference checks.
6. Back up production managed-AI data.
7. Deploy the same verified revision to production.
8. Run the production policy migration and all-credential probe.
9. Verify production health/readiness, database policy counts, audit/usage
   evidence, direct inference, and the desktop end-to-end path.

No public desktop release is required solely for this backend migration. The
desktop test uses the real Tauri runtime and current managed policy returned by
the deployed backend.

## Testing strategy

Tests are introduced before behavior changes and must demonstrate the red/green
cycle. Coverage includes:

- catalog order and default model;
- DEN new-user assignment model;
- generic Codex runtime-incompatibility handling for GPT-5.6 Sol;
- migration dry-run, transactional apply, preservation of credential binding
  and assignment origin, disabled-policy coverage, and idempotence;
- credential probe sequencing, continuation after failure, and secret-safe
  output;
- full AI Gateway and DEN test suites and TypeScript builds;
- backend image/runtime confirmation of the upgraded Codex version;
- staging and production live probes through every credential;
- real Tauri desktop E2E with one cold send and two subsequent sends, recording
  the provider, model, exact prompts, and visible result for each.

## Failure and rollback behavior

There is no GPT-5.5 fallback. A failed GPT-5.6 Sol credential test is surfaced
as an explicit per-credential failure and may temporarily break assigned user
inference.

Rollback is operational and explicit: restore the pre-migration database backup
and deploy the previous backend revision. The migration command itself will not
embed or automatically execute a GPT-5.5 rollback.

## Out of scope

- Changing unrelated local `opencode.jsonc` state or user credentials stored
  outside the managed backend
- Rewriting prompts or reasoning-effort defaults
- Releasing desktop binaries when the verified backend-only change is sufficient
- Modifying non-Codex provider policies or credentials
