# Token-Based Auto-Compaction Guard

**Date:** 2026-03-18
**Status:** Approved
**Scope:** `packages/app/src/app/app.tsx`

## Problem

Auto-compaction fires after every single response, regardless of conversation length. When a session transitions from "running" to "idle", the effect at line 1801-1812 immediately calls `triggerAutoCompaction()`. This causes:

1. OpenCode starts a compaction run (`session.summarize()` or `session.command("compact")`)
2. The session goes back to "running" status via SSE
3. The UI re-enters "thinking" state even though the user's response is already complete
4. The user sees continued activity after their answer has been printed

Additionally, the `autoCompactContext` signal is forcefully re-enabled by an effect at lines 2824-2828, making it impossible to disable.

## Solution

Add a token-usage guard so auto-compaction only triggers when the conversation has consumed 90% of the model's context window. For GPT-5.4 specifically, use a hard cap of 128,000 tokens instead of the model's full context window (GPT-5.4 degrades in quality at high context usage despite its 1M+ window, so we compact early).

## Design

### 1. Constants

```typescript
/** Fraction of context window that triggers auto-compaction. */
const COMPACTION_THRESHOLD_RATIO = 0.90;

/**
 * Model-specific overrides for the compaction context limit.
 * GPT-5.4 has a 1M+ context window but degrades at high usage;
 * compact early at 128K instead.
 * Uses prefix matching: "gpt-5.4" also covers "gpt-5.4-2026-03-05".
 */
const COMPACTION_TOKEN_OVERRIDES: Array<{ prefix: string; limit: number }> = [
  { prefix: "gpt-5.4", limit: 128_000 },
];
```

Using prefix matching so future GPT-5.4 snapshots (e.g. `gpt-5.4-2026-06-01`) are automatically covered.

### 2. `resolveCompactionThreshold` function

Resolves the effective context limit for compaction decisions. Checks overrides first (prefix match), then falls back to the model's `limit.context` from the provider registry.

```typescript
function resolveCompactionThreshold(
  model: ModelRef,
  allProviders: ProviderListItem[],
): number | null {
  // Check model-specific overrides (prefix match)
  const override = COMPACTION_TOKEN_OVERRIDES.find(
    (entry) => model.modelID === entry.prefix || model.modelID.startsWith(entry.prefix + "-"),
  );
  if (override) return override.limit;

  // Fall back to model.limit.context from provider registry
  const provider = allProviders.find((p) => p.id === model.providerID);
  if (!provider) return null;
  const modelData = provider.models[model.modelID];
  if (!modelData?.limit?.context) return null;

  return modelData.limit.context;
}
```

### 3. `shouldAutoCompact` function

Determines whether auto-compaction should trigger by checking if the latest assistant message's input tokens have reached 90% of the resolved context limit.

```typescript
function shouldAutoCompact(
  sessionMessages: MessageWithParts[],
  model: ModelRef,
  allProviders: ProviderListItem[],
): boolean {
  // Find latest assistant message with token data (walk backwards)
  for (let i = sessionMessages.length - 1; i >= 0; i--) {
    const info = sessionMessages[i].info;
    if (info.role !== "assistant") continue;

    const inputTokens = info.tokens?.input;
    if (typeof inputTokens !== "number" || inputTokens <= 0) continue;

    // Resolve context limit for this model
    const contextLimit = resolveCompactionThreshold(model, allProviders);
    if (!contextLimit || contextLimit <= 0) return false;

    // Trigger when usage reaches threshold
    return inputTokens / contextLimit >= COMPACTION_THRESHOLD_RATIO;
  }

  // No assistant message with token data found — skip compaction
  return false;
}
```

**Type safety notes:**
- `info.role` is accessed directly — both `UserMessage`, `AssistantMessage`, and `PlaceholderAssistantMessage` have a `role` field in the `MessageInfo` union.
- After confirming `role === "assistant"`, `info.tokens.input` is a required `number` on both `AssistantMessage` and `PlaceholderAssistantMessage`. The `typeof` guard is defensive against runtime surprises.

**Why `tokens.input` on the latest assistant message?** Input tokens represent the full conversation context the model consumed for that turn — all prior messages, system prompt, tool results, etc. As the conversation grows, this number grows. It is the best available proxy for current context usage.

### 4. Modified trigger effect

The existing effect at lines 1801-1812 gains the `shouldAutoCompact` guard. The new signal reads (`messages()`, `selectedSessionModel()`, `providers()`) are wrapped in `untrack()` to avoid expanding the effect's reactive dependencies — the compaction decision should only be evaluated at the moment of a status transition, not re-triggered by message or provider changes.

```typescript
createEffect(() => {
  const sessionID = selectedSessionId();
  const status = sessionID ? sessionStatusById()[sessionID] ?? null : null;
  const previous = lastSessionStatus();
  setLastSessionStatus(status);

  if (!sessionID) return;
  if (!autoCompactContext()) return;
  if (status !== "idle") return;
  if (!previous || previous === "idle") return;

  // Only compact when context usage reaches 90% of the model's limit
  const needed = untrack(() =>
    shouldAutoCompact(messages(), selectedSessionModel(), providers()),
  );
  if (!needed) return;

  void triggerAutoCompaction(sessionID);
});
```

### 5. Remove force-enable effect

Delete the effect at lines 2824-2828 that forcefully re-enables `autoCompactContext`:

```typescript
// DELETE THIS:
createEffect(() => {
  if (!autoCompactContext()) {
    setAutoCompactContext(true);
  }
});
```

This restores the ability for users to disable auto-compaction. The initial default of `true` (line 2820) is kept.

## Behavior Examples

| Model | Context Window | Override | Compaction triggers at |
|-------|---------------|----------|----------------------|
| Claude Sonnet 4.6 | 200,000 | none | 180,000 input tokens (90%) |
| Claude Opus 4.6 | 1,000,000 | none | 900,000 input tokens (90%) |
| GPT-5.4 | 1,050,000 | 128,000 | 115,200 input tokens (90% of 128K) |
| GPT-5.4 (snapshot) | 1,050,000 | 128,000 | 115,200 input tokens (90% of 128K) |
| GPT-4o | 128,000 | none | 115,200 input tokens (90%) |

## Files Changed

| File | Change |
|------|--------|
| `packages/app/src/app/app.tsx` | Add `COMPACTION_THRESHOLD_RATIO`, `COMPACTION_TOKEN_OVERRIDES`, `resolveCompactionThreshold`, `shouldAutoCompact`; wrap new reads in `untrack()` in trigger effect; remove force-enable effect |

## What Stays Unchanged

- `triggerAutoCompaction` function
- `compactCurrentSession` function
- `autoCompactingSessionId` concurrency guard
- `autoCompactContext` signal initialization (defaults to `true`)
- Manual compaction via `/compact` command
- All SSE event handling
- All UI run indicator logic

## Testing

`shouldAutoCompact` and `resolveCompactionThreshold` are pure functions. Unit tests should cover:

- Assistant message with tokens below threshold: returns `false`
- Assistant message with tokens at/above threshold: returns `true`
- No assistant messages: returns `false`
- Unknown provider/model: returns `false`
- Override model (GPT-5.4): uses 128K limit instead of context window
- GPT-5.4 snapshot ID (`gpt-5.4-2026-03-05`): prefix match covers it
- Empty messages array: returns `false`
