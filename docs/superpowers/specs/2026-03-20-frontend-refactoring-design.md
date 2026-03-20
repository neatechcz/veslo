# Frontend Refactoring: God Objects + Error Handling

**Date:** 2026-03-20
**Status:** Approved
**Approach:** Incremental extract-by-concern (Approach A)

## Problem

Two files concentrate too much responsibility, making changes risky and slow:
- `packages/app/src/app/app.tsx` (7,524 lines, ~59 createEffect calls) — routing, deep-links, auth, sync, model persistence, bundle import, compaction
- `packages/app/src/app/context/workspace.ts` (3,864 lines, 40+ constructor params) — workspace CRUD, engine lifecycle, remote provisioning, config import/export, sandbox, bootstrap

Cross-cutting fragility:
- 36 silent error-catch patterns (30x `.catch(() => undefined)`, 2x `.catch(() => null)`, 2x `.catch(() => false)`, 1x `.catch(() => {})`, 1x empty `catch {}`) suppress errors without logging
- 2 duplicated `fetchWithTimeout()` implementations (opencode.ts, veslo-server.ts) plus 3 bare fetch() calls
- `packages/app/src/app/utils/index.ts` (1,210 lines, 40+ unrelated functions) is a junk drawer

## Constraints

- Zero regressions — every extraction step verified with `pnpm build` + `pnpm test:unit`
- Incremental — each extraction is one commit, independently revertible
- Existing patterns preserved — Solid.js signals/stores, Tauri integration, SDK usage unchanged
- No new dependencies introduced

## Scope

**In scope:**
- Extract business logic from app.tsx into focused lib/ modules
- Extract engine, remote, and config stores from workspace.ts
- Replace silent error catches with reportError()
- Consolidate duplicated fetch wrappers into shared http.ts
- Split utils/index.ts into domain modules

**Out of scope:**
- Backend server.ts refactoring
- New test infrastructure (vitest, component tests)
- UI changes or new features
- Type safety improvements (any → typed) — follow-up work

---

## Phase 1: Foundations

### 1A. `packages/app/src/app/lib/error-reporter.ts` (~50 lines)

**Purpose:** Replace 36 silent error-catch patterns with observable error reporting.

**Exports:**
```typescript
type ErrorSeverity = 'warning' | 'error';

export function reportError(
  error: unknown,
  context: string,
  severity?: ErrorSeverity
): undefined;
```

**Behavior:**
- Dev mode (`import.meta.env.DEV`): `console.error(`[${context}]`, error)` with full stack trace
- Prod mode: `console.warn(`[${context}]`, safeStringify(error))` — structured but minimal
- Always returns `undefined` for inline chaining: `.catch(e => reportError(e, "sidebar.refresh"))`
- Default severity: `'warning'` for background refreshes, `'error'` for user-facing operations

**Integration with existing `safe-run.ts`:**
Update `safeAsync`, `safeSync`, `fireAndForget` to call `reportError` internally instead of raw `console.warn`. No API change — existing callers unaffected. Concrete example:
```typescript
// safe-run.ts after integration:
export async function safeAsync<T>(
  fn: () => Promise<T>,
  fallback: T,
  label?: string,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    reportError(error, `safeAsync:${label ?? 'unknown'}`, 'warning');
    return fallback;
  }
}
```
This replaces the existing `if (isDev) console.warn(...)` pattern, ensuring reportError is the single error output channel. No duplicate logging — safe-run delegates to reportError, which handles the dev/prod branching.

**Migration pattern for all 36 catch sites:**
```typescript
// Before:
refreshSidebarWorkspaceSessions().catch(() => undefined)

// After:
refreshSidebarWorkspaceSessions().catch(e => reportError(e, "sidebar.refreshSessions"))
```

**Exact catch site inventory (36 total):**
- `app.tsx`: 19 sites (sidebar refresh, soul data, MCP servers, skills, updates, scheduled jobs, plugins)
- `workspace.ts`: 6 sites (private workspace root, session fetch, skills refresh, plugins refresh, telemetry)
- `system-state.ts`: 3 sites (plugins, skills, MCP refresh after reload)
- `index.tsx`: 2 sites (Tauri initialization)
- `global-sdk.tsx`: 1 site (SSE subscription)
- `server.tsx`: 1 site (health check polling)
- `session.tsx`: 1 site (sendPromptAsync fire-and-forget)
- `identities.tsx`: 1 site (Telegram router fetch)
- `session-navigation.test.ts`: 1 site (test helper — leave as-is)
- `workspace.ts:3426`: 1 site (localhost telemetry — intentionally silent, add comment explaining why)

### 1B. `packages/app/src/app/lib/http.ts` (~80 lines)

**Purpose:** Consolidate duplicated fetch-with-timeout patterns. Currently `opencode.ts` (lines 39-76) and `veslo-server.ts` (lines 1040-1077) have near-identical `fetchWithTimeout()` implementations.

**Exports:**
```typescript
export function fetchWithTimeout(
  url: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<Response>;

export function fetchJson<T>(
  url: string,
  opts?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }
): Promise<T>;
```

**Behavior:**
- `fetchWithTimeout()`: AbortController-based timeout (default 10s). Distinguishes AbortError from network errors. Returns raw Response. This replaces the duplicated implementations.
- `fetchJson<T>()`: Convenience wrapper. Auto-sets JSON headers, serializes body, parses response, throws on non-ok with status + body preview.

**Migration:**
- `opencode.ts` and `veslo-server.ts` import from `lib/http.ts` instead of defining their own
- 3 bare `fetch()` calls in app.tsx (bundle import line 377, LM Studio line 2531, Den auth line 3843) switch to `fetchJson`

**What is NOT replaced:**
- `createTauriFetch()` in opencode.ts — Tauri-specific auth injection stays
- `veslo-server.ts` request methods (`requestJson`, `requestJsonRaw`) — these add Veslo-specific headers and error types on top of fetch; they switch to using `fetchWithTimeout` from http.ts internally

---

## Phase 2: `app.tsx` Decomposition

After Phase 2, app.tsx drops from 7,524 to ~2,500 lines. It retains: routing shell, provider composition, session management core, UI modals/views, Veslo server connection, global preferences, and commands/shortcuts.

### 2A. `packages/app/src/app/lib/deep-links.ts` (~250 lines)

**What moves (pure functions — no reactive state):**

| Function | Current Lines | Purpose |
|----------|-------------|---------|
| `parseRemoteConnectDeepLink()` | 547-586 | Parse Veslo worker connect URLs |
| `stripRemoteConnectQuery()` | 588-618 | Remove deep-link params from browser URL |
| `parseSharedBundleDeepLink()` | 447-507 | Parse shared bundle import URLs |
| `stripSharedBundleQuery()` | 509-545 | Remove bundle params from URL |

**What also moves (listener setup, exported as factory):**
| Function | Current Lines | Purpose |
|----------|-------------|---------|
| `setupTauriDeepLinkListener()` | 6069-6092 | Returns cleanup function for Tauri onOpenUrl |
| `parseWebDeepLinks()` | 6094-6106 | Parse window.location on mount |

**What stays in app.tsx (split responsibility pattern):**
- **Signals** (reactive state, owned by app.tsx): `pendingRemoteConnectDeepLink`, `pendingSharedBundleInvite`
- **Queue functions** (write to signals, depend on app state): `queueRemoteConnectDeepLink()`, `queueSharedBundleDeepLink()`, `queueAuthCompleteDeepLink()` — these read `booting()` and write to the above signals
- **Effects** (consume pending signals, trigger flows): stay in app.tsx because they wire into workspace/auth flows

**Design principle:** Parsing (pure, stateless) moves to `lib/deep-links.ts`. Queuing (writes to app-level signals) stays in app.tsx. This keeps the reactive state ownership clear — deep-links.ts never imports from app.tsx.

**Interface:**
```typescript
// Pure parsers — URL in, typed result out
export function parseRemoteConnectDeepLink(url: string): RemoteConnectDeepLink | null;
export function parseSharedBundleDeepLink(url: string): SharedBundleDeepLink | null;
export function stripRemoteConnectQuery(url: string): string;
export function stripSharedBundleQuery(url: string): string;

// Listener factories
export function setupTauriDeepLinkListener(
  onUrl: (url: string) => void
): Promise<() => void>;
export function parseWebDeepLinks(href: string): {
  remoteConnect?: RemoteConnectDeepLink;
  sharedBundle?: SharedBundleDeepLink;
  authComplete?: AuthCompleteDeepLink;
};
```

### 2B. `packages/app/src/app/lib/shared-bundles.ts` (~300 lines)

**What moves:**

| Item | Current Lines | Purpose |
|------|-------------|---------|
| `SharedBundleV1` type | 228-256 | Bundle schema |
| `SharedBundleDeepLink` type | 260-266 | Parsed deep-link type |
| `readSkillItem()` | 281-293 | Parse individual skill |
| `parseSharedBundle()` | 295-355 | Validate bundle JSON |
| `fetchSharedBundle()` | 357-391 | Fetch from URL (uses new http.ts) |
| `buildImportPayloadFromBundle()` | 393-445 | Convert to import payload |
| `waitForSharedBundleImportTarget()` | 3511-3524 | Poll for connected workspace |
| `createWorkerForSharedBundle()` | 3526-3547 | Create remote worker |

**What stays in app.tsx:**
- The effect (lines 3549-3622) that watches `pendingSharedBundleInvite()` — it becomes a thin orchestrator calling extracted functions
- Signals: `sharedBundleImportBusy`, `sharedBundleNoticeShown`

**Interface:**
```typescript
export type SharedBundleV1 = { ... };
export type SharedBundleDeepLink = { ... };

export function parseSharedBundle(raw: unknown): SharedBundleV1;
export function fetchSharedBundle(url: string): Promise<SharedBundleV1>;
export function buildImportPayloadFromBundle(
  bundle: SharedBundleV1,
  workspacePath: string
): ImportPayload;
// waitForSharedBundleImportTarget requires app-level signals (vesloServerClient,
// vesloServerWorkspaceId, vesloServerStatus). These are passed as params — the
// function does NOT import from app.tsx or use closures over app signals.
export function waitForSharedBundleImportTarget(
  vesloClient: VesloServerClient,
  workspaceId: string,
  opts: { maxAttempts: number; delayMs: number; signal?: AbortSignal }
): Promise<VesloWorkspaceInfo>;
```

### 2C. `packages/app/src/app/lib/model-persistence.ts` (~200 lines)

**What moves (pure data transformation — no side effects):**

| Function | Current Lines | Purpose |
|----------|-------------|---------|
| `parseSessionModelOverrides()` | 2785-2812 | Read overrides from localStorage JSON |
| `serializeSessionModelOverrides()` | 2814-2822 | Write overrides to localStorage JSON |
| `parseDefaultModelFromConfig()` | 2824-2833 | Extract model from opencode config |
| `formatConfigWithDefaultModel()` | 2835-2854 | Inject model into opencode config |

**What stays in app.tsx:**
- All 5 effects that load/persist models (lines 6114-6367) — these effects coordinate multiple concerns (session selection, config format, localStorage, error handling) and remain in app.tsx. They call the extracted pure functions for data transformation only.
- Signals: `defaultModel`, `sessionModelOverrideById`, `sessionModelById`, `legacyDefaultModel`
- localStorage key constants

**Interface:**
```typescript
export function parseSessionModelOverrides(json: string | null): Record<string, string>;
export function serializeSessionModelOverrides(overrides: Record<string, string>): string;
export function parseDefaultModelFromConfig(config: unknown): string | null;
export function formatConfigWithDefaultModel(config: unknown, modelRef: string): unknown;
```

### 2D. `packages/app/src/app/lib/provider-auth.ts` (~350 lines)

**What moves (async functions — accept client as parameter):**

| Function | Current Lines | Purpose |
|----------|-------------|---------|
| `startProviderAuth()` | 2211-2252 | Initiate OAuth flow |
| `completeProviderAuthOAuth()` | 2254-2286 | Complete OAuth callback |
| `runProviderConnectionTest()` | 2322-2365 | Create test session to verify |
| `saveAndTestProviderApiKey()` | 2369-2406 | Add and test API key |
| `submitProviderApiKey()` | 2408-2417 | Public API key submission |
| `testProviderApiKey()` | 2419-2428 | Test key without saving |
| `disconnectProvider()` | 2430-2462 | Remove provider auth |
| `connectLmStudioProvider()` | 2464-2568 | LM Studio specific setup |

**What stays in app.tsx:**
- Signals: `providerAuthMethods`, `providerAuthError`, `providerAuthBusy`
- Provider list memo and the `refreshProviderState()` effect
- Den auth exchange (lines 3789-3870) — stays because it's deeply tied to onboarding state

**State management pattern:** Extracted functions do NOT write to app signals directly. They return results; app.tsx updates its own signals. For functions that need progress callbacks (busy/error), those are passed as explicit parameters.

**Interface:**
```typescript
// Extracted functions accept client + return results.
// App.tsx wraps each call: setBusy(true) → call → setBusy(false), setError(e).
export function startProviderAuth(
  client: OpencodeClient,
  providerId: string,
  redirectUrl: string
): Promise<{ authUrl: string }>;

export function completeProviderAuthOAuth(
  client: OpencodeClient,
  providerId: string,
  code: string,
  state: string
): Promise<void>;

export function saveAndTestProviderApiKey(
  client: OpencodeClient,
  providerId: string,
  apiKey: string,
  opts?: { testModel?: string }
): Promise<{ success: boolean; error?: string }>;

export function disconnectProvider(
  client: OpencodeClient,
  providerId: string
): Promise<void>;

export function connectLmStudioProvider(
  client: OpencodeClient,
  baseUrl: string,
  opts: {
    onBusy: (busy: boolean) => void;
    onError: (error: string | null) => void;
    onModels: (models: string[]) => void;
  }
): Promise<void>;

export function runProviderConnectionTest(
  client: OpencodeClient,
  providerId: string,
  model: string
): Promise<{ success: boolean; error?: string }>;
```

### 2E. `packages/app/src/app/lib/auto-compaction.ts` (~120 lines)

**What moves (pure logic — stateless threshold calculations):**

| Item | Current Lines | Purpose |
|------|-------------|---------|
| `COMPACTION_THRESHOLD_RATIO` | 1786 | 0.90 constant |
| GPT-5.4 override map | 1788-1797 | Model-specific limits |
| `resolveCompactionThreshold()` | 1799-1814 | Get model context limit |
| `shouldAutoCompact()` | 1816-1835 | Check if usage >= threshold |
| `triggerAutoCompaction()` | 1837-1849 | Execute auto-compact |

**What stays in app.tsx:**
- Effect (lines 1852-1870) that watches session status transitions
- Signals: `autoCompactContext`, `autoCompactingSessionId`
- `compactCurrentSession()` (lines 1749-1784) — stays because it uses perf logging tied to app state

**Interface:**
```typescript
export const COMPACTION_THRESHOLD_RATIO = 0.90;

export function resolveCompactionThreshold(
  modelId: string,
  providers: Provider[]
): number | null;

export function shouldAutoCompact(
  messages: Message[],
  modelId: string,
  providers: Provider[]
): boolean;

export function triggerAutoCompaction(
  client: OpencodeClient,
  sessionId: string,
  summary?: string
): Promise<void>;
```

---

## Phase 3: `workspace.ts` Decomposition

After Phase 3, workspace.ts drops from 3,864 to ~1,800 lines. It retains: workspace CRUD, activation orchestration, connection management, authorization, and bootstrap/onboarding.

### Dependency Injection Pattern

The current `createWorkspaceStore()` is a single function with 40+ constructor params that creates all internal signals. The sub-stores (engine, remote, config) are NOT independent modules — they are created INSIDE `createWorkspaceStore()` as composition units.

**How it works:**
1. `createWorkspaceStore()` creates its own signals first (workspaces, activeWorkspaceId, projectDir, etc.)
2. It then calls `createEngineStore(deps)`, `createRemoteStore(deps)`, `createConfigStore(deps)` with closures over those signals
3. Sub-stores create their own internal signals (engine, sandboxPhase, exportingConfig, etc.)
4. `createWorkspaceStore()` exposes sub-store methods on its return object, either directly or via delegation

**Concrete pattern:**
```typescript
export function createWorkspaceStore(options: WorkspaceStoreOptions) {
  // 1. Create workspace-level signals
  const [workspaces, setWorkspaces] = createSignal<WorkspaceInfo[]>([]);
  const [activeWorkspaceId, syncActiveWorkspaceId] = createSignal<string>();
  // ...

  // 2. Create sub-stores with closures over workspace signals
  const engineStore = createEngineStore({
    getActiveWorkspacePath: () => activeWorkspacePath(),
    getActiveWorkspaceRoot: () => activeWorkspaceRoot(),
    getEngineSource: options.engineSource,
    setError: options.setError,
    setBusy: options.setBusy,
    // ...
  });

  const remoteStore = createRemoteStore({
    getWorkspaces: workspaces,
    setWorkspaces,
    engineStore,
    connectToServer,
    // ...
  });

  // 3. Keep core workspace functions here
  function activateWorkspace(...) { ... }
  function connectToServer(...) { ... }

  // 4. Return combined interface
  return {
    // Workspace core
    activateWorkspace,
    createLocalWorkspace,
    // Engine (delegated)
    ...engineStore,
    // Remote (delegated)
    ...remoteStore,
    // Config (delegated)
    ...configStore,
  };
}
```

**This avoids circular imports** — sub-stores never import from workspace.ts. They receive dependencies via their typed `deps` parameter. The workspace store is the composition root.

**Extraction order matters:** 3C (config-store) first because it has the fewest cross-dependencies. Then 3A (engine-store). Then 3B (remote-store) last because it depends on engine-store.

### 3A. `packages/app/src/app/stores/engine-store.ts` (~400 lines)

**What moves:**

| Function | Current Lines | Purpose |
|----------|-------------|---------|
| `refreshEngine()` | 717-771 | Check engine state |
| `refreshEngineDoctor()` | 773-789 | Run engine diagnostics |
| `refreshSandboxDoctor()` | 791-818 | Run sandbox diagnostics |
| `startHost()` | 2918-3027 | Start OpenCode engine |
| `stopHost()` | 3067-3102 | Stop engine |
| `reloadWorkspaceEngine()` | 3104-3219 | Reload with new settings |
| `onInstallEngine()` | 3221-3246 | Install engine binary |

**Interface:**
```typescript
interface EngineStoreDeps {
  getActiveWorkspacePath: () => string | undefined;
  getActiveWorkspaceRoot: () => string | undefined;
  getActiveWorkspaceInfo: () => WorkspaceInfo | undefined;
  getEngineSource: () => EngineSource;
  getEngineCustomBinPath: () => string | undefined;
  setError: (msg: string) => void;
  setBusy: (busy: boolean) => void;
  setBusyLabel: (label: string) => void;
  onEngineStable: () => void;
}

export function createEngineStore(deps: EngineStoreDeps): {
  refreshEngine(): Promise<void>;
  refreshEngineDoctor(): Promise<void>;
  refreshSandboxDoctor(): Promise<void>;
  startHost(opts?: StartHostOpts): Promise<ConnectResult>;
  stopHost(): Promise<void>;
  reloadWorkspaceEngine(): Promise<void>;
  onInstallEngine(opts: InstallOpts): Promise<void>;

  // Reactive getters (read-only)
  engine: Accessor<EngineInfo | null>;
  engineAuth: Accessor<EngineAuth | null>;
  engineDoctorResult: Accessor<DoctorResult | null>;
  // ...
};
```

**Signals:** Engine-related signals move into the engine store (created internally). Workspace store reads them via the returned accessors.

### 3B. `packages/app/src/app/stores/remote-store.ts` (~500 lines)

**What moves:**

| Function | Current Lines | Purpose |
|----------|-------------|---------|
| `resolveVesloHost()` | 453-594 | Veslo server resolution |
| `createRemoteWorkspaceFlow()` | 2100-2314 | Remote workspace creation |
| `updateRemoteWorkspaceFlow()` | 2316-2467 | Remote workspace updates |
| `recoverWorkspace()` | 2501-2613 | Sandbox recovery |
| `createSandboxFlow()` | 1863-2098 | Sandbox creation + Docker |
| `stopSandbox()` | 2615-2662 | Stop sandbox |

**Interface:**
```typescript
interface RemoteStoreDeps {
  getWorkspaces: () => WorkspaceInfo[];
  setWorkspaces: (ws: WorkspaceInfo[]) => void;
  getActiveWorkspaceId: () => string | undefined;
  getActiveWorkspaceInfo: () => WorkspaceInfo | undefined;
  getVesloServerSettings: () => VesloServerSettings;
  engineStore: ReturnType<typeof createEngineStore>;
  connectToServer: (opts: ConnectOpts) => Promise<void>;
  setError: (msg: string) => void;
  setBusy: (busy: boolean) => void;
}

export function createRemoteStore(deps: RemoteStoreDeps): {
  resolveVesloHost(settings: VesloServerSettings): Promise<ResolvedHost>;
  createRemoteWorkspaceFlow(opts: CreateRemoteOpts): Promise<void>;
  updateRemoteWorkspaceFlow(opts: UpdateRemoteOpts): Promise<void>;
  recoverWorkspace(workspaceId: string): Promise<void>;
  createSandboxFlow(opts: SandboxOpts): Promise<void>;
  stopSandbox(workspaceId: string): Promise<void>;

  // Reactive getters
  sandboxCreatePhase: Accessor<string | null>;
  sandboxCreateProgress: Accessor<number>;
  // ...
};
```

### 3C. `packages/app/src/app/stores/config-store.ts` (~250 lines)

**What moves:**

| Function | Current Lines | Purpose |
|----------|-------------|---------|
| `exportWorkspaceConfig()` | 2687-2743 | Export config to file |
| `importWorkspaceConfig()` | 2745-2798 | Import config from file |
| `canRepairOpencodeMigration()` | 2800-2806 | Check repair availability |
| `repairOpencodeMigration()` | 2808-2900 | DB migration repair |
| `onRepairOpencodeMigration()` | 2902-2916 | UI trigger for repair |
| `persistAuthorizedRoots()` | 3304-3320 | Save authorized dirs |
| `persistReloadSettings()` | 3322-3341 | Save reload settings |
| `addAuthorizedDir()` | 3343-3358 | Add to auth list |
| `addAuthorizedDirFromPicker()` | 3360-3380 | Pick and add dir |
| `removeAuthorizedDir()` | 3382-3393 | Remove from auth list |

**Interface:**
```typescript
interface ConfigStoreDeps {
  getActiveWorkspacePath: () => string | undefined;
  getActiveWorkspaceInfo: () => WorkspaceInfo | undefined;
  getWorkspaceConfig: () => WorkspaceConfig | null;
  setWorkspaceConfig: (config: WorkspaceConfig) => void;
  getAuthorizedDirs: () => string[];
  setAuthorizedDirs: (dirs: string[]) => void;
  engineStore: ReturnType<typeof createEngineStore>;
  setError: (msg: string) => void;
}

export function createConfigStore(deps: ConfigStoreDeps): {
  exportWorkspaceConfig(): Promise<void>;
  importWorkspaceConfig(): Promise<void>;
  canRepairOpencodeMigration(): boolean;
  repairOpencodeMigration(): Promise<void>;
  persistAuthorizedRoots(): Promise<void>;
  addAuthorizedDir(dir: string): void;
  addAuthorizedDirFromPicker(): Promise<void>;
  removeAuthorizedDir(dir: string): void;

  // Reactive getters
  exportingConfig: Accessor<boolean>;
  importingConfig: Accessor<boolean>;
  migrationRepairBusy: Accessor<boolean>;
  migrationRepairResult: Accessor<string | null>;
};
```

---

## Phase 4: `packages/app/src/app/utils/index.ts` Split

The 1,210-line file at `packages/app/src/app/utils/index.ts` splits into domain modules within the same directory. A barrel re-export preserves all existing import paths.

**Important:** All new files are created at `packages/app/src/app/utils/` (NOT `packages/app/src/utils/`).

### Target modules:

| Module | Full Path | Functions (examples) | Approx Lines |
|--------|-----------|---------------------|-------------|
| `models.ts` | `packages/app/src/app/utils/models.ts` | `formatModelRef`, `parseModelRef`, `formatModelLabel`, `resolveModelSortGroup` | ~150 |
| `persistence.ts` | `packages/app/src/app/utils/persistence.ts` | `readStartupPreference`, `writeStartupPreference`, `clearStartupPreference`, legacy key migration | ~100 |
| `paths.ts` | `packages/app/src/app/utils/paths.ts` | `normalizePath`, `normalizeDirectoryPath`, `isTauriRuntime`, platform detection | ~80 |
| `messages.ts` | `packages/app/src/app/utils/messages.ts` | `upsertSession`, `upsertMessage`, `removePart`, `updatePart` | ~200 |
| `tools.ts` | `packages/app/src/app/utils/tools.ts` | `getToolInput`, `buildToolTitle`, `buildToolDetail`, tool categorization | ~200 |
| `files.ts` | `packages/app/src/app/utils/files.ts` | File extraction, data transfer helpers | ~100 |
| `format.ts` | `packages/app/src/app/utils/format.ts` | `safeStringify`, `formatDuration`, `formatRelativeTime` | ~80 |
| `index.ts` | `packages/app/src/app/utils/index.ts` | Re-exports from all above | ~30 |

**Safety measure:** `packages/app/src/app/utils/index.ts` becomes a barrel file (`export * from './models'`, etc.). Zero import changes in any consumer. All existing `import { ... } from "./utils"` or `from "../utils"` paths continue to resolve correctly. Consumers can be updated to import from specific modules later.

---

## Verification Protocol

Every extraction step follows this exact sequence:

1. **Baseline:** `pnpm build` + `pnpm test:unit` — record pass/fail counts
2. **Extract:** Move functions to new file, update imports, no logic changes
3. **Verify build:** `pnpm build` — must succeed with zero new warnings
4. **Verify tests:** `pnpm test:unit` — same pass/fail counts as baseline
5. **Smoke test:** Per-extraction checklist (see below)
6. **Commit:** One commit per extraction with descriptive message

**If any step fails:** Revert the extraction, investigate, fix, retry.

### Per-Extraction Smoke Tests

| Step | Smoke Test Focus |
|------|-----------------|
| 1A (error-reporter) | App loads. Open dev console → trigger a background refresh (switch workspace) → verify error context appears in console instead of silent swallow |
| 1B (http.ts) | App loads. Create a session (tests SDK fetch path). Settings → provider page loads (tests Veslo fetch path) |
| 2A (deep-links) | App loads. Open app with a deep-link URL (or paste a veslo:// URL in web mode) → verify it queues correctly |
| 2B (shared-bundles) | App loads. If test bundle URL available, verify import flow. Otherwise: app loads without errors |
| 2C (model-persistence) | App loads. Switch models in session → close/reopen → model persisted. Switch workspaces → per-workspace model preserved |
| 2D (provider-auth) | App loads. Settings → Providers → test OAuth redirect and API key entry |
| 2E (auto-compaction) | App loads. Create session with high token usage → verify compaction triggers when session goes idle |
| 3A-3C (workspace stores) | Full workspace lifecycle: create workspace, switch workspaces, open project folder, settings → authorized dirs |
| 4 (utils split) | App loads. Session works. No import resolution errors in console |

## Dependency Graph

Steps can be parallelized where there are no arrows between them. In practice, since this is incremental, execute sequentially.

```
1A (error-reporter) ──────────────────────────────┐
1B (http.ts) ─────────────┬───────────────────────┤
                          │                       │
                          ├── 2B (shared-bundles)  │
                          │                       │
2C (model-persistence) ───┤                       │
2E (auto-compaction) ─────┤   (all Phase 2 uses   │
2A (deep-links) ──────────┤    error-reporter)    │
2D (provider-auth) ───────┤                       │
                          │                       │
4  (utils split) ─────────┤  (independent)        │
                          │                       │
3C (config-store) ────────┤                       │
3A (engine-store) ────────┤                       │
3B (remote-store) ────────┘── depends on 3A       │
```

**Key dependencies:**
- 1A enables all later steps (every extraction uses reportError)
- 1B enables 2B (shared-bundles uses fetchJson)
- 3B depends on 3A (remote-store receives engine-store as a dep)
- All other steps are independent of each other

---

## Execution Order

| Step | What | Files Created | Files Modified | Risk |
|------|------|--------------|----------------|------|
| 1A | error-reporter.ts | 1 | ~25 (catch replacements) | Low |
| 1B | http.ts | 1 | 3 (opencode.ts, veslo-server.ts, app.tsx) | Low |
| 2C | model-persistence.ts | 1 | 1 (app.tsx) | Low |
| 2E | auto-compaction.ts | 1 | 1 (app.tsx) | Low |
| 2A | deep-links.ts | 1 | 1 (app.tsx) | Medium |
| 2B | shared-bundles.ts | 1 | 1 (app.tsx) | Medium |
| 2D | provider-auth.ts | 1 | 1 (app.tsx) | Medium |
| 4 | utils split | 7 | 1 (utils/index.ts) | Low |
| 3C | config-store.ts | 1 | 1 (workspace.ts) | Medium |
| 3A | engine-store.ts | 1 | 1 (workspace.ts) | High |
| 3B | remote-store.ts | 1 | 1 (workspace.ts) | High |

**Rationale for order:**
- Foundations first (1A, 1B) — every later step benefits
- Low-risk pure-function extractions from app.tsx (2C, 2E) — build confidence
- Medium-risk extractions from app.tsx (2A, 2B, 2D) — URL parsing, fetch, auth flows
- Utils split (4) — lowest risk, can be done anytime
- Workspace stores last (3A-3C) — highest coupling, most complex dependency injection

---

## Success Criteria

After all 11 steps:
- `app.tsx` drops from 7,524 to ~2,500 lines
- `workspace.ts` drops from 3,864 to ~1,800 lines
- `packages/app/src/app/utils/index.ts` drops from 1,210 to ~30 lines (barrel)
- Zero silent error catches remain (36 → 0, except 1 intentional telemetry catch with explanatory comment)
- Zero duplicated fetchWithTimeout implementations (2 → 1 shared in lib/http.ts)
- All existing tests pass
- App behavior unchanged
- Re-run baseline metrics (`wc -l`, `grep createEffect`, `grep '.catch(() =>'`) to confirm targets met
