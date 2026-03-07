# Cloud-Only Login and Environment Modes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Force cloud-only login/connect behavior in every build/runtime (`development`, `test`, `production`), remove local user-facing controls, and keep branch compatibility by preserving local internals behind guards.

**Architecture:** Add a shared cloud policy + environment resolver in the app layer, apply workspace migration and action guards in bootstrap/runtime paths, simplify onboarding/settings/session UI to remote-only, and sanitize desktop workspace bootstrap state so local entries are not reintroduced.

**Tech Stack:** SolidJS + TypeScript (`packages/app`), Tauri Rust (`packages/desktop/src-tauri`), Node assert-based scripts, Cargo tests.

---

## Skills and Workflow

- Use `@test-driven-development` for each behavior change.
- Use `@verification-before-completion` before claiming task completion.
- For end-to-end UI validation, use `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md`.

### Task 1: Cloud-Only Policy and Environment Resolver Utilities

**Files:**
- Create: `packages/app/src/app/lib/cloud-policy.impl.js`
- Create: `packages/app/src/app/lib/cloud-policy.ts`
- Create: `packages/app/scripts/cloud-policy.mjs`
- Modify: `packages/app/package.json`

**Step 1: Write the failing test**

```js
// packages/app/scripts/cloud-policy.mjs
import assert from "node:assert/strict";
import {
  CLOUD_ONLY_MODE,
  filterRemoteWorkspaces,
  resolveVesloCloudEnvironment,
} from "../src/app/lib/cloud-policy.impl.js";

assert.equal(CLOUD_ONLY_MODE, true);

const filtered = filterRemoteWorkspaces([
  { id: "l1", workspaceType: "local" },
  { id: "r1", workspaceType: "remote" },
]);
assert.deepEqual(filtered.map((x) => x.id), ["r1"]);

const env = resolveVesloCloudEnvironment({
  VITE_VESLO_ENV: "test",
  VITE_VESLO_URL_TEST: "https://test.veslo.example",
  VITE_VESLO_LOGIN_URL_TEST: "https://auth.test.veslo.example",
});
assert.equal(env.name, "test");
assert.equal(env.vesloUrl, "https://test.veslo.example");
assert.equal(env.loginUrl, "https://auth.test.veslo.example");

console.log(JSON.stringify({ ok: true }));
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:cloud-policy`  
Expected: FAIL (`ERR_MODULE_NOT_FOUND` or missing export) because utility file does not exist yet.

**Step 3: Write minimal implementation**

```js
// packages/app/src/app/lib/cloud-policy.impl.js
export const CLOUD_ONLY_MODE = true;

export const filterRemoteWorkspaces = (items) =>
  (Array.isArray(items) ? items : []).filter(
    (entry) => String(entry?.workspaceType ?? "").toLowerCase() === "remote",
  );

const normalizeUrl = (raw) => {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value.replace(/\/+$/, "") : `https://${value}`.replace(/\/+$/, "");
};

export const resolveVesloCloudEnvironment = (env) => {
  const nameRaw = String(env?.VITE_VESLO_ENV ?? "production").trim().toLowerCase();
  const name = nameRaw === "development" || nameRaw === "test" || nameRaw === "production" ? nameRaw : "production";
  const suffix = name === "development" ? "DEV" : name === "test" ? "TEST" : "PROD";
  const vesloUrl = normalizeUrl(env?.[`VITE_VESLO_URL_${suffix}`] ?? env?.VITE_VESLO_URL ?? "");
  const loginUrl = normalizeUrl(env?.[`VITE_VESLO_LOGIN_URL_${suffix}`] ?? env?.VITE_VESLO_LOGIN_URL ?? "");
  const token = String(env?.[`VITE_VESLO_TOKEN_${suffix}`] ?? env?.VITE_VESLO_TOKEN ?? "").trim();
  return { name, vesloUrl, loginUrl, token: token || undefined };
};
```

```ts
// packages/app/src/app/lib/cloud-policy.ts
import {
  CLOUD_ONLY_MODE as CLOUD_ONLY_MODE_IMPL,
  filterRemoteWorkspaces as filterRemoteWorkspacesImpl,
  resolveVesloCloudEnvironment as resolveVesloCloudEnvironmentImpl,
} from "./cloud-policy.impl.js";

export const CLOUD_ONLY_MODE = CLOUD_ONLY_MODE_IMPL as boolean;
export const filterRemoteWorkspaces = filterRemoteWorkspacesImpl as <T extends { workspaceType?: string }>(items: T[]) => T[];
export const resolveVesloCloudEnvironment = resolveVesloCloudEnvironmentImpl as (env: Record<string, string | undefined>) => {
  name: "development" | "test" | "production";
  vesloUrl: string;
  loginUrl: string;
  token?: string;
};
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @neatech/veslo-ui test:cloud-policy`  
Expected: PASS with `{ "ok": true }`.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/cloud-policy.impl.js packages/app/src/app/lib/cloud-policy.ts packages/app/scripts/cloud-policy.mjs packages/app/package.json
git commit -m "test(app): add cloud-only policy resolver coverage"
```

### Task 2: Wire Environment Resolver into Veslo Settings and App Entry

**Files:**
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/entry.tsx`
- Modify: `packages/app/src/app/context/server.tsx`

**Step 1: Write the failing test**

Extend `packages/app/scripts/cloud-policy.mjs` with this assertion:

```js
const devEnv = resolveVesloCloudEnvironment({
  VITE_VESLO_ENV: "development",
  VITE_VESLO_URL_DEV: "https://dev.veslo.example",
});
assert.equal(devEnv.vesloUrl, "https://dev.veslo.example");
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:cloud-policy`  
Expected: FAIL if resolver mapping still ignores `*_DEV` / `*_TEST` / `*_PROD`.

**Step 3: Write minimal implementation**

```ts
// packages/app/src/app/lib/veslo-server.ts (hydrateVesloServerSettingsFromEnv)
import { resolveVesloCloudEnvironment } from "./cloud-policy";

const resolved = resolveVesloCloudEnvironment(import.meta.env as Record<string, string | undefined>);
if (!current.urlOverride && resolved.vesloUrl) next.urlOverride = resolved.vesloUrl;
if (!current.token && resolved.token) next.token = resolved.token;
```

```tsx
// packages/app/src/app/entry.tsx
import { resolveVesloCloudEnvironment } from "./lib/cloud-policy";
const cloud = resolveVesloCloudEnvironment(import.meta.env as Record<string, string | undefined>);
if (cloud.vesloUrl) return `${cloud.vesloUrl}/opencode`;
```

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @neatech/veslo-ui test:cloud-policy && pnpm --filter @neatech/veslo-ui typecheck`  
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/veslo-server.ts packages/app/src/app/entry.tsx packages/app/src/app/context/server.tsx packages/app/scripts/cloud-policy.mjs
git commit -m "feat(app): resolve cloud targets per environment profile"
```

### Task 3: Bootstrap Migration and Runtime Guards in Workspace Store

**Files:**
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/types.ts`
- Modify: `packages/app/src/app/utils/index.ts`
- Modify: `packages/app/src/app/app.tsx`

**Step 1: Write the failing test**

Extend `packages/app/scripts/cloud-policy.mjs` with migration/guard assertions:

```js
const migrated = filterRemoteWorkspaces([
  { id: "legacy-local", workspaceType: "local" },
  { id: "cloud-a", workspaceType: "remote" },
]);
assert.deepEqual(migrated.map((x) => x.id), ["cloud-a"]);
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:cloud-policy`  
Expected: FAIL if bootstrap path still keeps local workspace entries.

**Step 3: Write minimal implementation**

```ts
// packages/app/src/app/context/workspace.ts (bootstrapOnboarding)
import { CLOUD_ONLY_MODE, filterRemoteWorkspaces } from "../lib/cloud-policy";

const boot = await workspaceBootstrap();
const cloudOnly = CLOUD_ONLY_MODE ? filterRemoteWorkspaces(boot.workspaces) : boot.workspaces;
setWorkspaces(cloudOnly);
syncActiveWorkspaceId(cloudOnly[0]?.id ?? "");
options.setStartupPreference("server");
options.setOnboardingStep("server");
```

```ts
// Guard local-only actions
if (CLOUD_ONLY_MODE) {
  options.setError("Local workers are disabled in cloud-only mode.");
  return false;
}
```

```ts
// packages/app/src/app/utils/index.ts
export function readStartupPreference(): "server" | null { ... } // map any stored "local"/"host" to "server"
```

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @neatech/veslo-ui test:cloud-policy && pnpm --filter @neatech/veslo-ui typecheck`  
Expected: PASS, no type regressions.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/workspace.ts packages/app/src/app/types.ts packages/app/src/app/utils/index.ts packages/app/src/app/app.tsx packages/app/scripts/cloud-policy.mjs
git commit -m "feat(app): enforce cloud-only bootstrap and local action guards"
```

### Task 4: Make Onboarding Remote-Only

**Files:**
- Modify: `packages/app/src/app/pages/onboarding.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Create: `packages/app/scripts/cloud-onboarding.mjs`
- Modify: `packages/app/package.json`

**Step 1: Write the failing test**

```js
// packages/app/scripts/cloud-onboarding.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/app/pages/onboarding.tsx", import.meta.url), "utf8");
assert.equal(source.includes('onSelectStartup("local")'), false);
assert.equal(source.includes('props.onboardingStep === "local"'), false);
console.log(JSON.stringify({ ok: true }));
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:cloud-onboarding`  
Expected: FAIL because local onboarding branch still exists.

**Step 3: Write minimal implementation**

```tsx
// Keep only "connecting" and "server" onboarding branches.
// Remove local-start card, local attach card, and "onSelectStartup('local')" controls.
<Match when={props.onboardingStep === "server"}>{/* remote-only connect UI */}</Match>
```

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @neatech/veslo-ui test:cloud-onboarding && pnpm --filter @neatech/veslo-ui typecheck`  
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/onboarding.tsx packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/zh.ts packages/app/src/i18n/locales/cs.ts packages/app/scripts/cloud-onboarding.mjs packages/app/package.json
git commit -m "feat(app): switch onboarding to cloud-only remote flow"
```

### Task 5: Remove Local Controls from Settings/Status UI

**Files:**
- Modify: `packages/app/src/app/pages/settings.tsx`
- Modify: `packages/app/src/app/components/status-bar.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Create: `packages/app/scripts/cloud-ui-guards.mjs`
- Modify: `packages/app/package.json`

**Step 1: Write the failing test**

```js
// packages/app/scripts/cloud-ui-guards.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = readFileSync(new URL("../src/app/pages/settings.tsx", import.meta.url), "utf8");
assert.equal(settings.includes("Start local server"), false);
assert.equal(settings.includes("Local Server"), false);
console.log(JSON.stringify({ ok: true }));
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:cloud-ui-guards`  
Expected: FAIL while local labels/controls still exist.

**Step 3: Write minimal implementation**

```tsx
// settings.tsx / status-bar.tsx
// Remove local runtime controls and labels.
// Keep reconnect/diagnostics for remote cloud server only.
```

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @neatech/veslo-ui test:cloud-ui-guards && pnpm --filter @neatech/veslo-ui typecheck`  
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/settings.tsx packages/app/src/app/components/status-bar.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/session.tsx packages/app/scripts/cloud-ui-guards.mjs packages/app/package.json
git commit -m "refactor(app): remove local controls from cloud-only UI"
```

### Task 6: Sanitize Desktop Workspace Bootstrap State (No Local Entries)

**Files:**
- Modify: `packages/desktop/src-tauri/src/commands/workspace.rs`
- Modify: `packages/desktop/src-tauri/src/workspace/state.rs`
- Modify: `packages/desktop/src-tauri/src/types.rs`

**Step 1: Write the failing test**

Add `#[cfg(test)]` in `workspace/state.rs`:

```rust
#[test]
fn cloud_only_sanitizer_drops_local_workspaces() {
    let mut state = WorkspaceState {
        version: WORKSPACE_STATE_VERSION,
        active_id: "local".into(),
        workspaces: vec![
            WorkspaceInfo { id: "local".into(), workspace_type: WorkspaceType::Local, ..sample_local() },
            WorkspaceInfo { id: "remote".into(), workspace_type: WorkspaceType::Remote, ..sample_remote() },
        ],
    };
    sanitize_cloud_only_state(&mut state);
    assert_eq!(state.workspaces.len(), 1);
    assert_eq!(state.workspaces[0].id, "remote");
    assert_eq!(state.active_id, "remote");
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml cloud_only_sanitizer_drops_local_workspaces`  
Expected: FAIL because sanitizer function does not exist yet.

**Step 3: Write minimal implementation**

```rust
pub fn sanitize_cloud_only_state(state: &mut WorkspaceState) {
    state.workspaces.retain(|w| w.workspace_type == WorkspaceType::Remote);
    state.active_id = state.workspaces.first().map(|w| w.id.clone()).unwrap_or_default();
}
```

Apply during `workspace_bootstrap` before save/return so local entries are not persisted or shown.

**Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml cloud_only_sanitizer_drops_local_workspaces`  
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/desktop/src-tauri/src/commands/workspace.rs packages/desktop/src-tauri/src/workspace/state.rs packages/desktop/src-tauri/src/types.rs
git commit -m "feat(desktop): sanitize workspace state for cloud-only mode"
```

### Task 7: Full Verification, Docker Stack, Chrome MCP, and Evidence

**Files:**
- Create: `evidence/cloud-only-login/` (screenshots)
- Modify: `docs/plans/2026-03-07-cloud-only-login-environments-design.md` (verification notes)

**Step 1: Write the failing verification command set**

Run the intended suite once before final fixes:

```bash
pnpm --filter @neatech/veslo-ui test:cloud-policy
pnpm --filter @neatech/veslo-ui test:cloud-onboarding
pnpm --filter @neatech/veslo-ui test:cloud-ui-guards
pnpm --filter @neatech/veslo-ui typecheck
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml cloud_only_sanitizer_drops_local_workspaces
```

Expected: at least one command fails before all implementation tasks are complete.

**Step 2: Start Docker dev stack and run end-to-end cloud-only flow**

Run:

```bash
packaging/docker/dev-up.sh
```

Then execute Chrome MCP flow from `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md` to validate:
- onboarding is remote-only
- local controls are absent
- environment-selected cloud endpoint is used
- connect remote worker succeeds

**Step 3: Capture screenshots**

Save screenshots in:

```text
evidence/cloud-only-login/
```

Required captures:
- remote-only onboarding screen
- settings without local controls
- successful connected remote workspace

**Step 4: Run final verification to pass**

Re-run the full command set from Step 1 and confirm all PASS.

**Step 5: Commit**

```bash
git add evidence/cloud-only-login docs/plans/2026-03-07-cloud-only-login-environments-design.md
git commit -m "test: verify cloud-only flow with docker and chrome mcp evidence"
```

