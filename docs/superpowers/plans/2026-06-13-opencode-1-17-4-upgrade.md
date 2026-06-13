# OpenCode 1.17.4 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Veslo from OpenCode `1.14.29` to OpenCode `1.17.4` while preserving the current Veslo workspace/session contract, then add a narrow adapter layer for evaluating the new OpenCode workspace APIs.

**Architecture:** Use a compatibility-first migration. Veslo keeps its current workspace model, server conversation API, browse-first session loading, orchestrator engine pool, and WSL path mapping as the source of truth while the OpenCode binary, SDK, plugin, and OpenTUI dependencies move to `1.17.4`-compatible versions. New OpenCode workspace features are introduced only behind a small probe/adapter surface after the existing runtime contract passes against the real sidecar.

**Tech Stack:** pnpm `10.27.0`, TypeScript, Bun, Tauri 2, SolidJS, OpenCode `1.17.4`, `@opencode-ai/sdk` `1.17.4`, `@opencode-ai/plugin` `1.17.4`, OpenTUI `0.4.1`, WebdriverIO desktop E2E.

---

## Implementation Notes From 2026-06-13

Completed in the first implementation pass:

- `VESLO_DISABLE_SANDBOX=1` now goes through a shared sandbox-mode resolver and emits a large red terminal warning before OpenCode starts unsandboxed.
- The env kill switch bypasses platform sandbox backend resolution entirely, including the Windows WSL2 branch.
- OpenCode runtime/package pins were bumped to `1.17.4`; OpenTUI was bumped to `0.4.1`; orchestrator `solid-js` was bumped to `1.9.12` to satisfy OpenTUI peer dependencies.
- Managed plugin version constants, Rust provisioning fixtures, WSL provisioning fallback version, and sidecar metadata expectations were updated to `1.17.4`.
- App smoke scripts now prefer the repo-bundled `veslo-code` sidecar before falling back to a global `opencode`, so session/todo smoke tests no longer depend on a local PATH install.
- Orchestrator smoke scripts now run the compiled CLI with Bun because the orchestrator runtime uses `bun:sqlite`.

Verified locally on 2026-06-13:

- `pnpm --filter veslo-orchestrator typecheck`
- `pnpm --filter veslo-code-router typecheck`
- `pnpm --filter veslo-server typecheck`
- `pnpm --filter @neatech/veslo-ui typecheck`
- `pnpm --filter veslo-orchestrator exec bun test src/tests/sandbox-mode.test.ts src/tests/opencode-managed-dependencies.test.ts src/tests/version-manifest.test.ts src/tests/sandbox/windows-wsl2/index.test.ts`
- `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/utils/providers.test.ts src/app/tests/lib/attachment-prompt-routing.test.ts`
- `pnpm --filter @neatech/veslo prepare:sidecar`
- `packages\desktop\src-tauri\sidecars\veslo-code.exe --version` returned `1.17.4`
- `pnpm test:orchestrator`
- `pnpm --filter veslo-orchestrator test:files`
- `pnpm --filter @neatech/veslo-ui build`
- `pnpm --filter @neatech/veslo-ui test:todos`
- `pnpm --filter @neatech/veslo-ui test:sessions`

Not completed in this pass:

- Full Tauri desktop E2E (`packages/e2e`) and the optional diagnostic OpenCode workspace API adapter.

---

## Scope And Constraints

This plan targets the nested repo root:

```powershell
cd C:\Users\jajse\Desktop\Shoptet_upravy\neatech\veslo\veslo
```

Upgrade scope:

- Update the bundled OpenCode sidecar version from `1.14.29` to `1.17.4`.
- Update OpenCode SDK and plugin dependencies to `1.17.4`.
- Update OpenTUI dependencies required by `@opencode-ai/plugin@1.17.4`.
- Keep the existing Veslo server conversation API and orchestrator proxy behavior working.
- Add a real-runtime OpenCode contract smoke so future OpenCode bumps fail early.
- Document the preserved Veslo/OpenCode runtime contract.
- Add a first adapter/probe for OpenCode's `workspace` API without making it the product source of truth.

Out of scope for this first migration:

- Replacing Veslo workspace IDs with OpenCode workspace IDs.
- Replacing browse-first SQLite reads with eager OpenCode engine calls.
- Redesigning the workspace UI.
- Combining this with the existing workspace state-machine refactor plan.
- Using `packages/web`, raw Vite, or `pnpm -w dev:ui` as runtime proof.

The first PR should be a compatibility upgrade. Product use of new OpenCode workspace features should be a follow-up once runtime parity is proven.

---

## Current Integration Surface

Version and dependency pins:

- Modify: `packages/desktop/package.json`
  - Owns `opencodeVersion`.
- Modify: `packages/orchestrator/package.json`
  - Owns `opencodeVersion`, `@opencode-ai/plugin`, `@opencode-ai/sdk`, and OpenTUI versions.
- Modify: `packages/app/package.json`
  - Uses `@opencode-ai/sdk`.
- Modify: `packages/opencode-router/package.json`
  - Uses `@opencode-ai/sdk`.
- Modify: `pnpm-lock.yaml`
  - Must resolve OpenCode SDK/plugin to `1.17.4`.
- Modify: `packages/desktop/src-tauri/src/orchestrator/mod.rs`
  - Contains static managed-dependency version expectations and fixtures that currently mention `1.14.29`.

Runtime and contract surfaces:

- Inspect first; edit only when a named compile/runtime gate fails here: `packages/orchestrator/src/cli.ts`
  - Starts OpenCode with `serve`, injects auth, sets `OPENCODE_CONFIG_DIR`, and creates SDK clients.
- Inspect first; edit only when a named compile/runtime gate fails here: `packages/orchestrator/src/router-proxy.ts`
  - Proxies `/workspace/:id/opencode/*` and injects `x-opencode-directory`.
- Inspect first; edit only when a named compile/runtime gate fails here: `packages/orchestrator/src/engine-pool.ts`
  - Performs `/global/health` startup checks and engine lifecycle management.
- Inspect first; edit only when a named compile/runtime gate fails here: `packages/orchestrator/src/run-activity-probe.ts`
  - Uses `/session/status` and `/session/:id/message`.
- Inspect first; edit only when a named compile/runtime gate fails here: `packages/server/src/server.ts`
  - Uses `/session`, `/session/:id/prompt_async`, `/session/:id/abort`, `/session/:id/message`, and proxy helper calls.
- Inspect first; edit only when a named compile/runtime gate fails here: `packages/server/src/conversation-read-store.ts`
  - Reads OpenCode SQLite session/message/part tables directly.
- Inspect first; edit only when a named compile/runtime gate fails here: `packages/server/src/conversation-binding-store.ts`
  - Maps Veslo conversation IDs to OpenCode session IDs.
- Inspect first; edit only when a named compile/runtime gate fails here: `packages/app/src/app/lib/opencode.ts`
  - Creates SDK clients through `@opencode-ai/sdk/v2/client`.
- Inspect first; edit only when a named compile/runtime gate fails here: `packages/app/src/app/app.tsx`
  - Contains send/session calls that may expose SDK typing changes.
- Inspect first; edit only when a named compile/runtime gate fails here: `packages/opencode-router/src/opencode.ts`
  - Creates direct SDK clients for the router bridge.
- Inspect first; edit only when a named compile/runtime gate fails here: `packages/opencode-router/src/bridge.ts`
  - Uses session create/prompt APIs.

New verification and docs:

- Create: `packages/orchestrator/scripts/opencode-contract-smoke.mjs`
  - Starts the bundled `veslo-code` sidecar and checks the endpoints Veslo depends on.
- Modify: `packages/orchestrator/package.json`
  - Add `test:opencode-contract`.
- Create: `docs/dev/opencode-runtime-contract.md`
  - Documents the Veslo/OpenCode compatibility contract and the reason OpenCode workspace adoption is staged.

---

## Verification Gates

Run these gates from the nested repo root.

Fast static gates:

```powershell
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-code-router typecheck
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
```

Focused runtime contract gates:

```powershell
pnpm --filter @neatech/veslo prepare:sidecar
pnpm --filter veslo-orchestrator test:opencode-contract
pnpm test:orchestrator
pnpm --filter veslo-server test
pnpm --filter @neatech/veslo-ui test:sessions
pnpm --filter @neatech/veslo-ui test:session-switch
pnpm --filter @neatech/veslo-ui test:fs-engine
```

Desktop gate:

```powershell
cd packages\desktop
pnpm tauri build --debug --no-bundle --config src-tauri\tauri.dev.conf.json -- --features e2e

cd ..\e2e
pnpm test --spec .\specs\session.spec.ts
pnpm test --spec .\specs\browse-no-engine-spawn.spec.ts
pnpm test --spec .\specs\multi-workspace-restart.spec.ts
```

These existing specs cover session runtime, browse-first no-engine-spawn behavior, and multi-workspace switching.

Broad sanity gate after all targeted gates pass:

```powershell
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

---

### Task 1: Baseline And Dependency Bump

**Files:**

- Modify: `packages/desktop/package.json`
- Modify: `packages/orchestrator/package.json`
- Modify: `packages/app/package.json`
- Modify: `packages/opencode-router/package.json`
- Modify: `packages/desktop/src-tauri/src/orchestrator/mod.rs`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Record the pre-upgrade tree state**

Run:

```powershell
git status --short --untracked-files=normal
```

Expected: existing unrelated files may appear. Do not modify or remove unrelated untracked files.

- [ ] **Step 2: Record baseline package checks**

Run:

```powershell
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-code-router typecheck
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS before the migration. If a baseline command fails, capture the failing command and error in the implementation notes before changing dependencies.

- [ ] **Step 3: Update OpenCode and SDK pins**

Apply these package changes:

```json
// packages/desktop/package.json
"opencodeVersion": "1.17.4"
```

```json
// packages/orchestrator/package.json
"opencodeVersion": "1.17.4"
```

```json
// packages/orchestrator/package.json dependencies
"@opencode-ai/plugin": "1.17.4",
"@opencode-ai/sdk": "1.17.4",
"@opentui/core": "0.4.1",
"@opentui/keymap": "0.4.1",
"@opentui/solid": "0.4.1",
"solid-js": "1.9.12"
```

```json
// packages/orchestrator/package.json devDependencies
"@opentui/core-darwin-arm64": "0.4.1",
"@opentui/core-darwin-x64": "0.4.1",
"@opentui/core-linux-arm64": "0.4.1",
"@opentui/core-linux-x64": "0.4.1",
"@opentui/core-win32-x64": "0.4.1"
```

```json
// packages/app/package.json dependencies
"@opencode-ai/sdk": "1.17.4"
```

```json
// packages/opencode-router/package.json dependencies
"@opencode-ai/sdk": "1.17.4"
```

Keep `zod` pinned to `4.1.8`; `@opencode-ai/plugin@1.17.4` uses that version and the sidecar managed-dependency manifest already vendors `zod`.

- [ ] **Step 4: Update static managed-dependency fixtures**

In `packages/desktop/src-tauri/src/orchestrator/mod.rs`, replace managed dependency fixture references to `@opencode-ai/plugin` version `1.14.29` with `1.17.4`.

The expected fixture package JSON version becomes:

```json
{"name":"@opencode-ai/plugin","version":"1.17.4","type":"module","exports":{".":{"import":"./dist/index.js"},"./tool":{"import":"./dist/tool.js"}}}
```

- [ ] **Step 5: Refresh lockfile**

Run:

```powershell
pnpm install
```

Expected: `pnpm-lock.yaml` resolves `opencode-ai`, `@opencode-ai/sdk`, and `@opencode-ai/plugin` to `1.17.4`; OpenTUI resolves to `0.4.1`.

- [ ] **Step 6: Verify dependency resolution**

Run:

```powershell
pnpm list @opencode-ai/sdk @opencode-ai/plugin @opentui/core @opentui/solid @opentui/keymap --depth 0 -r
```

Expected: app, orchestrator, and router report SDK `1.17.4`; orchestrator reports plugin `1.17.4`; orchestrator reports OpenTUI `0.4.1`.

- [ ] **Step 7: Commit**

```powershell
git add packages/desktop/package.json packages/orchestrator/package.json packages/app/package.json packages/opencode-router/package.json packages/desktop/src-tauri/src/orchestrator/mod.rs pnpm-lock.yaml
git commit -m "chore: bump OpenCode runtime to 1.17.4"
```

---

### Task 2: Fix Compile-Time Compatibility

**Files:**

- Modify: `packages/orchestrator/src/cli.ts`
- Modify: `packages/orchestrator/src/tui/app.tsx`
- Modify: `packages/orchestrator/src/tui/opentui-jsx.d.ts`
- Modify: `packages/orchestrator/src/opencode-managed-dependencies.ts`
- Modify: `packages/app/src/app/lib/opencode.ts`
- Modify: `packages/app/src/app/types.ts`
- Modify: `packages/app/src/app/utils/messages.ts`
- Modify: `packages/app/src/app/utils/tools.ts`
- Modify: `packages/app/src/app/utils/providers.ts`
- Modify: `packages/opencode-router/src/opencode.ts`
- Modify: `packages/opencode-router/src/bridge.ts`

- [ ] **Step 1: Run compile checks after the bump**

Run:

```powershell
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-code-router typecheck
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: failures are likely in orchestrator OpenTUI/plugin typing or SDK-generated type names.

- [ ] **Step 2: Keep SDK imports on the existing v2 path**

Do not rewrite every SDK import to a different public path while the current path still compiles:

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
```

If `Session`, `Part`, `Provider`, or response aliases changed names, centralize local type aliases in `packages/app/src/app/types.ts` or the local wrapper using the generated `@opencode-ai/sdk/v2/client` exports. Avoid leaking version-specific SDK types through new public Veslo types.

- [ ] **Step 3: Repair OpenTUI 0.4 compatibility in orchestrator only**

Keep OpenTUI-specific fixes contained to:

```text
packages/orchestrator/src/tui/app.tsx
packages/orchestrator/src/tui/opentui-jsx.d.ts
```

The orchestrator package should compile with:

```powershell
pnpm --filter veslo-orchestrator typecheck
```

Expected: PASS.

- [ ] **Step 4: Repair router SDK compatibility**

Keep router SDK changes contained to:

```text
packages/opencode-router/src/opencode.ts
packages/opencode-router/src/bridge.ts
```

The router package should compile with:

```powershell
pnpm --filter veslo-code-router typecheck
```

Expected: PASS.

- [ ] **Step 5: Repair app SDK type compatibility**

Keep app SDK changes contained to local wrappers/types first:

```text
packages/app/src/app/lib/opencode.ts
packages/app/src/app/types.ts
packages/app/src/app/utils/messages.ts
packages/app/src/app/utils/tools.ts
packages/app/src/app/utils/providers.ts
```

The app should compile with:

```powershell
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

- [ ] **Step 6: Run all static gates**

Run:

```powershell
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-code-router typecheck
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/orchestrator/src packages/opencode-router/src packages/app/src
git commit -m "fix: adapt Veslo to OpenCode 1.17 SDK and TUI types"
```

---

### Task 3: Sidecar And Managed Plugin Verification

**Files:**

- Modify: `packages/desktop/scripts/prepare-sidecar.mjs`
- Modify: `packages/orchestrator/src/opencode-managed-dependencies.ts`
- Modify: `packages/orchestrator/src/tests/opencode-managed-dependencies.test.ts`
- Modify: `packages/orchestrator/src/tests/opencode-version.test.ts`
- Modify: `packages/desktop/src-tauri/src/orchestrator/mod.rs`

- [ ] **Step 1: Run sidecar preparation**

Run:

```powershell
$env:VESLO_SIDECAR_FORCE_BUILD='1'
pnpm --filter @neatech/veslo prepare:sidecar
Remove-Item Env:\VESLO_SIDECAR_FORCE_BUILD
```

Expected: sidecar preparation downloads OpenCode `1.17.4`, builds Veslo sidecars, writes `opencode-managed-deps.json`, and writes `versions.json`.

- [ ] **Step 2: Verify sidecar version metadata**

Run:

```powershell
$versions = Get-Content packages\desktop\src-tauri\sidecars\versions.json | ConvertFrom-Json
if ($versions.'veslo-code'.version -ne '1.17.4') { throw "veslo-code version mismatch: $($versions.'veslo-code'.version)" }
if ($versions.'opencode-managed-deps'.version -ne '1.17.4') { throw "managed deps version mismatch: $($versions.'opencode-managed-deps'.version)" }
```

Expected: no exception.

- [ ] **Step 3: Verify the bundled binary reports 1.17.4**

Run:

```powershell
packages\desktop\src-tauri\sidecars\veslo-code.exe --version
```

Expected: output is `1.17.4`.

- [ ] **Step 4: Verify managed plugin manifest content**

Run:

```powershell
$manifest = Get-Content packages\desktop\src-tauri\sidecars\opencode-managed-deps.json | ConvertFrom-Json
$plugin = $manifest.packages | Where-Object { $_.name -eq '@opencode-ai/plugin' }
if ($plugin.version -ne '1.17.4') { throw "plugin version mismatch: $($plugin.version)" }
```

Expected: no exception.

- [ ] **Step 5: Update tests that assert managed dependency versions**

Update tests under:

```text
packages/orchestrator/src/tests/opencode-managed-dependencies.test.ts
packages/orchestrator/src/tests/opencode-version.test.ts
```

Expected literals:

```typescript
const expectedOpencodeVersion = "1.17.4";
const expectedPluginVersion = "1.17.4";
```

- [ ] **Step 6: Run managed-dependency tests**

Run:

```powershell
pnpm --filter veslo-orchestrator build
pnpm --filter veslo-orchestrator exec node --test --import=tsx/esm src/tests/opencode-managed-dependencies.test.ts src/tests/opencode-version.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/orchestrator/src/opencode-managed-dependencies.ts packages/orchestrator/src/tests packages/desktop/src-tauri/src/orchestrator/mod.rs
git commit -m "test: verify OpenCode 1.17 managed sidecar dependencies"
```

---

### Task 4: Add Real OpenCode Contract Smoke

**Files:**

- Create: `packages/orchestrator/scripts/opencode-contract-smoke.mjs`
- Modify: `packages/orchestrator/package.json`
- Modify: `docs/dev/opencode-runtime-contract.md`

- [ ] **Step 1: Create the smoke script**

Create `packages/orchestrator/scripts/opencode-contract-smoke.mjs` with these responsibilities:

```javascript
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";

const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
const sidecar = resolve(repoRoot, "packages/desktop/src-tauri/sidecars/veslo-code.exe");
const username = "veslo-contract";
const password = "veslo-contract-token";
const auth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 60_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/global/health`, {
        headers: { Authorization: auth },
      });
      if (response.ok) return await response.json();
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`OpenCode health did not become ready: ${lastError}`);
}

async function expectRoute(method, url, init = {}) {
  const response = await fetch(url, {
    ...init,
    method,
    headers: {
      Authorization: auth,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (response.status === 404 || response.status === 405) {
    throw new Error(`${method} ${url} returned ${response.status}`);
  }
  return response;
}

async function main() {
  const port = await freePort();
  const workspace = await mkdtemp(join(tmpdir(), "veslo-opencode-117-"));
  const configDir = await mkdtemp(join(tmpdir(), "veslo-opencode-config-"));
  await writeFile(join(workspace, "README.md"), "# contract smoke\n", "utf8");

  const child = spawn(sidecar, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--cors"], {
    cwd: workspace,
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CLIENT: "veslo-contract-smoke",
      VESLO: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForHealth(baseUrl);
    if (health.version && health.version !== "1.17.4") {
      throw new Error(`expected OpenCode 1.17.4, got ${health.version}`);
    }

    const created = await expectRoute("POST", `${baseUrl}/session`, {
      body: JSON.stringify({ directory: workspace, title: "Veslo OpenCode 1.17 contract" }),
    });
    const session = await created.json();
    if (!session.id) throw new Error("session.create did not return an id");

    await expectRoute("GET", `${baseUrl}/session/${encodeURIComponent(session.id)}`, {
      headers: { "x-opencode-directory": workspace },
    });
    await expectRoute("GET", `${baseUrl}/session/${encodeURIComponent(session.id)}/message?limit=20`, {
      headers: { "x-opencode-directory": workspace },
    });
    await expectRoute("GET", `${baseUrl}/session/status`, {
      headers: { "x-opencode-directory": workspace },
    });

    const shell = await expectRoute("POST", `${baseUrl}/session/${encodeURIComponent(session.id)}/shell?directory=${encodeURIComponent(workspace)}`, {
      body: JSON.stringify({ command: "pwd" }),
    });
    if (shell.status >= 500) throw new Error(`shell endpoint failed with ${shell.status}: ${await shell.text()}`);

    const promptRoute = await expectRoute("POST", `${baseUrl}/session/${encodeURIComponent(session.id)}/prompt_async?directory=${encodeURIComponent(workspace)}`, {
      body: JSON.stringify({ parts: [{ type: "text", text: "Say contract smoke." }] }),
    });
    if (promptRoute.status === 404 || promptRoute.status === 405) {
      throw new Error("prompt_async route is not available");
    }

    const event = await expectRoute("GET", `${baseUrl}/event`, {
      headers: { accept: "text/event-stream", "x-opencode-directory": workspace },
    });
    const contentType = event.headers.get("content-type") ?? "";
    if (!/^text\/event-stream\b/i.test(contentType)) {
      throw new Error(`event endpoint did not return event stream content type: ${contentType}`);
    }

    console.log("OpenCode 1.17.4 contract smoke passed");
  } finally {
    child.kill("SIGTERM");
    await rm(workspace, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 2000).unref();
    if (process.exitCode && stderr) console.error(stderr);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Add package script**

In `packages/orchestrator/package.json`, add:

```json
"test:opencode-contract": "node scripts/opencode-contract-smoke.mjs"
```

- [ ] **Step 3: Run the contract smoke**

Run:

```powershell
pnpm --filter @neatech/veslo prepare:sidecar
pnpm --filter veslo-orchestrator test:opencode-contract
```

Expected: PASS and output includes `OpenCode 1.17.4 contract smoke passed`.

- [ ] **Step 4: Document the contract**

Create `docs/dev/opencode-runtime-contract.md` with these sections:

```markdown
# OpenCode Runtime Contract

Veslo currently treats Veslo workspace IDs, Veslo server conversation IDs, and
OpenCode engine session IDs as separate identifiers.

OpenCode 1.17.4 must preserve these runtime surfaces for Veslo:

- `GET /global/health`
- `POST /session`
- `GET /session/:id`
- `GET /session/:id/message`
- `GET /session/status`
- `POST /session/:id/prompt_async`
- `POST /session/:id/abort`
- `POST /session/:id/shell`
- `GET /event`
- `x-opencode-directory` request scoping

Veslo keeps browse-first local session loading through the server read store.
OpenCode workspace APIs can be probed and adopted behind Veslo adapters, but
they do not replace Veslo workspace identity in this migration.
```

- [ ] **Step 5: Commit**

```powershell
git add packages/orchestrator/scripts/opencode-contract-smoke.mjs packages/orchestrator/package.json docs/dev/opencode-runtime-contract.md
git commit -m "test: add OpenCode runtime contract smoke"
```

---

### Task 5: Preserve Server Conversation And SQLite Read Contracts

**Files:**

- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/conversation-read-store.ts`
- Modify: `packages/server/src/conversation-binding-store.ts`
- Modify: `packages/server/src/conversation-service.ts`
- Modify: `packages/server/src/tests/server-conversations.test.ts`
- Modify: `packages/server/src/tests/conversation-read-store.test.ts`
- Modify: `packages/server/src/tests/conversation-binding-store.test.ts`
- Modify: `packages/server/src/tests/server.opencode-proxy-timeout.test.ts`

- [ ] **Step 1: Run current server tests**

Run:

```powershell
pnpm --filter veslo-server test
```

Expected: PASS after dependency compatibility work. Failures here are server contract regressions, not UI regressions.

- [ ] **Step 2: Strengthen proxy request assertions**

In `packages/server/src/tests/server.opencode-proxy-timeout.test.ts`, assert that proxied OpenCode JSON/helper requests still:

```typescript
assert.equal(captured.headers["x-opencode-directory"], workspacePath);
assert.equal(captured.headers.authorization, expectedBasicAuth);
assert.equal(captured.headers["accept-encoding"], "identity");
```

Expected: tests prove server helpers still inject directory scope and OpenCode auth rather than trusting client headers.

- [ ] **Step 3: Strengthen run endpoint assertions**

In `packages/server/src/tests/server-conversations.test.ts`, keep the Veslo write API path stable:

```typescript
assert.equal(
  capturedOpenCodePath,
  `/session/${encodeURIComponent(engineSessionId)}/prompt_async?directory=${encodeURIComponent(workspacePath)}`,
);
```

Expected: `POST /workspace/:id/conversations/:conversationId/runs` still reaches OpenCode `prompt_async` through the existing compatibility contract.

- [ ] **Step 4: Verify SQLite read-store assumptions**

In `packages/server/src/tests/conversation-read-store.test.ts`, keep fixtures that exercise these tables and fields:

```sql
session(id, title, directory, parent_id, time_created, time_updated)
message(id, session_id, data)
part(id, message_id, session_id, data)
```

Expected: read-store tests prove browse-first history still works without engine startup.

- [ ] **Step 5: Run server gates and rebuild server binary**

Run:

```powershell
pnpm --filter veslo-server test
pnpm --filter veslo-server build:bin
```

Expected: PASS. The rebuilt binary is required before any orchestrator-backed runtime verification.

- [ ] **Step 6: Commit**

```powershell
git add packages/server/src
git commit -m "test: preserve Veslo server OpenCode compatibility contract"
```

---

### Task 6: Preserve App And Router Session Behavior

**Files:**

- Modify: `packages/app/src/app/lib/opencode.ts`
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/context/workspace-routing.ts`
- Modify: `packages/app/src/app/context/sidebar-workspace-sessions.ts`
- Modify: `packages/app/src/app/tests/lib/veslo-server.test.ts`
- Modify: `packages/app/src/app/tests/lib/veslo-server-session-prefetch.test.ts`
- Modify: `packages/app/src/app/tests/context/workspace-routing.test.ts`
- Modify: `packages/app/src/app/tests/context/session-transcript-hydration.test.ts`
- Modify: `packages/opencode-router/src/opencode.ts`
- Modify: `packages/opencode-router/src/bridge.ts`

- [ ] **Step 1: Run focused app session tests**

Run:

```powershell
pnpm --filter @neatech/veslo-ui test:sessions
pnpm --filter @neatech/veslo-ui test:session-switch
pnpm --filter @neatech/veslo-ui test:fs-engine
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts
```

Expected: PASS. Failures indicate SDK shape or Veslo server client contract drift.

- [ ] **Step 2: Preserve client creation contract**

Keep `packages/app/src/app/lib/opencode.ts` passing these inputs to the SDK client:

```typescript
return createOpencodeClient({
  baseUrl,
  directory,
  headers,
  fetch: wrappedFetch,
});
```

When testing the OpenCode workspace API later, pass `experimental_workspaceID` only through an adapter/probe and do not add it to all app clients by default.

- [ ] **Step 3: Preserve send path routing**

Keep app send behavior using the Veslo server run API for local server-backed flows:

```typescript
kind: "prompt_async"
```

Expected: the app should still cross the same hard boundary:

```text
POST /workspace/:id/conversations/:conversationId/runs
```

- [ ] **Step 4: Run router gates**

Run:

```powershell
pnpm --filter veslo-code-router typecheck
pnpm --filter veslo-code-router test:unit
pnpm --filter veslo-code-router test:smoke
```

Expected: PASS. Router bridge still creates sessions and prompts through the SDK.

- [ ] **Step 5: Run app broad unit checks**

Run:

```powershell
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/app/src packages/opencode-router/src
git commit -m "fix: preserve app and router session behavior on OpenCode 1.17"
```

---

### Task 7: Real Desktop Runtime Verification

**Files:**

- Modify: `packages/e2e/specs/session.spec.ts`
- Modify: `packages/e2e/specs/browse-no-engine-spawn.spec.ts`
- Modify: `packages/e2e/specs/multi-workspace-restart.spec.ts`
- Modify: `docs/dev/opencode-runtime-contract.md`

- [ ] **Step 1: Run desktop process preflight**

Run the Windows process check from `docs/dev/development-startup.md`:

```powershell
$pattern = 'pnpm|tauri-dev\.mjs|tauri(\.js)? dev|target\\debug\\veslo|vite[/\\]bin[/\\]vite\.js|veslo-orchestrator|veslo-server|veslo-code-router'

Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match $pattern } |
  Select-Object ProcessId,Name,CommandLine
```

Expected: no unrelated Veslo dev/test runtime is running. Stop only internally started dev/test processes from this repo.

- [ ] **Step 2: Build the E2E desktop runtime**

Run:

```powershell
cd packages\desktop
pnpm tauri build --debug --no-bundle --config src-tauri\tauri.dev.conf.json -- --features e2e
```

Expected: PASS.

- [ ] **Step 3: Run session runtime E2E**

Run:

```powershell
cd ..\e2e
pnpm test --spec .\specs\session.spec.ts
```

Expected: PASS. The test must cover opening a local workspace, browsing sessions without eager engine activation, sending one prompt through the Veslo server run API, and seeing an assistant response or a normalized provider/access failure in the transcript.

- [ ] **Step 4: Run browse-first and workspace switch E2E**

Run:

```powershell
cd packages\e2e
pnpm test --spec .\specs\browse-no-engine-spawn.spec.ts
pnpm test --spec .\specs\multi-workspace-restart.spec.ts
```

Expected: PASS. The specs must cover local browse without eager engine spawn and switching from workspace A to workspace B without losing scope for workspace A runs.

- [ ] **Step 5: Record evidence in docs**

Append a dated verification section to `docs/dev/opencode-runtime-contract.md`:

```markdown
## OpenCode 1.17.4 Verification

- Static type gates passed.
- Sidecar `veslo-code --version` returned `1.17.4`.
- `test:opencode-contract` passed against the real bundled sidecar.
- Veslo server tests passed and server binary was rebuilt.
- Desktop E2E session runtime passed against the real Tauri runtime.
- Desktop E2E workspace switch passed against the real Tauri runtime.
```

Only include bullets for commands that actually passed in this implementation.

- [ ] **Step 6: Commit**

```powershell
git add packages/e2e/specs docs/dev/opencode-runtime-contract.md
git commit -m "test: verify OpenCode 1.17 in desktop runtime"
```

---

### Task 8: Add OpenCode Workspace API Probe

**Files:**

- Create: `packages/orchestrator/src/opencode-workspace-api.ts`
- Create: `packages/orchestrator/src/tests/opencode-workspace-api.test.ts`
- Modify: `packages/orchestrator/src/cli.ts`
- Modify: `docs/dev/opencode-runtime-contract.md`

- [ ] **Step 1: Add a narrow workspace API module**

Create `packages/orchestrator/src/opencode-workspace-api.ts`:

```typescript
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

type OpenCodeClient = ReturnType<typeof createOpencodeClient>;

export type OpenCodeWorkspaceSummary = {
  id: string;
  name?: string;
  directory?: string;
  raw: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export async function listOpenCodeWorkspaces(
  client: OpenCodeClient,
): Promise<OpenCodeWorkspaceSummary[]> {
  const workspaceApi = (client as unknown as { workspace?: { list?: () => Promise<unknown> } }).workspace;
  if (!workspaceApi?.list) return [];

  const result = await workspaceApi.list();
  const items = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.data)
      ? result.data
      : [];

  return items.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = typeof item.id === "string" ? item.id : typeof item.workspaceID === "string" ? item.workspaceID : "";
    if (!id) return [];
    return [
      {
        id,
        name: typeof item.name === "string" ? item.name : undefined,
        directory: typeof item.directory === "string" ? item.directory : undefined,
        raw: item,
      },
    ];
  });
}
```

- [ ] **Step 2: Add unit tests for the adapter**

Create `packages/orchestrator/src/tests/opencode-workspace-api.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { listOpenCodeWorkspaces } from "../opencode-workspace-api";

test("returns empty list when SDK has no workspace API", async () => {
  const result = await listOpenCodeWorkspaces({} as never);
  assert.deepEqual(result, []);
});

test("normalizes array workspace responses", async () => {
  const result = await listOpenCodeWorkspaces({
    workspace: {
      list: async () => [
        { id: "ws-1", name: "One", directory: "C:/one" },
        { workspaceID: "ws-2", name: "Two", directory: "C:/two" },
        { name: "missing id" },
      ],
    },
  } as never);

  assert.deepEqual(result.map((workspace) => workspace.id), ["ws-1", "ws-2"]);
  assert.equal(result[0]?.directory, "C:/one");
});

test("normalizes data-wrapped workspace responses", async () => {
  const result = await listOpenCodeWorkspaces({
    workspace: {
      list: async () => ({
        data: [{ id: "ws-3", name: "Three" }],
      }),
    },
  } as never);

  assert.deepEqual(result.map((workspace) => workspace.id), ["ws-3"]);
});
```

- [ ] **Step 3: Run adapter test**

Run:

```powershell
pnpm --filter veslo-orchestrator exec node --test --import=tsx/esm src/tests/opencode-workspace-api.test.ts
```

Expected: PASS.

- [ ] **Step 4: Wire the probe as diagnostics only**

In `packages/orchestrator/src/cli.ts`, call `listOpenCodeWorkspaces(client)` only in an existing diagnostics/status route or debug command path. Do not use it for send routing, session listing, browse-first hydration, or workspace identity.

Expected runtime behavior:

```text
Veslo workspace ID remains the routing key.
OpenCode workspace ID is observed diagnostic metadata.
```

- [ ] **Step 5: Document the adoption rule**

Append to `docs/dev/opencode-runtime-contract.md`:

```markdown
## OpenCode Workspace API Adoption Rule

OpenCode workspace APIs are diagnostic/adaptive inputs until a separate product
migration explicitly changes Veslo workspace identity. Any OpenCode workspace
ID observed by the orchestrator must be stored as metadata and must not replace
Veslo `workspaceId`, server conversation IDs, or binding-store keys.
```

- [ ] **Step 6: Run orchestrator gates**

Run:

```powershell
pnpm --filter veslo-orchestrator typecheck
pnpm test:orchestrator
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/orchestrator/src/opencode-workspace-api.ts packages/orchestrator/src/tests/opencode-workspace-api.test.ts packages/orchestrator/src/cli.ts docs/dev/opencode-runtime-contract.md
git commit -m "feat: add diagnostic OpenCode workspace API adapter"
```

---

### Task 9: Final Upgrade Review And Cleanup

**Files:**

- Modify: `docs/dev/opencode-runtime-contract.md`

- [ ] **Step 1: Run full verification set**

Run:

```powershell
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-code-router typecheck
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-orchestrator test:opencode-contract
pnpm test:orchestrator
pnpm --filter veslo-server test
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

- [ ] **Step 2: Run sidecar and metadata verification**

Run:

```powershell
pnpm --filter @neatech/veslo prepare:sidecar
packages\desktop\src-tauri\sidecars\veslo-code.exe --version
$versions = Get-Content packages\desktop\src-tauri\sidecars\versions.json | ConvertFrom-Json
$versions.'veslo-code'.version
```

Expected: both version outputs are `1.17.4`.

- [ ] **Step 3: Run desktop verification**

Run:

```powershell
cd packages\desktop
pnpm tauri build --debug --no-bundle --config src-tauri\tauri.dev.conf.json -- --features e2e

cd ..\e2e
pnpm test --spec .\specs\session.spec.ts
pnpm test --spec .\specs\browse-no-engine-spawn.spec.ts
pnpm test --spec .\specs\multi-workspace-restart.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Update docs with exact verified commands**

In `docs/dev/opencode-runtime-contract.md`, include the exact commands that passed and the date:

```markdown
## Verified On 2026-06-13

Commands:

- `pnpm --filter veslo-orchestrator typecheck`
- `pnpm --filter veslo-code-router typecheck`
- `pnpm --filter veslo-server typecheck`
- `pnpm --filter @neatech/veslo-ui typecheck`
- `pnpm --filter veslo-orchestrator test:opencode-contract`
- `pnpm test:orchestrator`
- `pnpm --filter veslo-server test`
- `pnpm --filter @neatech/veslo-ui test:unit`
- `pnpm tauri build --debug --no-bundle --config src-tauri\tauri.dev.conf.json -- --features e2e`
- `pnpm test --spec .\specs\session.spec.ts`
- `pnpm test --spec .\specs\browse-no-engine-spawn.spec.ts`
- `pnpm test --spec .\specs\multi-workspace-restart.spec.ts`
```

Remove any command from the list that was not actually run successfully.

- [ ] **Step 5: Check diff boundaries**

Run:

```powershell
git diff --stat
git diff --check
git status --short --untracked-files=normal
```

Expected: no whitespace errors. Diff is limited to OpenCode upgrade, runtime contract tests/docs, and diagnostic workspace API adapter.

- [ ] **Step 6: Commit**

```powershell
git add docs/dev/opencode-runtime-contract.md
git commit -m "docs: record OpenCode 1.17 upgrade contract"
```

---

## Rollback Plan

If the upgrade breaks a hard runtime contract and cannot be fixed within the compatibility PR:

1. Revert OpenCode package pins to `1.14.29`.
2. Revert OpenTUI packages to `0.1.77`.
3. Revert static managed-dependency fixtures to `1.14.29`.
4. Run `pnpm install`.
5. Run `pnpm --filter @neatech/veslo prepare:sidecar`.
6. Verify `packages\desktop\src-tauri\sidecars\veslo-code.exe --version` returns `1.14.29`.
7. Keep the newly added `opencode-contract-smoke.mjs` if it passes against `1.14.29`; it is useful for the next migration attempt.

---

## Self-Review

Spec coverage:

- The OpenCode `1.17.4` version bump is covered by Task 1.
- SDK, plugin, and OpenTUI compatibility are covered by Task 2.
- Sidecar download and managed dependency manifest are covered by Task 3.
- Real OpenCode endpoint compatibility is covered by Task 4.
- Veslo server run/read/binding behavior is covered by Task 5.
- App and router session behavior is covered by Task 6.
- Real Tauri runtime verification is covered by Task 7.
- New OpenCode workspace APIs are introduced only as diagnostics in Task 8.
- Final evidence and cleanup are covered by Task 9.

Placeholder scan:

- Every task names exact files, commands, expected outcomes, and commit boundaries.
- The plan avoids replacing Veslo workspace identity during this migration.
- The plan includes an explicit rollback path.

Type consistency:

- OpenCode, SDK, and plugin versions are consistently `1.17.4`.
- OpenTUI package versions are consistently `0.4.1`.
- The diagnostic OpenCode workspace adapter returns local `OpenCodeWorkspaceSummary` objects instead of leaking generated SDK response shapes.
