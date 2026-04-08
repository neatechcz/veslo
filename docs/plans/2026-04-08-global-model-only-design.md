# Global Model Only Design

## Goal

Make Veslo use exactly one model source for all runtime work: the globally configured app model.

Session-specific model selection, persistence, hydration, and fallback behavior must be removed. Existing sessions must automatically use the currently configured global model on their next run.

## Approved Product Behavior

1. Veslo has one authoritative runtime model: the global model configured in the app.
2. Every session uses that global model, including sessions created in the past.
3. Session state must never persist a model override.
4. Session history must never restore or infer a future model choice.
5. Old per-session model persistence must be deleted during migration.
6. If the configured global model is unavailable, Veslo must not choose another model automatically.
7. Any model-changing UI entry point inside a session becomes a shortcut for changing the global model, not that session only.

## Scope

In scope:

- Global model resolution in `packages/app/src/app/app.tsx`
- Session model hydration/update logic in `packages/app/src/app/context/session.ts`
- Per-session model persistence helpers in `packages/app/src/app/lib/model-persistence.ts`
- Session model persistence keys and migration cleanup in app startup
- Model picker behavior and copy in app UI
- Project documentation describing model behavior

Out of scope:

- Provider authentication changes
- Backend/OpenCode engine changes to model execution semantics
- Historical message metadata rewriting
- Multi-model orchestration or policy layers

## Options Considered

### Option 1: Hard cut to global-only model semantics (chosen)

- Remove per-session model overrides and resolved session model cache from runtime behavior.
- Delete persisted session model keys at startup.
- Make all sends resolve model from the global default only.

Pros:

- Matches the requested product behavior exactly.
- Eliminates hidden precedence and surprising carry-over from old sessions.
- Minimizes the chance of future fallback-like behavior reappearing indirectly.

Cons:

- Old sessions no longer preserve their previously used model for future sends.

### Option 2: Ignore session model state but leave old persistence in place

- Stop using per-session model state, but do not delete stored keys.

Pros:

- Smaller migration step.

Cons:

- Leaves dead state behind.
- Makes future regressions and debugging harder because stale data remains present.

### Option 3: Transitional flag for global-only mode

- Add a feature flag or compatibility mode for the new behavior.

Pros:

- Safer staged rollout.

Cons:

- Unnecessary complexity for a clear, non-optional product rule.
- Creates more states to test and document.

## Recommended Approach

Use Option 1.

Treat the global configured model as the only runtime model input for:

- normal prompt sends
- slash command sends
- session compaction
- helper/internal sessions that already rely on app model state

Do not preserve any session-specific model state for future routing.

## Architecture

### Single model source of truth

`defaultModel()` remains the sole runtime model source in the app. Any logic that currently resolves a session model from:

- `sessionModelOverrideById`
- `sessionModelById`
- `lastUserModelFromMessages(messages())`

must be removed from model selection.

### Session state simplification

Session stores may continue to keep message metadata for display and history, but model metadata from prior messages is informational only. It must not influence the next run's model.

### Persistence simplification

Per-session model persistence under the `veslo.sessionModels` namespace is removed. Startup migration clears old keys so stale session model data cannot be reused later.

## Component And Data Flow

### Current behavior

Today, model resolution is layered:

1. session override
2. resolved session model cache
3. last user message model from history
4. global default model

This allows old sessions to keep using old models.

### New behavior

After the change:

1. user changes the global model in app UI
2. Veslo updates the single global model state
3. any session send reads the global model directly
4. the run proceeds with that model, or fails if unavailable

No session-specific state participates in this path.

## Migration

On startup, Veslo must remove any existing per-session model persistence keys.

Migration rules:

1. Delete all localStorage keys under the existing session-model prefix.
2. Stop reading those keys during workspace/session bootstrap.
3. Stop writing those keys after model changes.
4. Ignore model information restored from session history for future sends.

This is a destructive migration by design and is required for consistency.

## UI And Copy Changes

The product must stop implying that model choice is session-scoped.

Required UI/copy changes:

1. Settings copy must describe the model as global for all sessions, not only new sessions.
2. Session-surface model picker language must stop saying "session model" or "next message" if it still opens the same picker.
3. Session-level "Change model" affordances may remain, but they act as a shortcut to the global model selector.
4. Unavailable configured models may remain visible in the picker, but only as the current global selection. They must not trigger fallback selection.

## Documentation Updates

Update project documentation to reflect the new invariant:

- `PRODUCT.md`
- `ARCHITECTURE.md`

Document the following explicitly:

1. Veslo uses one global runtime model.
2. Existing sessions automatically follow the current global model.
3. Per-session model persistence does not exist.
4. Veslo does not auto-fallback to another model when the configured model is unavailable.

## Error Handling And Edge Cases

1. If the configured global model is unavailable, sending should fail with an explicit error rather than auto-selecting another model.
2. Historical messages may still show the model used at the time they were created, but that metadata is non-authoritative.
3. Session creation while no session is selected still uses the global model immediately.
4. Workspace switching must not resurrect per-session model state from storage or message history.

## Testing Strategy

1. Add regression tests for global-only model resolution.
2. Add migration tests proving old `veslo.sessionModels.*` keys are removed.
3. Add regression tests proving session message hydration does not mutate future model selection.
4. Keep the unavailable-model picker regression to ensure no implicit fallback is introduced.
5. Update UI/source-contract tests for model picker wording and behavior if session/global copy changes.

## Acceptance Criteria

- Every future run in every session uses the current global model.
- No per-session model override is stored or restored.
- Old per-session model persistence is deleted during migration.
- Loading session history does not affect future model routing.
- No automatic fallback model is selected when the configured model is unavailable.
- Project docs state the global-only model invariant clearly.
