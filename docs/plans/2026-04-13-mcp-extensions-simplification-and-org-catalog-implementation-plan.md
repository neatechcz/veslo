# MCP Extensions Simplification And Org Catalog Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Simplify the existing Extensions screen down to MCP-only behavior, keep `Control Chrome` as the single built-in app, auto-seed it into local workspace MCP config, and add org-scoped MCP catalog fetch/install routes that mirror the approved Skills flow.

**Architecture:** Treat this as three coordinated slices: app UI simplification, Den-backed MCP catalog transport, and local workspace Chrome seeding. Reuse the existing Skills catalog pattern wherever naming and transport should match, but keep MCP install semantics separate because MCP installation mutates `opencode.json[c]` and may continue into auth/connect flows instead of writing files into `.opencode/skills`.

**Tech Stack:** SolidJS app (`createSignal`, `createMemo`, source-contract tests, Node test runner), Veslo server (`bun test`, HTTP route tests), Den Express service (`tsx --test`), Tauri/Rust workspace bootstrap, WebdriverIO Tauri E2E.

---

Execution notes:

- Apply `@using-git-worktrees` before the first code change.
- Apply `@test-driven-development` for each behavior change.
- Apply `@verification-before-completion` before claiming done.
- Follow `AGENTS.md` new feature workflow: sync remotes/submodules, use a worktree, start `packaging/docker/dev-up.sh`, run desktop E2E through the Tauri binary, and capture screenshots.
- Never run `packages/web` directly. Use the Tauri desktop workflow only.
- Do not remove plugin backend/server capabilities in this slice. Remove only user-facing plugin behavior from the Extensions screen.

Pre-flight commands:

```bash
git fetch --all --prune
git submodule update --init --recursive
git worktree add ../Veslo-mcp-extensions -b codex/mcp-extensions-catalog
cd ../Veslo-mcp-extensions
```

### Task 1: Lock The Extensions Screen Simplification Contract

**Files:**
- Create: `packages/app/src/app/extensions-screen-simplification.test.ts`
- Modify: `packages/app/src/app/constants.test.ts`
- Test: `packages/app/src/app/extensions-screen-simplification.test.ts`
- Test: `packages/app/src/app/constants.test.ts`

**Step 1: Write the failing tests**

Create `extensions-screen-simplification.test.ts` as a source-contract guard:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extensionsSource = readFileSync(new URL("./pages/extensions.tsx", import.meta.url), "utf8");
const mcpSource = readFileSync(new URL("./pages/mcp.tsx", import.meta.url), "utf8");

test("extensions screen no longer imports plugin view or section state", () => {
  assert.doesNotMatch(extensionsSource, /import PluginsView/);
  assert.doesNotMatch(extensionsSource, /ExtensionsSection/);
  assert.doesNotMatch(extensionsSource, /extensions\.plugins/);
});

test("mcp screen no longer renders advanced settings or technical details", () => {
  assert.doesNotMatch(mcpSource, /mcp\.advanced_settings/);
  assert.doesNotMatch(mcpSource, /mcp\.technical_details/);
});
```

Extend `constants.test.ts` with:

```ts
test("built-in MCP quick connect list contains only Control Chrome", () => {
  assert.deepEqual(
    MCP_QUICK_CONNECT.map((entry) => entry.id ?? entry.name),
    ["chrome-devtools"],
  );
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/extensions-screen-simplification.test.ts src/app/constants.test.ts
```

Expected: FAIL because `extensions.tsx` still imports plugin UI and `MCP_QUICK_CONNECT` still contains multiple built-ins.

**Step 3: Write the minimal implementation**

Make only the contract-breaking removals needed to satisfy the tests:

- remove plugin import and section-state logic from `pages/extensions.tsx`
- reduce `MCP_QUICK_CONNECT` to only `Control Chrome`
- remove the `Technical details` and `Advanced settings` blocks from `pages/mcp.tsx`

Do not yet add catalog behavior in this task.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/extensions-screen-simplification.test.ts src/app/constants.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/extensions-screen-simplification.test.ts packages/app/src/app/constants.test.ts packages/app/src/app/constants.ts packages/app/src/app/pages/extensions.tsx packages/app/src/app/pages/mcp.tsx
git commit -m "feat(app): simplify extensions screen to MCP only"
```

### Task 2: Finish App UI Wiring And Localized Copy Cleanup

**Files:**
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Test: `packages/app/src/app/extensions-screen-simplification.test.ts`
- Test: `packages/app/src/app/pages/dashboard-menu-navigation.test.ts`
- Test: `packages/app/src/app/pages/dashboard-sidebar-navigation-layout.test.ts`

**Step 1: Extend tests for copy and dashboard wiring**

Add assertions that:

- dashboard still routes Extensions through the MCP screen
- plugin-specific Extensions copy is gone
- plugin layout is not required by source-contract tests anymore

Add/update assertions such as:

```ts
assert.doesNotMatch(extensionsSource, /extensions\.plugins_opencode/);
assert.doesNotMatch(extensionsSource, /extensions\.all/);
assert.doesNotMatch(extensionsSource, /extensions\.apps/);
```

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/extensions-screen-simplification.test.ts src/app/pages/dashboard-menu-navigation.test.ts src/app/pages/dashboard-sidebar-navigation-layout.test.ts
```

Expected: FAIL because dashboard/app/i18n still assume plugin-capable Extensions copy and prop wiring.

**Step 3: Write the minimal implementation**

In `dashboard.tsx` and `app.tsx`:

- stop requiring plugin props for `ExtensionsView`
- keep navigation targeting the existing Extensions/MCP destination
- preserve compatibility if legacy internal `"plugins"` tab values still normalize to `"mcp"`

In locale catalogs:

- rewrite Extensions subtitle to MCP-only wording
- remove or stop referencing stale plugin-specific Extensions strings
- keep `Add MCP server` and core MCP labels intact

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/extensions-screen-simplification.test.ts src/app/pages/dashboard-menu-navigation.test.ts src/app/pages/dashboard-sidebar-navigation-layout.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/dashboard.tsx packages/app/src/app/app.tsx packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/app/extensions-screen-simplification.test.ts packages/app/src/app/pages/dashboard-menu-navigation.test.ts packages/app/src/app/pages/dashboard-sidebar-navigation-layout.test.ts
git commit -m "feat(app): remove plugin-facing extensions copy"
```

### Task 3: Add App-Side MCP Hub Client And Store Wiring

**Files:**
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/lib/veslo-server.test.ts`
- Modify: `packages/app/src/app/context/extensions.ts`
- Modify: `packages/app/src/app/pages/mcp.tsx`
- Modify: `packages/app/src/app/types.ts`
- Create: `packages/app/src/app/mcp-hub-contract.test.ts`
- Test: `packages/app/src/app/lib/veslo-server.test.ts`
- Test: `packages/app/src/app/mcp-hub-contract.test.ts`

**Step 1: Write the failing tests**

Add a client test mirroring `listHubSkills`:

```ts
test("listHubMcp forwards den auth context headers when provided", async () => {
  await client.listHubMcp({
    denToken: "den-token",
    denOrgId: "org_123",
  });
  assert.equal(calls[0]?.url, "https://veslo.example/hub/mcp");
  assert.equal(calls[0]?.headers.get("x-veslo-den-token"), "den-token");
  assert.equal(calls[0]?.headers.get("x-veslo-den-org-id"), "org_123");
});
```

Create `mcp-hub-contract.test.ts` as a source-contract test for store wiring:

```ts
const source = readFileSync(new URL("./context/extensions.ts", import.meta.url), "utf8");

test("extensions store reads den auth before listing hub mcp", () => {
  assert.match(source, /readDenAuth\(\)/);
  assert.match(source, /listHubMcp/);
  assert.match(source, /installHubMcp/);
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/veslo-server.test.ts src/app/mcp-hub-contract.test.ts
```

Expected: FAIL because `listHubMcp` and `installHubMcp` do not exist yet.

**Step 3: Write the minimal implementation**

In `veslo-server.ts`:

- add `VesloHubMcpItem` type
- add `listHubMcp(options?: { denToken?: string; denOrgId?: string })`
- add `installHubMcp(workspaceId, name, options?: { denToken?: string; denOrgId?: string })`

In `context/extensions.ts`:

- add hub MCP state beside existing hub Skills state
- read `readDenAuth()` before fetch/install
- require Veslo server for hub MCP actions

In `pages/mcp.tsx`:

- accept hub MCP props
- render org-catalog items in the existing available-apps area after `Control Chrome`

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/veslo-server.test.ts src/app/mcp-hub-contract.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/veslo-server.ts packages/app/src/app/lib/veslo-server.test.ts packages/app/src/app/context/extensions.ts packages/app/src/app/pages/mcp.tsx packages/app/src/app/types.ts packages/app/src/app/mcp-hub-contract.test.ts
git commit -m "feat(app): add org-scoped MCP hub client flow"
```

### Task 4: Add Veslo Server MCP Catalog Fetch And Install Routes

**Files:**
- Modify: `packages/server/src/den-catalog.ts`
- Modify: `packages/server/src/den-catalog.test.ts`
- Modify: `packages/server/src/mcp.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/types.ts`
- Create: `packages/server/src/server.hub-mcp.test.ts`
- Test: `packages/server/src/den-catalog.test.ts`
- Test: `packages/server/src/server.hub-mcp.test.ts`

**Step 1: Write the failing tests**

Extend `den-catalog.test.ts` with MCP-specific fetch coverage:

```ts
test("fetchOrgMcpCatalog sends bearer token header", async () => {
  await fetchOrgMcpCatalog({
    baseUrl: "https://den.example",
    orgId: "org_123",
    denToken: "token_abc",
  });
  expect(calls[0]?.url).toBe("https://den.example/v1/orgs/org_123/mcp/catalog");
});
```

Create `server.hub-mcp.test.ts` mirroring `server.hub-skills.test.ts`:

```ts
test("GET /hub/mcp returns 401 when den token header is missing", async () => { ... });

test("GET /hub/mcp returns items from den org catalog", async () => {
  expect(denCalls).toEqual([
    {
      pathname: "/v1/orgs/org_1/mcp/catalog",
      authHeader: "Bearer den-token",
    },
  ]);
});

test("POST /workspace/:id/mcp/hub/:name installs catalog MCP config", async () => {
  // assert opencode.json[c] contains the mapped MCP item after the route call
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter veslo-server exec bun test src/den-catalog.test.ts src/server.hub-mcp.test.ts
```

Expected: FAIL because MCP hub fetch/install helpers and routes do not exist.

**Step 3: Write the minimal implementation**

In `den-catalog.ts`:

- add `fetchOrgMcpCatalog(...)` beside `fetchOrgSkillsCatalog(...)`
- validate MCP payload shape strictly

In `types.ts`:

- add MCP hub capability shape parallel to `hub.skills`
- add `HubMcpItem` type

In `mcp.ts`:

- add helper that writes a hub-sourced MCP config into workspace config without overwriting unrelated entries

In `server.ts`:

- add `GET /hub/mcp`
- add `POST /workspace/:id/mcp/hub/:name`
- require Den headers on both routes
- resolve catalog item by stable name/id and then write MCP config + emit reload event

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter veslo-server exec bun test src/den-catalog.test.ts src/server.hub-mcp.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/den-catalog.ts packages/server/src/den-catalog.test.ts packages/server/src/mcp.ts packages/server/src/server.ts packages/server/src/types.ts packages/server/src/server.hub-mcp.test.ts
git commit -m "feat(server): add org-scoped MCP hub routes"
```

### Task 5: Add Den Org-Scoped MCP Catalog Endpoint

**Files:**
- Create: `services/den/src/http/org-mcp-catalog.ts`
- Create: `services/den/test/org-mcp-catalog.test.ts`
- Modify: `services/den/src/index.ts`
- Test: `services/den/test/org-mcp-catalog.test.ts`

**Step 1: Write the failing tests**

Create `org-mcp-catalog.test.ts` by cloning the structure of `org-skills-catalog.test.ts` and changing the path:

```ts
test("org mcp catalog requires an authenticated session", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/orgs/org_1/mcp/catalog`);
  assert.equal(response.status, 401);
});

test("org mcp catalog returns an empty list for allowed org access", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/orgs/org_1/mcp/catalog`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [] });
});

test("den index mounts org mcp catalog router under /v1/orgs", () => {
  assert.match(source, /app\.use\("\/v1\/orgs",\s*orgMcpCatalogRouter\)/);
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/org-mcp-catalog.test.ts
```

Expected: FAIL because the MCP catalog router does not exist or is not mounted.

**Step 3: Write the minimal implementation**

Implement `createOrgMcpCatalogRouter(...)` in `org-mcp-catalog.ts` using the same authorization pattern as `org-skills-catalog.ts`:

```ts
router.get("/:orgId/mcp/catalog", asyncRoute(async (req, res) => {
  const context = await authorize(req, res, {
    orgId: req.params.orgId,
    minimumRole: "member",
  });
  if (!context) return;
  res.json({ items: [] });
}));
```

Then mount `orgMcpCatalogRouter` from `src/index.ts`.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/org-mcp-catalog.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/http/org-mcp-catalog.ts services/den/test/org-mcp-catalog.test.ts services/den/src/index.ts
git commit -m "feat(den): add org-scoped MCP catalog endpoint"
```

### Task 6: Expand Local Workspace Chrome Auto-Seed Beyond Starter Preset

**Files:**
- Modify: `packages/desktop/src-tauri/src/workspace/files.rs`
- Test: `packages/desktop/src-tauri/src/workspace/files.rs`

**Step 1: Write the failing Rust tests**

Extend `workspace/files.rs` tests with tempdir-backed config seeding coverage:

```rust
#[test]
fn ensure_workspace_files_adds_chrome_devtools_when_missing_for_minimal_preset() {
    // create temp workspace with preset "minimal"
    // call ensure_workspace_files(...)
    // assert opencode.jsonc contains mcp.chrome-devtools.command
}

#[test]
fn ensure_workspace_files_does_not_duplicate_existing_control_chrome_alias() {
    // pre-write opencode.jsonc with control-chrome
    // call ensure_workspace_files(...)
    // assert only one chrome alias exists after write
}
```

**Step 2: Run tests to verify they fail**

Run:

```bash
cd packages/desktop/src-tauri
cargo test ensure_workspace_files_adds_chrome_devtools_when_missing_for_minimal_preset
```

Expected: FAIL because Chrome seeding is still limited to `starter`.

**Step 3: Write the minimal implementation**

In `ensure_workspace_files(...)`:

- remove the `matches!(preset, "starter")` gate
- seed Chrome for every local workspace preset
- preserve the alias guard (`chrome-devtools` or `control-chrome`)
- keep write behavior non-destructive

**Step 4: Run tests to verify they pass**

Run:

```bash
cd packages/desktop/src-tauri
cargo test ensure_workspace_files_adds_chrome_devtools_when_missing_for_minimal_preset
cargo test ensure_workspace_files_does_not_duplicate_existing_control_chrome_alias
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/desktop/src-tauri/src/workspace/files.rs
git commit -m "feat(desktop): seed control chrome for local workspaces"
```

### Task 7: Add App Runtime Guard For Catalog Install And Existing MCP Refresh

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/context/extensions.ts`
- Create: `packages/app/src/app/mcp-runtime-install-contract.test.ts`
- Test: `packages/app/src/app/mcp-runtime-install-contract.test.ts`

**Step 1: Write the failing test**

Create a source-contract test that locks the runtime install path:

```ts
const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("catalog MCP install refreshes MCP state after workspace config write", () => {
  assert.match(source, /await refreshMcpServers\(\)/);
  assert.match(source, /activeClient\.mcp\.add/);
});
```

Add store assertions for install:

```ts
assert.match(storeSource, /readDenAuth\(\)/);
assert.match(storeSource, /installHubMcp/);
```

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/mcp-runtime-install-contract.test.ts
```

Expected: FAIL because catalog install flow is not wired into runtime activation.

**Step 3: Write the minimal implementation**

In app runtime/store:

- reuse the existing MCP add/connect flow after catalog install
- refresh configured MCP entries immediately after install
- continue into auth flow for OAuth-backed catalog entries
- keep manual add behavior untouched

Do not add remote-only special cases in this task unless a failing test proves an existing regression. The goal here is to preserve the current local desktop runtime path.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/mcp-runtime-install-contract.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/context/extensions.ts packages/app/src/app/mcp-runtime-install-contract.test.ts
git commit -m "feat(app): wire MCP hub install into runtime activation"
```

### Task 8: Add Desktop E2E Coverage And Run Full Verification

**Files:**
- Create: `packages/e2e/specs/extensions-mcp.spec.ts`
- Modify: `packages/e2e/specs/navigation.spec.ts` (only if existing helpers must expose the Extensions page)
- Test: `packages/e2e/specs/extensions-mcp.spec.ts`

**Step 1: Write the failing E2E spec**

Create a spec that verifies the actual Tauri UI:

```ts
it("shows only Control Chrome on the Extensions screen and keeps Add MCP server", async () => {
  await openExtensionsScreen();
  await expect($("body")).toHaveText(expect.stringContaining("Control Chrome"));
  await expect($("body")).not.toHaveText(expect.stringContaining("Notion"));
  await expect($("body")).not.toHaveText(expect.stringContaining("Linear"));
  await expect($("body")).not.toHaveText(expect.stringContaining("Advanced settings"));
  await expect($("body")).not.toHaveText(expect.stringContaining("Technical details"));
  await expect($("body")).toHaveText(expect.stringContaining("Add MCP Server"));
});
```

**Step 2: Run the spec to verify it fails**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
cd ../e2e
pnpm test --spec ./specs/extensions-mcp.spec.ts
```

Expected: FAIL because the current screen still renders removed entries/controls.

**Step 3: Finish any minimal glue needed for the spec**

If the spec needs shared helpers:

- add or reuse navigation helpers in `packages/e2e/specs/navigation.spec.ts` or `packages/e2e/helpers/app-launcher.ts`
- keep the spec focused on the visible user contract only

**Step 4: Run full verification**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/**/*.test.ts src/app/**/**/*.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
pnpm --filter veslo-server exec bun test
pnpm --filter @neatech/den exec tsx --test test/**/*.test.ts
cd packages/desktop/src-tauri && cargo test && cd ../../..
cd packages/desktop && pnpm tauri build --debug --no-bundle -- --features e2e && cd ../e2e && pnpm test --spec ./specs/extensions-mcp.spec.ts
```

Expected:

- app tests PASS
- i18n parity PASS
- server tests PASS
- Den tests PASS
- Rust tests PASS
- Tauri E2E spec PASS

Then start the dev stack and capture final evidence per `AGENTS.md`:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
packaging/docker/dev-up.sh
```

Capture screenshots of the Extensions screen and include the file paths in the final implementation summary/PR notes.

**Step 5: Commit**

```bash
git add packages/e2e/specs/extensions-mcp.spec.ts packages/e2e/specs/navigation.spec.ts
git commit -m "test(e2e): cover simplified MCP extensions screen"
```
