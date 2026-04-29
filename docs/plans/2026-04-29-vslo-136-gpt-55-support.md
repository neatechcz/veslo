# VSLO-136 GPT-5.5 Managed Codex Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support `codex_oauth/gpt-5.5` when explicitly assigned while keeping the existing managed Codex default unchanged.

**Architecture:** Update both Codex runtime surfaces: the desktop/orchestrator OpenCode sidecar version and the server-side `@openai/codex` worker dependency. Keep managed provider routing unchanged except for tests that prove GPT-5.5 passes through, and add worker-side failure classification so old runtimes return an actionable incompatibility error.

**Tech Stack:** pnpm workspace, SolidJS app tests with Node test plus `tsx/esm`, Express AI gateway and DEN services, Tauri desktop sidecars, OpenCode `veslo-code`, `@openai/codex`.

---

### Task 1: Update Runtime Pins

**Files:**
- Modify: `packages/desktop/package.json`
- Modify: `packages/orchestrator/package.json`
- Modify: `services/ai-gateway/package.json`
- Modify: `services/den/package.json`
- Modify: `pnpm-lock.yaml`

**Step 1: Update package metadata**

Set both OpenCode sidecar pins to the same current supported version:

```json
"opencodeVersion": "1.14.29"
```

Set both Codex CLI dependencies to:

```json
"@openai/codex": "0.125.0"
```

**Step 2: Refresh the lockfile**

Run:

```bash
pnpm install --lockfile-only
```

Expected: `pnpm-lock.yaml` updates `@openai/codex` and its platform packages to `0.125.0`.

**Step 3: Verify metadata**

Run:

```bash
rg '"opencodeVersion": "1.14.29"|"@openai/codex": "0.125.0"' packages services pnpm-lock.yaml
```

Expected: both package pins are updated, and lockfile entries reference `@openai/codex@0.125.0`.

**Step 4: Commit**

```bash
git add packages/desktop/package.json packages/orchestrator/package.json services/ai-gateway/package.json services/den/package.json pnpm-lock.yaml
git commit -m "chore: update codex runtimes for gpt-5.5"
```

### Task 2: Prove GPT-5.5 Managed Config Support

**Files:**
- Modify: `packages/app/src/app/lib/ai-access.test.ts`
- Modify: `packages/app/src/app/lib/provider-routing.test.ts`

**Step 1: Add failing app tests**

Add coverage that uses a managed Codex profile with:

```ts
defaultModel: {
  providerID: "codex_oauth",
  modelID: "gpt-5.4",
},
allowedModels: ["gpt-5.4", "gpt-5.5"],
```

Assert that `formatManagedAiAccessConfig` produces:

```ts
parsed.model === "codex_oauth/gpt-5.4"
parsed.provider?.codex_oauth?.models?.["gpt-5.5"]?.name === "gpt-5.5"
parsed.provider?.codex_oauth?.models?.["gpt-5.5"]?.tool_call === true
parsed.provider?.codex_oauth?.models?.["gpt-5.5"]?.reasoning === true
```

Also add a direct provider-routing test that calls `applyGatewayProviderRouting` with:

```ts
models: ["gpt-5.4", "gpt-5.5"]
```

Assert that both models receive `x-veslo-gateway-token` and `x-veslo-session-id` headers.

**Step 2: Run tests and verify they fail only if implementation is missing**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/ai-access.test.ts src/app/lib/provider-routing.test.ts
```

Expected before implementation: new assertions fail if GPT-5.5 is not included in generated config.

**Step 3: Implement minimal app-side change if needed**

If the tests fail because duplicate/default model handling drops GPT-5.5, update `formatManagedAiAccessConfig` or `applyGatewayProviderRouting` to preserve the unique ordered model set from default plus allowed models. Do not change default model selection.

**Step 4: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/ai-access.test.ts src/app/lib/provider-routing.test.ts
```

Expected: all selected app tests pass.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/ai-access.test.ts packages/app/src/app/lib/provider-routing.test.ts packages/app/src/app/lib/ai-access.ts packages/app/src/app/lib/opencode.ts
git commit -m "test: cover managed codex gpt-5.5 routing"
```

### Task 3: Classify GPT-5.5 Runtime Incompatibility

**Files:**
- Modify: `services/ai-gateway/src/providers/codex-cli-worker-transport.ts`
- Modify: `services/ai-gateway/test/codex-cli-worker-transport.test.ts`
- Modify: `services/den/src/managed-ai/providers/codex-cli-worker-transport.ts`
- Modify: `services/den/test/managed-ai-codex-cli-worker-transport.test.ts`

**Step 1: Add failing transport tests**

In both worker transport test files, add a test where `spawnCodex` returns:

```ts
{
  exitCode: 1,
  signal: null,
  timedOut: false,
  finalMessage: "",
  stdout: "",
  stderr: "Error: unknown model gpt-5.5",
}
```

Call `chatCompletions` with:

```ts
body: {
  model: "gpt-5.5",
  messages: [{ role: "user", content: "Say ok." }],
}
```

Assert the thrown `ProviderTransportError` has:

```ts
error.message === "codex_runtime_incompatible"
error.statusCode === 502
error.body.error.code === "codex_runtime_incompatible"
error.body.error.type === "runtime_incompatible"
String(error.body.error.message).includes("gpt-5.5")
```

**Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-cli-worker-transport.test.ts
pnpm --filter @neatech/den exec tsx --test test/managed-ai-codex-cli-worker-transport.test.ts
```

Expected: new incompatibility tests fail.

**Step 3: Implement classifier**

In both transport files, add helpers near `summarizeWorkerStderr`:

```ts
function isGpt55RuntimeIncompatibility(input: { model: string; stderrTail: string | null }): boolean {
  if (input.model.trim().toLowerCase() !== "gpt-5.5") return false
  const stderr = input.stderrTail?.toLowerCase() ?? ""
  if (!stderr) return false
  if (!stderr.includes("gpt-5.5")) return false
  return /(unknown|unsupported|not supported|not found|invalid|unrecognized|unavailable)/.test(stderr)
}

function buildCodexRuntimeIncompatibleBody(input: {
  model: string
  timedOut: boolean
  exitCode: number | null
  stderrTail: string | null
}) {
  return {
    error: {
      code: "codex_runtime_incompatible",
      type: "runtime_incompatible",
      message: `The Codex runtime bundled with Veslo is too old for ${input.model}. Update Veslo to a build with the current veslo-code/Codex runtime, then retry.`,
    },
    timedOut: input.timedOut,
    exitCode: input.exitCode,
    ...(input.stderrTail ? { stderrTail: input.stderrTail } : {}),
  }
}
```

Before throwing the generic `codex_worker_failed`, branch on this classifier and throw:

```ts
throw new ProviderTransportError("codex_runtime_incompatible", {
  statusCode: 502,
  code: "codex_runtime_incompatible",
  body: buildCodexRuntimeIncompatibleBody({
    model,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    stderrTail,
  }),
})
```

**Step 4: Run tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-cli-worker-transport.test.ts
pnpm --filter @neatech/den exec tsx --test test/managed-ai-codex-cli-worker-transport.test.ts
```

Expected: all selected worker transport tests pass.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/providers/codex-cli-worker-transport.ts services/ai-gateway/test/codex-cli-worker-transport.test.ts services/den/src/managed-ai/providers/codex-cli-worker-transport.ts services/den/test/managed-ai-codex-cli-worker-transport.test.ts
git commit -m "fix: explain outdated codex runtime for gpt-5.5"
```

### Task 4: Preserve Structured Worker Errors Through Proxies

**Files:**
- Modify: `services/ai-gateway/test/codex-oauth-proxy.test.ts`
- Modify: `services/den/src/managed-ai/http/providers/codex-oauth.ts`
- Modify: `services/den/test/managed-ai-codex-oauth-proxy.test.ts`

**Step 1: Add proxy tests**

For AI gateway, add a proxy test that throws:

```ts
new ProviderTransportError("codex_runtime_incompatible", {
  statusCode: 502,
  code: "codex_runtime_incompatible",
  body: {
    error: {
      code: "codex_runtime_incompatible",
      type: "runtime_incompatible",
      message: "The Codex runtime bundled with Veslo is too old for gpt-5.5. Update Veslo to a build with the current veslo-code/Codex runtime, then retry.",
    },
  },
})
```

Assert the proxy response status is `502` and the JSON body preserves `error.code`.

For DEN, add equivalent coverage. DEN currently maps 5xx transport errors to `proxy_request_failed`; the new test should expect the structured body to be preserved.

**Step 2: Run tests and verify DEN failure**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-oauth-proxy.test.ts
pnpm --filter @neatech/den exec tsx --test test/managed-ai-codex-oauth-proxy.test.ts
```

Expected: AI gateway may already pass; DEN should fail until the catch block preserves `ProviderTransportError.body`.

**Step 3: Implement DEN proxy preservation**

Update the DEN codex OAuth proxy catch block to mirror the AI gateway structured error handling:

```ts
if (error instanceof ProviderTransportError) {
  if (error.body && typeof error.body === "object") {
    res.status(error.statusCode ?? 502).json(error.body as Record<string, unknown>)
    return
  }

  if (error.statusCode) {
    res.status(error.statusCode).json({ error: error.message })
    return
  }
}
```

Keep existing generic `proxy_request_failed` behavior for unknown errors.

**Step 4: Run tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-oauth-proxy.test.ts
pnpm --filter @neatech/den exec tsx --test test/managed-ai-codex-oauth-proxy.test.ts
```

Expected: selected proxy tests pass.

**Step 5: Commit**

```bash
git add services/ai-gateway/test/codex-oauth-proxy.test.ts services/den/src/managed-ai/http/providers/codex-oauth.ts services/den/test/managed-ai-codex-oauth-proxy.test.ts
git commit -m "fix: preserve codex runtime error details"
```

### Task 5: Server Proxy GPT-5.5 Coverage

**Files:**
- Modify: `packages/server/src/server.ai-gateway.test.ts`

**Step 1: Add failing test or update existing test input**

Add coverage that posts to the local server AI gateway Codex route with:

```json
{
  "model": "gpt-5.5",
  "messages": [{ "role": "user", "content": "hello" }]
}
```

Assert the proxied gateway request body still contains:

```json
{
  "model": "gpt-5.5"
}
```

Do not change behavior for existing GPT-5.4 proxy tests.

**Step 2: Run test**

Run:

```bash
pnpm --filter openwork-server exec tsx --test src/server.ai-gateway.test.ts
```

Expected: server proxy test passes after the assertion is added because the proxy should be model-transparent.

**Step 3: Rebuild server binary**

Because `packages/server/src` tests were touched and server behavior is being verified, run:

```bash
pnpm --filter openwork-server build:bin
```

Expected: server binary rebuild exits 0.

**Step 4: Commit**

```bash
git add packages/server/src/server.ai-gateway.test.ts
git commit -m "test: cover server codex gpt-5.5 proxying"
```

### Task 6: Prepare Sidecar For Local Desktop Verification

**Files:**
- Generated ignored files under `packages/desktop/src-tauri/sidecars/`

**Step 1: Prepare the desktop sidecar**

Run:

```bash
pnpm --filter @neatech/veslo run prepare:sidecar
```

Expected: ignored local sidecar files are generated, and `veslo-code --version` reports `1.14.29`.

**Step 2: Verify sidecar version directly**

Run:

```bash
packages/desktop/src-tauri/sidecars/veslo-code --version
```

Expected: output includes `1.14.29`.

**Step 3: Check git status**

Run:

```bash
git status --short
```

Expected: no generated sidecar binaries are staged or tracked because the sidecar directory is ignored.

### Task 7: Full Focused Verification

**Files:**
- No edits expected.

**Step 1: Run app tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/ai-access.test.ts src/app/lib/provider-routing.test.ts
```

Expected: all selected app tests pass.

**Step 2: Run AI gateway tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-cli-worker-transport.test.ts test/codex-oauth-proxy.test.ts
```

Expected: all selected AI gateway tests pass.

**Step 3: Run DEN tests**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/managed-ai-codex-cli-worker-transport.test.ts test/managed-ai-codex-oauth-proxy.test.ts
```

Expected: all selected DEN tests pass.

**Step 4: Run server proxy test**

Run:

```bash
pnpm --filter openwork-server exec tsx --test src/server.ai-gateway.test.ts
```

Expected: server proxy test passes.

**Step 5: Run package builds**

Run:

```bash
pnpm --filter @neatech/ai-gateway build
pnpm --filter @neatech/den build
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: each command exits 0.

### Task 8: Real Desktop Acceptance Check

**Files:**
- No edits expected.

**Step 1: Follow desktop preflight**

Use `docs/dev/testing-playbook.md` to detect and stop internally started Veslo dev/test desktop processes from this repo, then verify no relevant process remains.

**Step 2: Start the real desktop runtime**

Use `docs/dev/development-startup.md` fresh rebuild startup flow from `packages/desktop`.

Do not use the UI-only web server as the runtime under test.

**Step 3: Verify managed GPT-5.5 prompt flow**

Use a managed Codex assignment where:

```json
{
  "provider": "codex_oauth",
  "defaultModel": "gpt-5.4",
  "allowedModels": ["gpt-5.4", "gpt-5.5"]
}
```

Select or route to `codex_oauth/gpt-5.5`, send a short prompt, and confirm the desktop app receives a response.

**Step 4: Verify incompatibility message if feasible**

If an older runtime can be forced by environment or binary override without corrupting the branch, confirm a GPT-5.5 failure surfaces `codex_runtime_incompatible` with the actionable update message.

**Step 5: Final status**

Run:

```bash
git status --short --branch
```

Expected: only intentional committed changes remain; ignored sidecar output may exist locally but should not appear in status.
