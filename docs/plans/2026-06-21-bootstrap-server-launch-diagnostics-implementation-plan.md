# Bootstrap Server Launch Diagnostics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build Veslo-owned diagnostics that explain first-run and mid-run local Veslo server failures, including cases where the local Veslo server cannot collect or forward logs.

**Architecture:** The Tauri desktop shell owns a durable diagnostics spool and uploader for desktop-bootstrap, Veslo server launch, supervised Veslo server output, and log-delivery-state events. The local Veslo server is the preferred delivery path when healthy and cloud-forwarding logs, but the desktop switches to direct Den upload when the local server is missing, unhealthy, crashing, has no host-token/base-url state, rejects `/debug-logs`, or reports cloud forwarding disabled. The Solid app supplies Den auth context after login; it does not perform one-shot report upload itself.

**Tech Stack:** SolidJS app, Tauri v2 Rust commands/state, existing desktop debug-log forwarder patterns, Den authenticated HTTP ingest, Node test runner, Rust unit tests, tauri-pilot desktop E2E.

---

## Scope Guard

Do not implement GlitchTip, Bugsink, Sentry SDKs, source map upload, alerting, or external issue grouping in this plan. Leave a clean sink boundary for that later work.

The Den backend source is not an obvious package in this checkout. The Den tasks below must be implemented in the owned-server/Den backend source of truth. In this repo, implement the desktop/app side and document the required Den contract.

This is not just a first-run feature. It must keep working for the whole app run after the user is authenticated.

## Task 1: Add App-Side Diagnostic Event Contract

**Files:**
- Create: `packages/app/src/app/lib/bootstrap-diagnostics.ts`
- Test: `packages/app/src/app/tests/lib/bootstrap-diagnostics.test.ts`

**Step 1: Write the failing test**

Create `packages/app/src/app/tests/lib/bootstrap-diagnostics.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyNewSessionDisabledReason,
  sanitizeBootstrapDiagnosticPayload,
} from "../../lib/bootstrap-diagnostics";

test("classifyNewSessionDisabledReason separates runtime and handler failures", () => {
  assert.equal(
    classifyNewSessionDisabledReason({
      hasRuntimeClient: false,
      runtimeConnecting: false,
      runtimeUnreachable: true,
      hasWorkspaceRoot: true,
      hasQuickChatHandler: true,
    }),
    "runtimeUnreachable",
  );

  assert.equal(
    classifyNewSessionDisabledReason({
      hasRuntimeClient: true,
      runtimeConnecting: false,
      runtimeUnreachable: false,
      hasWorkspaceRoot: true,
      hasQuickChatHandler: false,
    }),
    "missingQuickChatHandler",
  );
});

test("sanitizeBootstrapDiagnosticPayload strips secrets, query strings, and long output", () => {
  const payload = sanitizeBootstrapDiagnosticPayload({
    url: "https://api.veslo.work/v1/foo?token=secret&code=abc",
    path: "/Users/alice/private/project",
    token: "secret-token",
    stderrTail: "x".repeat(10_000),
  });

  assert.equal(payload.url, "https://api.veslo.work/v1/foo?");
  assert.equal(payload.path, "<redacted-path>");
  assert.equal(payload.token, "<redacted>");
  assert.equal(typeof payload.stderrTail, "string");
  assert.ok(String(payload.stderrTail).length < 2_100);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- packages/app/src/app/tests/lib/bootstrap-diagnostics.test.ts
```

Expected: FAIL because `bootstrap-diagnostics.ts` does not exist.

**Step 3: Write minimal implementation**

Create `packages/app/src/app/lib/bootstrap-diagnostics.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

export type NewSessionDisabledReason =
  | "available"
  | "runtimeConnecting"
  | "runtimeUnreachable"
  | "noRuntimeClient"
  | "missingWorkspaceRoot"
  | "missingQuickChatHandler"
  | "unknown";

export type DiagnosticsLane =
  | "desktop-bootstrap"
  | "veslo-server-launch"
  | "veslo-server-supervised-output"
  | "delivery-state";

export type DiagnosticsDeliveryPath =
  | "local-server"
  | "desktop-direct-fallback";

export type NewSessionDisabledInput = {
  hasRuntimeClient: boolean;
  runtimeConnecting: boolean;
  runtimeUnreachable: boolean;
  hasWorkspaceRoot: boolean;
  hasQuickChatHandler: boolean;
};

const MAX_TAIL_CHARS = 2_000;
const SECRET_KEY_PATTERN = /(token|secret|password|cookie|authorization|code|verifier|key)/i;

export function classifyNewSessionDisabledReason(input: NewSessionDisabledInput): NewSessionDisabledReason {
  if (input.runtimeConnecting) return "runtimeConnecting";
  if (input.runtimeUnreachable) return "runtimeUnreachable";
  if (!input.hasRuntimeClient) return "noRuntimeClient";
  if (!input.hasWorkspaceRoot) return "missingWorkspaceRoot";
  if (!input.hasQuickChatHandler) return "missingQuickChatHandler";
  return "available";
}

function sanitizeString(key: string, value: string): string {
  if (SECRET_KEY_PATTERN.test(key)) return "<redacted>";
  if (/path/i.test(key) && /\/Users\/|\\Users\\|\/home\//i.test(value)) return "<redacted-path>";
  if (/url/i.test(key)) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}${url.search ? "?" : ""}`;
    } catch {
      return value.split("?")[0] + (value.includes("?") ? "?" : "");
    }
  }
  if (/stdout|stderr|tail|line/i.test(key) && value.length > MAX_TAIL_CHARS) {
    return `${value.slice(0, MAX_TAIL_CHARS)}...[truncated]`;
  }
  return value;
}

export function sanitizeBootstrapDiagnosticPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") {
      out[key] = sanitizeString(key, raw);
    } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      out[key] = sanitizeBootstrapDiagnosticPayload(raw);
    } else {
      out[key] = raw;
    }
  }
  return out;
}

export async function recordBootstrapDiagnostic(
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const trimmed = eventType.trim();
  if (!trimmed) return;
  await invoke("record_bootstrap_diagnostic", {
    eventType: trimmed,
    payload: sanitizeBootstrapDiagnosticPayload(payload),
  }).catch(() => {});
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- packages/app/src/app/tests/lib/bootstrap-diagnostics.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/bootstrap-diagnostics.ts packages/app/src/app/tests/lib/bootstrap-diagnostics.test.ts
git commit -m "feat: add bootstrap diagnostics app contract"
```

## Task 2: Add Desktop Diagnostics Spool and Cloud Context

**Files:**
- Create: `packages/desktop/src-tauri/src/bootstrap_diagnostics.rs`
- Modify: `packages/desktop/src-tauri/src/lib.rs`
- Test: Rust unit tests inside `packages/desktop/src-tauri/src/bootstrap_diagnostics.rs`

**Step 1: Write the failing Rust tests**

Add tests in the new module for:

- stable `installId` persisted in the diagnostics directory
- unique `bootId` per state construction
- redaction of home paths and secret-looking keys
- report drains only compact events and keeps spool files if serialization fails

Use test names:

```rust
#[test]
fn bootstrap_state_persists_install_id() { /* ... */ }

#[test]
fn sanitize_payload_redacts_paths_and_secrets() { /* ... */ }

#[test]
fn drain_report_includes_boot_and_install_ids() { /* ... */ }
```

**Step 2: Run tests to verify they fail**

Run:

```bash
cd packages/desktop/src-tauri
cargo test bootstrap_diagnostics --lib
```

Expected: FAIL because the module is not wired.

**Step 3: Implement the module**

Create a `BootstrapDiagnostics` state that writes JSONL events to an app-local spool independent of the local Veslo server.

Core shape:

```rust
#[derive(Clone)]
pub struct BootstrapDiagnostics {
    spool_dir: PathBuf,
    pending_path: PathBuf,
    install_id: String,
    boot_id: String,
    sequence: Arc<AtomicU64>,
    write_lock: Arc<Mutex<()>>,
    cloud_context: Arc<Mutex<Option<DiagnosticsCloudContext>>>,
}

#[derive(Clone)]
pub struct DiagnosticsCloudContext {
    pub den_api_base: String,
    pub token: String,
    pub user_id: String,
    pub org_id: String,
}

#[derive(Serialize)]
struct BootstrapDiagnosticEvent {
    id: String,
    #[serde(rename = "installId")]
    install_id: String,
    #[serde(rename = "bootId")]
    boot_id: String,
    lane: String,
    #[serde(rename = "eventType")]
    event_type: String,
    level: String,
    timestamp: u128,
    #[serde(rename = "sequenceNo")]
    sequence_no: u64,
    payload: serde_json::Value,
}
```

Expose methods:

```rust
impl BootstrapDiagnostics {
    pub fn new(spool_dir: PathBuf) -> Self;
    pub fn record(&self, lane: &str, event_type: &str, level: &str, payload: serde_json::Value);
    pub fn flush_to_den_if_configured(&self, reason: &str, max_events: usize) -> Result<usize, String>;
    pub fn set_cloud_context(&self, context: DiagnosticsCloudContext);
    pub fn clear_cloud_context(&self);
    pub fn install_id(&self) -> &str;
    pub fn boot_id(&self) -> &str;
}
```

Add Tauri commands:

```rust
#[tauri::command]
pub fn record_bootstrap_diagnostic(
    state: tauri::State<BootstrapDiagnostics>,
    event_type: String,
    payload: serde_json::Value,
) {
    state.record("desktop-bootstrap", &event_type, "info", payload);
}

#[tauri::command]
pub fn configure_bootstrap_diagnostics_cloud_context(
    state: tauri::State<BootstrapDiagnostics>,
    den_api_base: String,
    token: String,
    user_id: String,
    org_id: String,
) {
    state.set_cloud_context(DiagnosticsCloudContext {
        den_api_base,
        token,
        user_id,
        org_id,
    });
}

#[tauri::command]
pub fn clear_bootstrap_diagnostics_cloud_context(
    state: tauri::State<BootstrapDiagnostics>,
) {
    state.clear_cloud_context();
}
```

Wire in `packages/desktop/src-tauri/src/lib.rs`:

```rust
mod bootstrap_diagnostics;
```

Manage it near the existing debug-log forwarder setup:

```rust
let bootstrap_spool_dir = app
    .path()
    .app_local_data_dir()
    .ok()
    .map(|dir| dir.join("bootstrap-diagnostics-spool"));
if let Some(spool_dir) = bootstrap_spool_dir {
    app.manage(bootstrap_diagnostics::BootstrapDiagnostics::new(spool_dir));
}
```

Register commands:

```rust
bootstrap_diagnostics::record_bootstrap_diagnostic,
bootstrap_diagnostics::configure_bootstrap_diagnostics_cloud_context,
bootstrap_diagnostics::clear_bootstrap_diagnostics_cloud_context,
```

**Step 4: Run tests to verify they pass**

Run:

```bash
cd packages/desktop/src-tauri
cargo test bootstrap_diagnostics --lib
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/desktop/src-tauri/src/bootstrap_diagnostics.rs packages/desktop/src-tauri/src/lib.rs
git commit -m "feat: add desktop diagnostics spool"
```

## Task 3: Instrument Local Veslo Server Launch

**Files:**
- Modify: `packages/desktop/src-tauri/src/veslo_server/mod.rs`
- Modify if needed: `packages/desktop/src-tauri/src/veslo_server/spawn.rs`
- Test: existing Rust module tests in `packages/desktop/src-tauri/src/veslo_server/mod.rs`

**Step 1: Write failing tests for launch event categories**

Add unit tests around a small pure helper:

```rust
fn classify_veslo_server_launch_error(message: &str) -> &'static str
```

Required assertions:

```rust
assert_eq!(classify_veslo_server_launch_error("Address already in use"), "portConflict");
assert_eq!(classify_veslo_server_launch_error("No such file or directory"), "missingBinary");
assert_eq!(classify_veslo_server_launch_error("Permission denied"), "permissionDenied");
assert_eq!(classify_veslo_server_launch_error("connection refused"), "healthCheckFailed");
```

**Step 2: Run tests to verify they fail**

Run:

```bash
cd packages/desktop/src-tauri
cargo test classify_veslo_server_launch_error --lib
```

Expected: FAIL because the helper does not exist.

**Step 3: Implement minimal launch instrumentation**

In `start_veslo_server`, fetch the diagnostics state:

```rust
let diagnostics = app
    .try_state::<crate::bootstrap_diagnostics::BootstrapDiagnostics>()
    .map(|state| state.inner().clone());
```

Record:

- `veslo-server.launch.requested` before idempotent reuse check
- `veslo-server.launch.reused` on idempotent reuse
- `veslo-server.launch.port.resolved` after port selection
- `veslo-server.launch.spawn.attempt` before `spawn_veslo_server`
- `veslo-server.launch.spawn.failed` if `spawn_veslo_server` returns error
- `veslo-server.launch.spawned` after child state is saved
- `veslo-server.launch.persist.failed` if persisting connection state fails
- `veslo-server.process.output` for supervised Veslo server stdout/stderr summaries or lines captured by the desktop
- `veslo-server.process.exited` when the supervised child exits, including code/signal when available

Payloads must include booleans and categories only:

```rust
serde_json::json!({
    "workspaceCount": workspace_paths.len(),
    "hasPreviousClientToken": previous_client_token.is_some(),
    "hasPreviousHostToken": previous_host_token.is_some(),
    "port": port,
    "opencodeRouterHealthPortPresent": opencode_router_health_port.is_some(),
})
```

Never record actual tokens or raw workspace paths.

**Step 4: Run tests to verify they pass**

Run:

```bash
cd packages/desktop/src-tauri
cargo test classify_veslo_server_launch_error --lib
cargo test veslo_server --lib
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/desktop/src-tauri/src/veslo_server/mod.rs packages/desktop/src-tauri/src/veslo_server/spawn.rs
git commit -m "feat: record local server launch diagnostics"
```

## Task 4: Report Local Debug-Log Cloud Delivery State

**Files:**
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/debug-log-pipeline.ts`
- Test: `packages/server/src/tests/server.debug-logs-route.test.ts`

**Step 1: Write failing tests**

Add assertions:

```ts
test("POST /debug-logs reports when cloud upload is enabled", async () => {
  const server = await startTestServer({ debugLogUpload: true });
  const response = await postValidDebugLogBatch(server);
  const payload = await response.json();
  expect(payload.cloudUploadEnabled).toBe(true);
});

test("POST /debug-logs reports when cloud upload is disabled", async () => {
  const server = await startTestServer({ debugLogUpload: false });
  const response = await postValidDebugLogBatch(server);
  const payload = await response.json();
  expect(payload.cloudUploadEnabled).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter veslo-server test -- server.debug-logs-route
```

Expected: FAIL because the response does not include `cloudUploadEnabled`.

**Step 3: Implement minimal server status**

Change the `/debug-logs` success response to include:

```ts
{
  ok: true,
  acceptedBatchIds: [batch.batchId],
  cloudUploadEnabled: debugLogPipeline.isEnabled(),
}
```

Keep `debugLogPipeline.isEnabled()` as the source of truth for whether the server can forward batches to Den.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter veslo-server test -- server.debug-logs-route
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/debug-log-pipeline.ts packages/server/src/tests/server.debug-logs-route.test.ts
git commit -m "feat: report debug log cloud delivery status"
```

## Task 5: Configure Desktop Direct Fallback After Den Auth

**Files:**
- Modify: `packages/app/src/app/lib/bootstrap-diagnostics.ts`
- Modify: `packages/app/src/app/lib/den-auth.ts`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/desktop/src-tauri/src/debug_logs_forwarder.rs`
- Modify: `packages/desktop/src-tauri/src/bootstrap_diagnostics.rs`
- Test: `packages/app/src/app/tests/lib/bootstrap-diagnostics.test.ts`
- Test: add source-level test if needed under `packages/app/src/app/tests/app-bootstrap-diagnostics.test.ts`

**Step 1: Write failing tests**

Extend `bootstrap-diagnostics.test.ts` with:

```ts
import { buildDiagnosticsCloudContextCommand } from "../../lib/bootstrap-diagnostics";

test("buildDiagnosticsCloudContextCommand sends auth to native command only", () => {
  const command = buildDiagnosticsCloudContextCommand({
    auth: {
      denApiBase: "https://api.veslo.work/",
      token: "secret",
      user: { id: "user_1", email: "ina@example.com" },
      orgId: "org_1",
    },
  });

  assert.equal(command.name, "configure_bootstrap_diagnostics_cloud_context");
  assert.equal(command.args.denApiBase, "https://api.veslo.work");
  assert.equal(command.args.token, "secret");
  assert.equal(command.args.userId, "user_1");
  assert.equal(command.args.orgId, "org_1");
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- packages/app/src/app/tests/lib/bootstrap-diagnostics.test.ts
```

Expected: FAIL because upload helper does not exist.

**Step 3: Implement auth context helper**

Add:

```ts
export function buildDiagnosticsCloudContextCommand(input: {
  auth: { denApiBase: string; token: string; user?: { id?: string; email?: string }; orgId?: string };
}) {
  const base = input.auth.denApiBase.trim().replace(/\/+$/, "");
  return {
    name: "configure_bootstrap_diagnostics_cloud_context" as const,
    args: {
      denApiBase: base,
      token: input.auth.token,
      userId: input.auth.user?.id ?? "",
      orgId: input.auth.orgId ?? "",
    },
  };
}

export async function configureDiagnosticsCloudContextAfterAuth(auth: {
  denApiBase: string;
  token: string;
  user?: { id?: string; email?: string };
  orgId?: string;
}): Promise<void> {
  const command = buildDiagnosticsCloudContextCommand({ auth });
  await invoke(command.name, command.args).catch(() => {});
}
```

In `app.tsx`, subscribe to Den auth changes and call `configureDiagnosticsCloudContextAfterAuth` whenever auth becomes available. Clear the native cloud context on logout.

In Rust, the diagnostics flush task should:

- try local `/debug-logs` first when local server state exists
- parse the response and check `cloudUploadEnabled`
- if local delivery fails or `cloudUploadEnabled` is false, use the configured Den cloud context to POST directly to `/v1/desktop-diagnostics`
- record `delivery-state.local-server.failed`, `delivery-state.local-server.cloud-disabled`, `delivery-state.direct-fallback.started`, `delivery-state.direct-fallback.succeeded`, and `delivery-state.direct-fallback.failed`
- keep events in the spool until either local server delivery with cloud forwarding enabled or direct Den delivery succeeds

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- packages/app/src/app/tests/lib/bootstrap-diagnostics.test.ts
pnpm --filter @neatech/veslo-ui test:desktop-auth-onboarding
cd packages/desktop/src-tauri && cargo test bootstrap_diagnostics --lib
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/bootstrap-diagnostics.ts packages/app/src/app/lib/den-auth.ts packages/app/src/app/app.tsx packages/app/src/app/tests/lib/bootstrap-diagnostics.test.ts packages/desktop/src-tauri/src/bootstrap_diagnostics.rs packages/desktop/src-tauri/src/debug_logs_forwarder.rs
git commit -m "feat: configure desktop diagnostics fallback upload"
```

## Task 6: Instrument Chat/New-Session Disabled Reasons

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/tests/components/session/workspace-session-list-interactions.test.ts`
- Test: add `packages/app/src/app/tests/app-bootstrap-diagnostics.test.ts`

**Step 1: Write failing tests**

Add a source-level test that asserts:

- `WorkspaceSessionList` records `chat.button.state`
- `startQuickChat` records `chat.button.click`
- disabled reason uses `classifyNewSessionDisabledReason`

Example assertion:

```ts
assert.match(source, /recordBootstrapDiagnostic\("chat\.button\.state"/);
assert.match(source, /recordBootstrapDiagnostic\("chat\.button\.click"/);
assert.match(source, /classifyNewSessionDisabledReason/);
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- packages/app/src/app/tests/components/session/workspace-session-list-interactions.test.ts
```

Expected: FAIL because instrumentation is missing.

**Step 3: Implement instrumentation**

In `WorkspaceSessionList`, import:

```ts
import {
  classifyNewSessionDisabledReason,
  recordBootstrapDiagnostic,
} from "../../lib/bootstrap-diagnostics";
```

Record state when the component computes or renders the quick chat button:

```ts
const quickChatDisabledReason = createMemo(() =>
  classifyNewSessionDisabledReason({
    hasRuntimeClient: !props.newTaskDisabled,
    runtimeConnecting: false,
    runtimeUnreachable: props.newTaskDisabled,
    hasWorkspaceRoot: true,
    hasQuickChatHandler: Boolean(props.onQuickNewSession),
  }),
);

createEffect(() => {
  void recordBootstrapDiagnostic("chat.button.state", {
    surface: "workspace-session-list",
    disabledReason: quickChatDisabledReason(),
    hasQuickChatHandler: Boolean(props.onQuickNewSession),
    newTaskDisabled: props.newTaskDisabled,
  });
});
```

In `startQuickChat`:

```ts
void recordBootstrapDiagnostic("chat.button.click", {
  surface: "workspace-session-list",
  disabledReason: quickChatDisabledReason(),
  hasQuickChatHandler: Boolean(props.onQuickNewSession),
});
```

If `app.tsx` has better runtime state than `WorkspaceSessionList`, pass explicit booleans rather than deriving runtime unavailability from `newTaskDisabled`.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- packages/app/src/app/tests/components/session/workspace-session-list-interactions.test.ts
pnpm --filter @neatech/veslo-ui test:unit -- packages/app/src/app/tests/app-create-session-health-fallback.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/app.tsx packages/app/src/app/tests
git commit -m "feat: record chat entry diagnostics"
```

## Task 7: Define and Implement Den Desktop Diagnostics Ingest

**Files:**
- Den backend source of truth, not present as an obvious package in this checkout.
- Update this repo docs if Den lives elsewhere: `docs/dev/state-and-config-reference.md`
- Update this repo docs if needed: `docs/dev/veslo-server-app-contract.md`

**Step 1: Write failing Den backend tests**

Tests must prove:

- unauthenticated `POST /v1/desktop-diagnostics` returns `401`
- authenticated user can post compact desktop diagnostics
- payload is encrypted at rest
- cleartext metadata can be queried by user, boot id, install id hash, source lane, event type, and time
- unsupported lanes and unbounded full-log payloads are rejected
- retention expiry is set

**Step 2: Implement endpoint**

Endpoint contract:

```ts
type DesktopDiagnosticsRequest = {
  bootId: string;
  installId: string;
  userId?: string;
  orgId?: string;
  appVersion?: string;
  platform?: string;
  events: Array<{
    id?: string;
    lane:
      | "desktop-bootstrap"
      | "veslo-server-launch"
      | "veslo-server-supervised-output"
      | "delivery-state";
    eventType: string;
    level?: "info" | "warn" | "error";
    timestamp: number | string;
    sequenceNo?: number;
    deliveryPath?: "desktop-direct-fallback";
    payload?: Record<string, unknown>;
  }>;
};
```

Reject any event lane outside the four allowed desktop-owned lanes. Runtime logs sent by the local server remain on the existing internal debug-log ingest.

Store cleartext metadata plus encrypted payload in a dedicated table such as `desktop_bootstrap_diagnostic_event`.

**Step 3: Implement read APIs**

Minimum admin APIs:

- `GET /admin/api/desktop-diagnostics?userId=&from=&to=`
- `GET /admin/api/desktop-diagnostics/:bootId`
- `GET /admin/api/desktop-diagnostics/:bootId/export`

**Step 4: Run Den tests**

Use the Den backend test runner for the owned-server source tree.

Expected: all new tests PASS.

**Step 5: Commit in Den backend repo**

Commit only the Den backend files and docs in that repository.

## Task 8: Add Real Desktop E2E Coverage

**Files:**
- Add or modify tauri-pilot scenario under `packages/e2e/specs` or the current pilot scenario location.
- Modify `packages/e2e/package.json` only if adding a focused script.
- Use `docs/dev/testing-playbook.md`.

**Step 1: Write failing E2E scenario**

Scenario requirements:

- start with isolated profile
- simulate local Veslo server launch failure by using a test-only env/config hook
- complete or seed Den auth
- verify app remains usable enough to upload bootstrap diagnostics
- assert Den/mock ingest received `desktop-bootstrap`, `veslo-server-launch`, and `delivery-state` events
- assert no `veslo-server-runtime` events are required for the failure explanation
- simulate a mid-run local Veslo server crash and assert Den/mock ingest receives `veslo-server-supervised-output` and fallback delivery events
- simulate local `/debug-logs` returning `cloudUploadEnabled: false` and assert desktop uses direct Den fallback

**Step 2: Run preflight**

Run:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If matches are internally started dev/test processes, stop them per the playbook before launching.

**Step 3: Build real desktop E2E binary**

Run:

```bash
pnpm --filter veslo-server build:bin
VESLO_SIDECAR_FORCE_BUILD=1 pnpm --filter @neatech/veslo run prepare:sidecar
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
```

Expected: build succeeds.

**Step 4: Run focused pilot scenario**

Run from `packages/e2e`:

```bash
pnpm test -- --scenario bootstrap-server-launch-diagnostics
```

Expected: scenario fails before implementation, then passes after all tasks.

**Step 5: Commit**

```bash
git add packages/e2e packages/desktop packages/app docs/dev
git commit -m "test: cover bootstrap server launch diagnostics"
```

## Task 9: Final Verification and Docs

**Files:**
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/dev/veslo-server-app-contract.md`
- Modify: `docs/features/onboarding-and-auth.md` if user-visible first-run behavior is clarified.

**Step 1: Update docs**

Document:

- bootstrap diagnostics spool location
- lane separation
- continuous direct Den fallback trigger
- local `/debug-logs` `cloudUploadEnabled` handshake
- privacy/redaction boundary
- admin lookup expectations
- GlitchTip/Bugsink explicitly out of this slice

**Step 2: Run focused checks**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
cd packages/desktop/src-tauri && cargo test bootstrap_diagnostics --lib && cargo test veslo_server --lib
```

If `packages/server/src` changes during implementation, also run:

```bash
pnpm --filter veslo-server build:bin
```

Run the focused real desktop E2E from Task 8.

**Step 3: Refresh graph if available**

Run:

```bash
graphify update .
```

If `graphify` is not available, skip and note it in the final handoff.

**Step 4: Commit**

```bash
git add docs/dev docs/plans
git commit -m "docs: document bootstrap diagnostics"
```
