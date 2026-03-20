# Frontend Refactoring Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose app.tsx (7,524 lines) and workspace.ts (3,864 lines) into focused modules, replace 36 silent error catches, and consolidate duplicated fetch wrappers.

**Architecture:** Incremental extract-by-concern. Two foundation modules (error-reporter, http) are built first, then business logic is extracted from god objects one concern at a time. Each extraction is one commit with build+test verification.

**Tech Stack:** Solid.js, TypeScript, Tauri, Vite, pnpm

**Spec:** `docs/superpowers/specs/2026-03-20-frontend-refactoring-design.md`

---

## Chunk 1: Foundations (Tasks 1-2)

### Task 1: Create error-reporter.ts

**Files:**
- Create: `packages/app/src/app/lib/error-reporter.ts`
- Modify: `packages/app/src/app/lib/safe-run.ts`
- Modify: `packages/app/src/app/app.tsx` (19 catch sites)
- Modify: `packages/app/src/app/context/workspace.ts` (6 catch sites)
- Modify: `packages/app/src/app/system-state.ts` (3 catch sites)
- Modify: `packages/app/src/index.tsx` (2 catch sites)
- Modify: `packages/app/src/app/context/global-sdk.tsx` (1 catch site)
- Modify: `packages/app/src/app/context/server.tsx` (1 catch site)
- Modify: `packages/app/src/app/pages/session.tsx` (1 catch site)
- Modify: `packages/app/src/app/pages/identities.tsx` (1 catch site)

- [ ] **Step 1: Record baseline**

Run: `cd packages/app && pnpm build 2>&1 | tail -5`
Run: `cd packages/app && pnpm test:unit 2>&1 | tail -10`
Record pass/fail counts for comparison later.

- [ ] **Step 2: Create error-reporter.ts**

Create `packages/app/src/app/lib/error-reporter.ts`:

```typescript
/**
 * Centralized error reporting utility.
 *
 * Replaces silent `.catch(() => undefined)` patterns with observable
 * error reporting. In dev, logs full error with context. In prod,
 * logs a structured warning.
 *
 * Always returns `undefined` so it can be used inline:
 *   somePromise.catch(e => reportError(e, "sidebar.refresh"))
 */

export type ErrorSeverity = "warning" | "error";

const isDev =
  typeof import.meta !== "undefined" && import.meta.env?.DEV;

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function reportError(
  error: unknown,
  context: string,
  severity: ErrorSeverity = "warning",
): undefined {
  if (isDev) {
    const method = severity === "error" ? console.error : console.warn;
    method(`[${context}]`, error);
  } else {
    console.warn(`[${context}]`, safeMessage(error));
  }
  return undefined;
}
```

- [ ] **Step 3: Update safe-run.ts to use reportError**

Modify `packages/app/src/app/lib/safe-run.ts`. Replace the entire file:

```typescript
/**
 * Safe execution utilities for error handling.
 *
 * Wraps operations with structured error handling that delegates
 * to reportError for consistent logging across dev and prod.
 */

import { reportError } from "./error-reporter";

/**
 * Run an async function, returning the result or a fallback on error.
 *
 * @example
 * const sessions = await safeAsync(() => loadSessions(), []);
 */
export async function safeAsync<T>(
  fn: () => Promise<T>,
  fallback: T,
  label?: string,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    reportError(error, `safeAsync:${label ?? "unknown"}`, "warning");
    return fallback;
  }
}

/**
 * Run a synchronous function, returning the result or a fallback on error.
 *
 * @example
 * const parsed = safeSync(() => JSON.parse(raw), null);
 */
export function safeSync<T>(
  fn: () => T,
  fallback: T,
  label?: string,
): T {
  try {
    return fn();
  } catch (error) {
    reportError(error, `safeSync:${label ?? "unknown"}`, "warning");
    return fallback;
  }
}

/**
 * Fire-and-forget an async operation. Logs errors via reportError.
 * Use for cleanup, best-effort writes, etc.
 *
 * @example
 * fireAndForget(() => saveDraft(content), "save draft");
 */
export function fireAndForget(
  fn: () => Promise<unknown>,
  label?: string,
): void {
  fn().catch((error) => {
    reportError(error, `fireAndForget:${label ?? "unknown"}`, "warning");
  });
}
```

- [ ] **Step 4: Replace all silent catches across the codebase**

In each file listed below, add `import { reportError } from "./lib/error-reporter";` (or adjust relative path) and replace every `.catch(() => undefined)`, `.catch(() => {})`, `.catch(() => null)`, `.catch(() => false)` with `.catch(e => reportError(e, "descriptive.context"))`.

The exact replacements by file:

**`packages/app/src/app/app.tsx`** (19 sites) — add import at top:
```typescript
import { reportError } from "./lib/error-reporter";
```
Then search-and-replace each catch. Use descriptive contexts like:
- `refreshSidebarWorkspaceSessions(...).catch(() => undefined)` → `.catch(e => reportError(e, "sidebar.refreshSessions"))`
- `refreshSoulData().catch(() => undefined)` → `.catch(e => reportError(e, "soul.refresh"))`
- `refreshMcpServers().catch(() => undefined)` → `.catch(e => reportError(e, "mcp.refreshServers"))`
- `checkForUpdates({ quiet: true }).catch(() => undefined)` → `.catch(e => reportError(e, "updates.check"))`
- `downloadUpdate().catch(() => undefined)` → `.catch(e => reportError(e, "updates.download"))`
- `refreshScheduledJobs(options).catch(() => undefined)` → `.catch(e => reportError(e, "scheduled.refresh"))`
- `refreshSkills(options).catch(() => undefined)` → `.catch(e => reportError(e, "skills.refresh"))`
- `refreshHubSkills(options).catch(() => undefined)` → `.catch(e => reportError(e, "skills.refreshHub"))`
- `refreshPlugins(scopeOverride).catch(() => undefined)` → `.catch(e => reportError(e, "plugins.refresh"))`

**`packages/app/src/app/context/workspace.ts`** (6 sites) — add import:
```typescript
import { reportError } from "../lib/error-reporter";
```
- `buildPrivateWorkspaceRoot().catch(() => undefined)` → `.catch(e => reportError(e, "workspace.buildPrivateRoot"))`
- `.catch(() => undefined)` after connectToServer → `.catch(e => reportError(e, "workspace.reconnect"))`
- `options.refreshSkills({ force: true }).catch(() => undefined)` → `.catch(e => reportError(e, "workspace.refreshSkills"))` (2 sites)
- `options.refreshPlugins().catch(() => undefined)` → `.catch(e => reportError(e, "workspace.refreshPlugins"))` (2 sites)

Special case — line 3426 (`bootTrace` telemetry): Keep the silent catch but add an explanatory comment:
```typescript
// Intentionally silent: localhost debug telemetry — failure is expected when no debug server is running
try { fetch("http://127.0.0.1:9876", { method: "POST", body: line, mode: "no-cors" }).catch(() => {}); } catch { /* ignore */ }
```

**`packages/app/src/app/system-state.ts`** (3 sites) — add import, replace catches with contexts: `"reload.refreshPlugins"`, `"reload.refreshSkills"`, `"reload.refreshMcpServers"`.

**`packages/app/src/index.tsx`** (2 sites) — add import, replace with `"init.tauriSetup"`.

**`packages/app/src/app/context/global-sdk.tsx`** (1 site) — `"sse.subscribe"`.

**`packages/app/src/app/context/server.tsx`** (1 site) — change `.catch(() => false)` to `.catch(e => { reportError(e, "server.healthCheck"); return false; })`.

**`packages/app/src/app/pages/session.tsx`** (1 site) — `"session.sendPrompt"`.

**`packages/app/src/app/pages/identities.tsx`** (1 site) — `"identities.telegramRouter"`.

Leave `session-navigation.test.ts` as-is (test helper).

- [ ] **Step 5: Verify build and tests pass**

Run: `cd packages/app && pnpm build 2>&1 | tail -5`
Expected: Build succeeds with zero new warnings.

Run: `cd packages/app && pnpm test:unit 2>&1 | tail -10`
Expected: Same pass/fail counts as baseline.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/app/lib/error-reporter.ts packages/app/src/app/lib/safe-run.ts
git add packages/app/src/app/app.tsx packages/app/src/app/context/workspace.ts
git add packages/app/src/app/system-state.ts packages/app/src/index.tsx
git add packages/app/src/app/context/global-sdk.tsx packages/app/src/app/context/server.tsx
git add packages/app/src/app/pages/session.tsx packages/app/src/app/pages/identities.tsx
git commit -m "refactor: replace 35 silent error catches with reportError

Add lib/error-reporter.ts as centralized error reporting utility.
Update safe-run.ts to delegate to reportError instead of raw console.warn.
Replace .catch(() => undefined) patterns with .catch(e => reportError(e, context))
across app.tsx, workspace.ts, system-state.ts, index.tsx, global-sdk.tsx,
server.tsx, session.tsx, and identities.tsx.

One intentional silent catch preserved at workspace.ts:3395 (localhost
debug telemetry) with explanatory comment."
```

---

### Task 2: Create http.ts and consolidate fetch wrappers

**Files:**
- Create: `packages/app/src/app/lib/http.ts`
- Modify: `packages/app/src/app/lib/opencode.ts` (replace internal fetchWithTimeout)
- Modify: `packages/app/src/app/lib/veslo-server.ts` (replace internal fetchWithTimeout)

- [ ] **Step 1: Create http.ts**

Create `packages/app/src/app/lib/http.ts`:

```typescript
/**
 * Shared HTTP utilities.
 *
 * Consolidates the duplicated fetchWithTimeout implementations from
 * opencode.ts and veslo-server.ts into a single shared module.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Fetch with an AbortController-based timeout.
 * Distinguishes AbortError from network errors — both become
 * descriptive Error instances.
 *
 * @param fetchImpl - The fetch implementation to use (globalThis.fetch, tauriFetch, etc.)
 * @param input - URL or Request
 * @param init - Standard RequestInit, optionally extended with timeoutMs
 * @param timeoutMs - Timeout in milliseconds (default 10s). Pass 0 or Infinity to disable.
 */
export async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(input, init);
  }

  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const initWithSignal =
    signal && !init?.signal ? { ...(init ?? {}), signal } : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetchImpl(input, initWithSignal),
      timeoutPromise,
    ]);
  } catch (error) {
    const name =
      error &&
      typeof error === "object" &&
      "name" in error
        ? (error as { name: string }).name
        : "";
    if (name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Convenience wrapper: fetch JSON with timeout, auto-headers, and error handling.
 */
export async function fetchJson<T>(
  url: string,
  opts?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof globalThis.fetch;
  },
): Promise<T> {
  const fetchFn = opts?.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...opts?.headers,
  };

  let bodyStr: string | undefined;
  if (opts?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(opts.body);
  }

  const response = await fetchWithTimeout(
    fetchFn,
    url,
    {
      method: opts?.method ?? (opts?.body ? "POST" : "GET"),
      headers,
      body: bodyStr,
      signal: opts?.signal,
    },
    opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!response.ok) {
    const preview = await response.text().catch(() => "");
    const suffix = preview ? `: ${preview.slice(0, 200)}` : "";
    throw new Error(`HTTP ${response.status}${suffix}`);
  }

  return (await response.json()) as T;
}
```

- [ ] **Step 2: Update opencode.ts to import from http.ts**

In `packages/app/src/app/lib/opencode.ts`:

1. Add import at top:
```typescript
import { fetchWithTimeout } from "./http";
```

2. Delete the local `fetchWithTimeout` function (lines 39-76).

3. The existing call sites in `createTauriFetch` already call `fetchWithTimeout(fetchImpl, input, init, timeoutMs)` with the exact same signature, so no call-site changes needed.

- [ ] **Step 3: Update veslo-server.ts to import from http.ts**

In `packages/app/src/app/lib/veslo-server.ts`:

1. Add import at top:
```typescript
import { fetchWithTimeout } from "./http";
```

2. Delete the local `fetchWithTimeout` function (lines 1030-1077).

3. The call sites in `requestJson` and `requestJsonRaw` already use `fetchWithTimeout(fetchImpl, url, init, timeoutMs)` — same signature, no changes needed.

- [ ] **Step 4: Verify build and tests pass**

Run: `cd packages/app && pnpm build 2>&1 | tail -5`
Expected: Build succeeds.

Run: `cd packages/app && pnpm test:unit 2>&1 | tail -10`
Expected: Same pass/fail counts as baseline.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/app/lib/http.ts
git add packages/app/src/app/lib/opencode.ts
git add packages/app/src/app/lib/veslo-server.ts
git commit -m "refactor: consolidate duplicated fetchWithTimeout into lib/http.ts

Extract the shared fetch-with-timeout pattern from opencode.ts and
veslo-server.ts into a single lib/http.ts module. Both files now
import from the shared module. Also adds fetchJson convenience wrapper
for direct fetch calls.

No behavior change — same AbortController timeout pattern, same
error handling for AbortError."
```

---

## Chunk 2: app.tsx Pure Function Extractions (Tasks 3-4)

### Task 3: Extract model-persistence.ts

**Files:**
- Create: `packages/app/src/app/lib/model-persistence.ts`
- Modify: `packages/app/src/app/app.tsx`

- [ ] **Step 1: Create model-persistence.ts**

Create `packages/app/src/app/lib/model-persistence.ts` by moving the 4 pure functions from app.tsx (lines 2785-2854):

```typescript
/**
 * Pure data transformation functions for model persistence.
 *
 * These handle parsing/serializing model overrides from localStorage
 * and reading/writing the default model from opencode config files.
 * No side effects — no localStorage access, no file I/O.
 */

import { parse } from "jsonc-parser";

import type { ModelRef } from "../types";
import { formatModelRef, parseModelRef } from "../utils";

/**
 * Parse per-session model overrides from a localStorage JSON string.
 * Returns an empty record on invalid/missing input.
 */
export function parseSessionModelOverrides(
  raw: string | null,
): Record<string, ModelRef> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const next: Record<string, ModelRef> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        const model = parseModelRef(value);
        if (model) next[sessionId] = model;
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (
        typeof record.providerID === "string" &&
        typeof record.modelID === "string"
      ) {
        next[sessionId] = {
          providerID: record.providerID,
          modelID: record.modelID,
        };
      }
    }
    return next;
  } catch {
    return {};
  }
}

/**
 * Serialize per-session model overrides to a localStorage JSON string.
 * Returns null if overrides are empty.
 */
export function serializeSessionModelOverrides(
  overrides: Record<string, ModelRef>,
): string | null {
  const entries = Object.entries(overrides);
  if (!entries.length) return null;
  const payload: Record<string, string> = {};
  for (const [sessionId, model] of entries) {
    payload[sessionId] = formatModelRef(model);
  }
  return JSON.stringify(payload);
}

/**
 * Extract the default model from an opencode config file content string.
 * Returns null if the config is missing, invalid, or has no model field.
 */
export function parseDefaultModelFromConfig(
  content: string | null,
): ModelRef | null {
  if (!content) return null;
  try {
    const parsed = parse(content) as Record<string, unknown> | undefined;
    const rawModel =
      typeof parsed?.model === "string" ? parsed.model : null;
    return parseModelRef(rawModel);
  } catch {
    return null;
  }
}

/**
 * Produce an opencode config string with the given model set as default.
 * Preserves existing config fields. Adds $schema if missing.
 */
export function formatConfigWithDefaultModel(
  content: string | null,
  model: ModelRef,
): string {
  let config: Record<string, unknown> = {};
  if (content?.trim()) {
    try {
      const parsed = parse(content) as Record<string, unknown> | undefined;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = { ...parsed };
      }
    } catch {
      config = {};
    }
  }

  if (!config["$schema"]) {
    config["$schema"] = "https://opencode.ai/config.json";
  }

  config.model = formatModelRef(model);
  return `${JSON.stringify(config, null, 2)}\n`;
}
```

- [ ] **Step 2: Update app.tsx to import from model-persistence.ts**

In `packages/app/src/app/app.tsx`:

1. Add import at top:
```typescript
import {
  parseSessionModelOverrides,
  serializeSessionModelOverrides,
  parseDefaultModelFromConfig,
  formatConfigWithDefaultModel,
} from "./lib/model-persistence";
```

2. Delete the 4 local function definitions (lines ~2785-2854): `parseSessionModelOverrides`, `serializeSessionModelOverrides`, `parseDefaultModelFromConfig`, `formatConfigWithDefaultModel`.

3. Leave the signal declarations (`defaultModel`, `sessionModelOverrideById`, etc.) and all effects that call these functions — they stay in app.tsx.

- [ ] **Step 3: Verify build and tests pass**

Run: `cd packages/app && pnpm build 2>&1 | tail -5`
Run: `cd packages/app && pnpm test:unit 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/app/lib/model-persistence.ts packages/app/src/app/app.tsx
git commit -m "refactor: extract model persistence functions to lib/model-persistence.ts

Move parseSessionModelOverrides, serializeSessionModelOverrides,
parseDefaultModelFromConfig, and formatConfigWithDefaultModel from
app.tsx to a dedicated module. These are pure data transformation
functions with no side effects. Effects that call them remain in app.tsx."
```

---

### Task 4: Extract auto-compaction.ts

**Files:**
- Create: `packages/app/src/app/lib/auto-compaction.ts`
- Modify: `packages/app/src/app/app.tsx`

- [ ] **Step 1: Create auto-compaction.ts**

Create `packages/app/src/app/lib/auto-compaction.ts` by moving the compaction logic from app.tsx (lines 1786-1835):

```typescript
/**
 * Auto-compaction threshold logic.
 *
 * Determines when a session's context usage is high enough to trigger
 * automatic compaction. Pure functions — no reactive state.
 */

import type { ModelRef, ProviderListItem, MessageWithParts } from "../types";

/** Fraction of context window that triggers auto-compaction. */
export const COMPACTION_THRESHOLD_RATIO = 0.90;

/**
 * Model-specific overrides for the compaction context limit.
 * GPT-5.4 has a 1M+ context window but degrades in quality at high usage;
 * compact early at 127K instead.
 * Uses prefix matching: "gpt-5.4" also covers "gpt-5.4-2026-03-05".
 */
const COMPACTION_TOKEN_OVERRIDES: Array<{ prefix: string; limit: number }> = [
  { prefix: "gpt-5.4", limit: 128_000 },
];

/**
 * Resolve the context token limit for a given model.
 * Returns the override limit if one exists, otherwise the model's
 * configured context limit from the provider, or null if unknown.
 */
export function resolveCompactionThreshold(
  model: ModelRef,
  allProviders: ProviderListItem[],
): number | null {
  const override = COMPACTION_TOKEN_OVERRIDES.find(
    (entry) =>
      model.modelID === entry.prefix ||
      model.modelID.startsWith(entry.prefix + "-"),
  );
  if (override) return override.limit;

  const provider = allProviders.find((p) => p.id === model.providerID);
  if (!provider) return null;
  const modelData = provider.models[model.modelID];
  if (!modelData?.limit?.context) return null;

  return modelData.limit.context;
}

/**
 * Check whether a session's context usage has reached the compaction threshold.
 * Scans messages from newest to oldest, finding the last assistant message
 * with token info, and compares input tokens against the model's context limit.
 */
export function shouldAutoCompact(
  sessionMessages: MessageWithParts[],
  model: ModelRef,
  allProviders: ProviderListItem[],
): boolean {
  for (let i = sessionMessages.length - 1; i >= 0; i--) {
    const info = sessionMessages[i].info;
    if (info.role !== "assistant") continue;

    const inputTokens = info.tokens?.input;
    if (typeof inputTokens !== "number" || inputTokens <= 0) continue;

    const contextLimit = resolveCompactionThreshold(model, allProviders);
    if (!contextLimit || contextLimit <= 0) return false;

    return inputTokens / contextLimit >= COMPACTION_THRESHOLD_RATIO;
  }

  return false;
}
```

- [ ] **Step 2: Update app.tsx to import from auto-compaction.ts**

In `packages/app/src/app/app.tsx`:

1. Add import at top:
```typescript
import {
  COMPACTION_THRESHOLD_RATIO,
  resolveCompactionThreshold,
  shouldAutoCompact,
} from "./lib/auto-compaction";
```

2. Delete the local definitions (lines ~1786-1835): `COMPACTION_THRESHOLD_RATIO`, `COMPACTION_TOKEN_OVERRIDES`, `resolveCompactionThreshold`, `shouldAutoCompact`.

3. Leave `triggerAutoCompaction`, `compactCurrentSession`, the auto-compact effect, and related signals in app.tsx — they depend on app-level state.

- [ ] **Step 3: Verify build and tests pass**

Run: `cd packages/app && pnpm build 2>&1 | tail -5`
Run: `cd packages/app && pnpm test:unit 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/app/lib/auto-compaction.ts packages/app/src/app/app.tsx
git commit -m "refactor: extract auto-compaction logic to lib/auto-compaction.ts

Move COMPACTION_THRESHOLD_RATIO, resolveCompactionThreshold, and
shouldAutoCompact from app.tsx to a dedicated module. These are pure
functions that compute whether context usage exceeds the threshold.
The effect that triggers compaction and related signals remain in app.tsx."
```

---

## Chunk 3: app.tsx Medium-Risk Extractions (Tasks 5-7)

### Task 5: Extract deep-links.ts

**Files:**
- Create: `packages/app/src/app/lib/deep-links.ts`
- Modify: `packages/app/src/app/app.tsx`

- [ ] **Step 1: Create deep-links.ts**

Create `packages/app/src/app/lib/deep-links.ts` by moving the pure URL-parsing functions from app.tsx. Include these items:

1. `parseSharedBundleDeepLink()` (app.tsx lines ~442-491)
2. `stripSharedBundleQuery()` (app.tsx lines ~493-528)
3. `parseRemoteConnectDeepLink()` (app.tsx lines ~530-558)
4. `stripRemoteConnectQuery()` (app.tsx lines ~560-586)
5. `normalizeSharedBundleImportIntent()` helper (lines ~268-274)
6. Related type imports: `RemoteWorkspaceDefaults`, `SharedBundleDeepLink`, `SharedBundleImportIntent`

The module should also import `normalizeVesloServerUrl` from `../lib/veslo-server` (used by `parseRemoteConnectDeepLink`).

**Key type ownership:** The `SharedBundleDeepLink` type (app.tsx lines ~260-266) and `SharedBundleImportIntent` type (line ~258) are **moved into** deep-links.ts and exported. They are defined here because deep-links.ts is the module that parses and produces these types. shared-bundles.ts (Task 6) will import them from `./deep-links`.

- [ ] **Step 2: Update app.tsx imports and remove moved functions**

1. Add import:
```typescript
import {
  parseSharedBundleDeepLink,
  stripSharedBundleQuery,
  parseRemoteConnectDeepLink,
  stripRemoteConnectQuery,
  type SharedBundleDeepLink,
  type SharedBundleImportIntent,
} from "./lib/deep-links";
```

2. Delete from app.tsx:
   - The `SharedBundleImportIntent` type definition (line ~258)
   - The `SharedBundleDeepLink` type definition (lines ~260-266)
   - `normalizeSharedBundleImportIntent()` function (lines ~268-274)
   - `parseSharedBundleDeepLink()` function (lines ~442-491)
   - `stripSharedBundleQuery()` function (lines ~493-528)
   - `parseRemoteConnectDeepLink()` function (lines ~530-558)
   - `stripRemoteConnectQuery()` function (lines ~560-586)

3. Leave all queue functions (`queueRemoteConnectDeepLink`, `queueSharedBundleDeepLink`, `queueAuthCompleteDeepLink`) and deep-link effects in app.tsx.

- [ ] **Step 3: Verify build and tests pass**

Run: `cd packages/app && pnpm build 2>&1 | tail -5`
Run: `cd packages/app && pnpm test:unit 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/app/lib/deep-links.ts packages/app/src/app/app.tsx
git commit -m "refactor: extract deep-link parsers to lib/deep-links.ts

Move parseSharedBundleDeepLink, stripSharedBundleQuery,
parseRemoteConnectDeepLink, stripRemoteConnectQuery and related types
from app.tsx to a dedicated module. Pure URL parsing — no reactive state.
Queue functions and effects that consume parsed deep-links remain in app.tsx."
```

---

### Task 6: Extract shared-bundles.ts

**Files:**
- Create: `packages/app/src/app/lib/shared-bundles.ts`
- Modify: `packages/app/src/app/app.tsx`

- [ ] **Step 1: Create shared-bundles.ts**

Create `packages/app/src/app/lib/shared-bundles.ts` by moving bundle types and logic from app.tsx. Include:

1. Type definitions: `SharedSkillItem`, `SharedSkillBundleV1`, `SharedSkillsSetBundleV1`, `SharedWorkspaceProfileBundleV1`, `SharedBundleV1` (lines ~220-256)
2. `readRecord()` helper (lines ~276-280)
3. `readSkillItem()` (lines ~282-293)
4. `parseSharedBundle()` (lines ~295-355)
5. `fetchSharedBundle()` (lines ~357-388) — update to use `fetchJson` from `./http`
6. `buildImportPayloadFromBundle()` (lines ~390-440)

Import `SharedBundleDeepLink` type from `./deep-links` (created in Task 5).

For `fetchSharedBundle`, replace the bare `fetch()` with `fetchWithTimeout` from `./http`:

```typescript
import { fetchWithTimeout } from "./http";

export async function fetchSharedBundle(bundleUrl: string): Promise<SharedBundleV1> {
  let targetUrl: URL;
  try {
    targetUrl = new URL(bundleUrl);
  } catch {
    throw new Error("Invalid shared bundle URL.");
  }

  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    throw new Error("Shared bundle URL must use http(s).");
  }

  if (!targetUrl.searchParams.has("format")) {
    targetUrl.searchParams.set("format", "json");
  }

  const response = await fetchWithTimeout(
    globalThis.fetch,
    targetUrl.toString(),
    { method: "GET", headers: { Accept: "application/json" } },
    15_000,
  );

  if (!response.ok) {
    const details = (await response.text()).trim();
    const suffix = details ? `: ${details}` : "";
    throw new Error(`Failed to fetch bundle (${response.status})${suffix}`);
  }

  return parseSharedBundle(await response.json());
}
```

- [ ] **Step 2: Update app.tsx**

1. Add import:
```typescript
import {
  type SharedBundleV1,
  parseSharedBundle,
  fetchSharedBundle,
  buildImportPayloadFromBundle,
} from "./lib/shared-bundles";
```

2. Delete all moved type definitions and functions from app.tsx.

3. Leave the effect that orchestrates bundle import (lines ~3547+), `waitForSharedBundleImportTarget`, `createWorkerForSharedBundle`, and related signals in app.tsx.

- [ ] **Step 3: Verify build and tests pass**

Run: `cd packages/app && pnpm build 2>&1 | tail -5`
Run: `cd packages/app && pnpm test:unit 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/app/lib/shared-bundles.ts packages/app/src/app/app.tsx
git commit -m "refactor: extract shared bundle logic to lib/shared-bundles.ts

Move SharedBundleV1 types, parseSharedBundle, fetchSharedBundle, and
buildImportPayloadFromBundle from app.tsx. fetchSharedBundle now uses
the shared fetchWithTimeout from lib/http.ts instead of a bare fetch().
Bundle import orchestration effect remains in app.tsx."
```

---

### Task 7: Extract provider-auth.ts

**Files:**
- Create: `packages/app/src/app/lib/provider-auth.ts`
- Modify: `packages/app/src/app/app.tsx`

- [ ] **Step 1: Create provider-auth.ts**

Create `packages/app/src/app/lib/provider-auth.ts` by moving provider auth functions from app.tsx (lines ~2202-2568). Include:

1. `loadProviderAuthMethods()` — adjusted to accept `client` and `providers` as params
2. `startProviderAuth()` — accepts `client` param
3. `completeProviderAuthOAuth()` — accepts `client` param
4. `resolveProviderConnectionTestModelID()` — accepts `providers` and `providerDefaults` as params
5. `runProviderConnectionTest()` — accepts `client` and workspace root as params
6. `saveAndTestProviderApiKey()` — accepts `client` param
7. `submitProviderApiKey()` — delegates to `saveAndTestProviderApiKey`
8. `testProviderApiKey()` — delegates to `saveAndTestProviderApiKey`
9. `disconnectProvider()` — accepts `client` param
10. Helper: `describeProviderError()` (keep reference or move if it's nearby)
11. Helper: `assertNoClientError()` (keep reference or move if it's nearby)

**Key pattern:** Every function that currently reads `client()` signal now accepts `client: Client` as a parameter. Every function that currently calls `setProviderAuthError()` now throws — app.tsx wraps calls and sets error state.

For `refreshProviderState`, since it calls `globalSync.set()`, keep it in app.tsx and pass it as a callback to functions that need it.

- [ ] **Step 2: Update app.tsx**

1. Add import for the new module.
2. Delete all moved function definitions.
3. Where app.tsx previously called these functions directly, update to pass `client()` as the first argument and handle returned results.
4. Signals (`providerAuthMethods`, `providerAuthError`, `providerAuthBusy`) and `refreshProviderState` remain in app.tsx.

- [ ] **Step 3: Update LM Studio bare fetch() to use fetchWithTimeout**

In the extracted `connectLmStudioProvider()` in `provider-auth.ts`, replace the bare `fetch(modelsUrl, ...)` call (originally at app.tsx line ~2469) with `fetchWithTimeout` from `./http`:

```typescript
import { fetchWithTimeout } from "./http";

// Inside connectLmStudioProvider, replace:
//   const response = await fetch(modelsUrl, { method: "GET", headers: {...}, signal: ... });
// With:
const response = await fetchWithTimeout(
  globalThis.fetch,
  modelsUrl,
  { method: "GET", headers: { Accept: "application/json" } },
  10_000,
);
```

Remove the manual `AbortController` + `setTimeout` timeout handling around it — `fetchWithTimeout` handles that.

- [ ] **Step 4: Update Den auth bare fetch() in app.tsx**

In `packages/app/src/app/app.tsx`, the Den auth `/v1/me` fetch (line ~3843) stays in app.tsx (tied to onboarding). Update it to use `fetchJson` from `./lib/http`:

```typescript
import { fetchJson } from "./lib/http";

// Replace the bare fetch("/v1/me") call with:
const user = await fetchJson<{ id: string; email?: string; name?: string }>(
  `${denApiBase}/v1/me`,
  {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 10_000,
  },
);
```

This also fixes the existing issue that the Den auth fetch had NO timeout.

- [ ] **Step 5: Verify build and tests pass**

Run: `cd packages/app && pnpm build 2>&1 | tail -5`
Run: `cd packages/app && pnpm test:unit 2>&1 | tail -10`

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/app/lib/provider-auth.ts packages/app/src/app/app.tsx
git commit -m "refactor: extract provider auth functions to lib/provider-auth.ts

Move startProviderAuth, completeProviderAuthOAuth, saveAndTestProviderApiKey,
disconnectProvider, connectLmStudioProvider, and runProviderConnectionTest
from app.tsx. Functions now accept client as a parameter instead of reading
from signals. App.tsx wraps calls with busy/error state management.
LM Studio fetch updated to use fetchWithTimeout from lib/http.ts.
Den auth /v1/me fetch updated to use fetchJson with 10s timeout.
Den auth exchange stays in app.tsx (tied to onboarding state)."
```

---

## Chunk 4: Utils Split + Workspace Stores (Tasks 8-11)

### Task 8: Split utils/index.ts into domain modules

**Files:**
- Create: `packages/app/src/app/utils/models.ts`
- Create: `packages/app/src/app/utils/persistence.ts`
- Create: `packages/app/src/app/utils/paths.ts`
- Create: `packages/app/src/app/utils/messages.ts`
- Create: `packages/app/src/app/utils/tools.ts`
- Create: `packages/app/src/app/utils/files.ts`
- Create: `packages/app/src/app/utils/format.ts`
- Modify: `packages/app/src/app/utils/index.ts` (becomes barrel)

- [ ] **Step 1: Identify function groups in utils/index.ts**

Read `packages/app/src/app/utils/index.ts` fully and categorize every exported function into one of the 7 domain modules. Functions that import from each other must go in the same module or have their dependency extracted.

- [ ] **Step 2: Create domain modules**

For each domain module, create the file, move the relevant functions and their imports, and add the necessary type imports.

Key rules:
- Each function moves EXACTLY once
- All imports used only by functions in that domain go with them
- Shared imports (types, SDK) are imported independently by each module

- [ ] **Step 3: Convert utils/index.ts to barrel**

Replace the contents of `packages/app/src/app/utils/index.ts` with:

```typescript
// Barrel file — re-exports all domain modules for backward compatibility.
// Consumers can import from specific modules for better tree-shaking:
//   import { formatModelRef } from "../utils/models";

export * from "./models";
export * from "./persistence";
export * from "./paths";
export * from "./messages";
export * from "./tools";
export * from "./files";
export * from "./format";
```

- [ ] **Step 4: Verify build and tests pass**

Run: `cd packages/app && pnpm build 2>&1 | tail -5`
Run: `cd packages/app && pnpm test:unit 2>&1 | tail -10`

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/app/utils/
git commit -m "refactor: split utils/index.ts into domain modules

Break 1,210-line utils/index.ts into 7 focused modules:
models, persistence, paths, messages, tools, files, format.
Original index.ts becomes a barrel re-export file.
Zero import changes in consumers — all existing import paths
continue to resolve through the barrel."
```

---

### Task 9: Extract config-store.ts from workspace.ts

**Files:**
- Create: `packages/app/src/app/stores/config-store.ts`
- Modify: `packages/app/src/app/context/workspace.ts`

- [ ] **Step 1: Create stores directory**

Run: `mkdir -p packages/app/src/app/stores`

- [ ] **Step 2: Create config-store.ts**

Create `packages/app/src/app/stores/config-store.ts` with the config/migration/authorized-dirs functions from workspace.ts. Define the `ConfigStoreDeps` interface as specified in the design spec. Move:

- `exportWorkspaceConfig()` (lines ~2687-2736)
- `importWorkspaceConfig()` (lines ~2738-2771)
- `canRepairOpencodeMigration()` (lines ~2771-2774)
- `repairOpencodeMigration()` (lines ~2775-2820)
- `onRepairOpencodeMigration()` (lines ~2820-2827)
- `persistAuthorizedRoots()` (lines ~3304-3318)
- `persistReloadSettings()` (lines ~3319-3335)
- `addAuthorizedDir()` (lines ~3336-3346)
- `addAuthorizedDirFromPicker()` (lines ~3347-3361)
- `removeAuthorizedDir()` (lines ~3361-3368)
- `removeAuthorizedDirAtIndex()` (lines ~3369-3374)

Create related signals inside the store:
- `exportingWorkspaceConfig`, `importingWorkspaceConfig`
- `migrationRepairBusy`, `migrationRepairResult`
- `newAuthorizedDir`

- [ ] **Step 3: Update workspace.ts to create and delegate to config-store**

In `packages/app/src/app/context/workspace.ts`:

1. Import `createConfigStore` from `../stores/config-store`.
2. Inside `createWorkspaceStore()`, after creating workspace-level signals, call:
```typescript
const configStore = createConfigStore({
  getActiveWorkspacePath: () => activeWorkspacePath(),
  getActiveWorkspaceInfo: activeWorkspaceInfo,
  getWorkspaceConfig: workspaceConfig,
  setWorkspaceConfig,
  getAuthorizedDirs: authorizedDirs,
  setAuthorizedDirs,
  setError: options.setError,
  // ... other deps as needed
});
```
3. Delete the moved function definitions from workspace.ts.
4. In the return object, spread `...configStore` or delegate individual methods.

- [ ] **Step 4: Verify build and tests pass**

Run: `cd packages/app && pnpm build 2>&1 | tail -5`
Run: `cd packages/app && pnpm test:unit 2>&1 | tail -10`

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/app/stores/config-store.ts packages/app/src/app/context/workspace.ts
git commit -m "refactor: extract config store from workspace.ts

Move exportWorkspaceConfig, importWorkspaceConfig, migration repair,
and authorized directory management to stores/config-store.ts.
Created inside createWorkspaceStore with dependency injection.
No circular imports — config-store receives deps via typed interface."
```

---

### Task 10: Extract engine-store.ts from workspace.ts

**Files:**
- Create: `packages/app/src/app/stores/engine-store.ts`
- Modify: `packages/app/src/app/context/workspace.ts`

- [ ] **Step 1: Create engine-store.ts**

Create `packages/app/src/app/stores/engine-store.ts` with engine lifecycle functions from workspace.ts. Define the `EngineStoreDeps` interface. Move:

- `refreshEngine()` (lines ~717-770)
- `refreshEngineDoctor()` (lines ~772-786)
- `refreshSandboxDoctor()` (lines ~788-814)
- `startHost()` (lines ~2828-2940+)
- `stopHost()` (lines ~3067-3102)
- `reloadWorkspaceEngine()` (lines ~3104-3219)
- `onInstallEngine()` (lines ~3221-3246)

Create engine-related signals inside the store:
- `engine`, `engineAuth`, `engineDoctorResult`, `engineDoctorCheckedAt`
- `engineInstallLogs`, `sandboxDoctorResult`, `sandboxDoctorCheckedAt`, `sandboxDoctorBusy`

- [ ] **Step 2: Update workspace.ts to create and delegate to engine-store**

1. Import `createEngineStore`.
2. Create inside `createWorkspaceStore()` after workspace signals but before functions that depend on engine state.
3. Delete moved definitions.
4. Update references from direct signal access (`engine()`) to `engineStore.engine()`.
5. Spread or delegate engine methods in the return object.

- [ ] **Step 3: Verify build and tests pass**

Run: `cd packages/app && pnpm build 2>&1 | tail -5`
Run: `cd packages/app && pnpm test:unit 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/app/stores/engine-store.ts packages/app/src/app/context/workspace.ts
git commit -m "refactor: extract engine store from workspace.ts

Move refreshEngine, startHost, stopHost, reloadWorkspaceEngine,
onInstallEngine, and diagnostic functions to stores/engine-store.ts.
Engine-related signals created inside the store. Workspace store
creates engine-store with dependency injection and delegates methods."
```

---

### Task 11: Extract remote-store.ts from workspace.ts

**Files:**
- Create: `packages/app/src/app/stores/remote-store.ts`
- Modify: `packages/app/src/app/context/workspace.ts`

- [ ] **Step 1: Create remote-store.ts**

Create `packages/app/src/app/stores/remote-store.ts` with remote/sandbox functions from workspace.ts. Define the `RemoteStoreDeps` interface (includes `engineStore` reference). Move:

- `resolveVesloHost()` (lines ~453-594)
- `createRemoteWorkspaceFlow()` (lines ~2100-2314)
- `updateRemoteWorkspaceFlow()` (lines ~2316-2467)
- `recoverWorkspace()` (lines ~2501-2613)
- `createSandboxFlow()` (lines ~1863-2098)
- `stopSandbox()` (lines ~2615-2662)

Create sandbox-related signals inside the store:
- `sandboxCreatePhase`, `sandboxCreateProgress`, `sandboxStep`, `sandboxStage`, `sandboxError`
- `sandboxPreflightBusy`

- [ ] **Step 2: Update workspace.ts**

1. Import `createRemoteStore`.
2. Create after engine-store (since remote-store depends on it):
```typescript
const remoteStore = createRemoteStore({
  getWorkspaces: workspaces,
  setWorkspaces,
  getActiveWorkspaceId: activeWorkspaceId,
  getActiveWorkspaceInfo: activeWorkspaceInfo,
  getVesloServerSettings: options.vesloServerSettings,
  engineStore,
  connectToServer,
  setError: options.setError,
  setBusy: options.setBusy,
});
```
3. Delete moved definitions.
4. Delegate in return object.

- [ ] **Step 3: Verify build and tests pass**

Run: `cd packages/app && pnpm build 2>&1 | tail -5`
Run: `cd packages/app && pnpm test:unit 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/app/stores/remote-store.ts packages/app/src/app/context/workspace.ts
git commit -m "refactor: extract remote store from workspace.ts

Move resolveVesloHost, createRemoteWorkspaceFlow, updateRemoteWorkspaceFlow,
recoverWorkspace, createSandboxFlow, and stopSandbox to stores/remote-store.ts.
Remote store receives engine-store as a dependency. Sandbox-related signals
created inside the store. No circular imports."
```

---

## Final Verification (Task 12)

### Task 12: Verify final metrics and commit summary

- [ ] **Step 1: Verify file sizes**

```bash
wc -l packages/app/src/app/app.tsx packages/app/src/app/context/workspace.ts packages/app/src/app/utils/index.ts
```
Expected:
- app.tsx: ~2,500 lines (down from 7,524)
- workspace.ts: ~1,800 lines (down from 3,864)
- utils/index.ts: ~30 lines (down from 1,210)

- [ ] **Step 2: Verify no silent catches remain**

```bash
grep -rn '\.catch.*() *=> *undefined\|\.catch.*() *=> *{}\|\.catch.*() *=> *null\|\.catch.*() *=> *false' packages/app/src/app --include="*.ts" --include="*.tsx" | grep -v 'test\.' | grep -v 'reportError' | grep -v '// Intentionally'
```
Expected: Zero matches (except the 1 intentionally silent telemetry catch with comment).

- [ ] **Step 3: Verify no duplicated fetchWithTimeout**

```bash
grep -rn 'function fetchWithTimeout' packages/app/src/app --include="*.ts"
```
Expected: Only 1 match in `lib/http.ts`.

- [ ] **Step 4: Full build and test suite**

```bash
cd packages/app && pnpm build && pnpm test:unit
```
Expected: All pass, matching the original baseline.

- [ ] **Step 5: Commit verification summary**

```bash
git log --oneline -12
```
Expected: 11 refactoring commits plus this verification.
