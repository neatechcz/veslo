# Codex OAuth DEN Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route Veslo/OpenCode prompts through DEN using a DEN-hosted Codex CLI worker profile instead of sending raw OpenAI, Anthropic, or Codex OAuth tokens from the desktop app.

**Architecture:** Veslo desktop continues to configure local OpenCode with a DEN gateway provider endpoint and a DEN gateway token. DEN validates the user/session, applies managed-AI policy, leases a `codex_oauth` runtime profile, converts the provider-compatible request into a Codex CLI prompt, runs `codex exec` in an isolated worker environment, and wraps the final answer back into an OpenAI-compatible non-streaming response.

**Tech Stack:** TypeScript, Express, Node test runner, Node child processes, Drizzle/MySQL, static DEN admin UI, SolidJS app utilities, Codex CLI `codex exec`.

---

## Live Gate Result

The first direct-HTTP compatibility gate is complete.

- Commit: `e6abf56a chore: add codex oauth runtime probe`
- Live result on 2026-04-13: `https://api.openai.com/v1/chat/completions` returned HTTP 429 `insufficient_quota` when called with the local Codex/ChatGPT OAuth access token.
- Decision: do not implement a direct bearer-token HTTP transport for `codex_oauth`. Implement the DEN-hosted Codex CLI worker path instead.

## Ground Rules

- Do not modify `vendor/opencode`.
- Do not commit secrets, OAuth tokens, API keys, or local auth cache contents.
- Keep `openai` and `anthropic` API-key paths intact as legacy/fallback paths unless a task explicitly says otherwise.
- Do not present `codex_oauth` as a raw Anthropic/OpenAI API credential. It is a Codex runtime profile.
- Do not read or write a developer's local `~/.codex/auth.json` from production code.
- Use an explicit worker `CODEX_HOME` or secure runtime secret mount for live worker environments.
- Run focused tests after each task and commit each task separately.

## Task 1: Add a Codex CLI Worker Probe

**Files:**
- Create: `services/den/scripts/probe-codex-cli-worker.ts`

**Step 1: Write the probe script**

Create `services/den/scripts/probe-codex-cli-worker.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const command = process.env.MANAGED_AI_CODEX_COMMAND?.trim() || "codex"
const model = process.env.MANAGED_AI_CODEX_TEST_MODEL?.trim()
const timeoutMs = Number.parseInt(process.env.MANAGED_AI_CODEX_TIMEOUT_MS ?? "120000", 10)
const prompt = process.env.MANAGED_AI_CODEX_TEST_PROMPT?.trim() || "Reply with exactly one word: ok"
const codexHome = process.env.MANAGED_AI_CODEX_HOME?.trim()

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("MANAGED_AI_CODEX_TIMEOUT_MS must be a positive integer")
}

const scratchDir = await mkdtemp(path.join(tmpdir(), "veslo-codex-worker-"))
const outputFile = path.join(scratchDir, "last-message.txt")

try {
  const args = [
    "exec",
    "--cd",
    scratchDir,
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "--ephemeral",
    "--output-last-message",
    outputFile,
  ]
  if (model) {
    args.push("--model", model)
  }
  args.push(prompt)

  const result = await runCodex(command, args, timeoutMs, codexHome)
  const finalMessage = result.exitCode === 0 ? await readFile(outputFile, "utf8").catch(() => "") : ""

  console.log(JSON.stringify({
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout.slice(-2000),
    stderr: result.stderr.slice(-2000),
    finalMessage: finalMessage.slice(0, 2000),
  }, null, 2))

  if (result.exitCode !== 0 || result.timedOut) {
    process.exitCode = 1
  }
} finally {
  await rm(scratchDir, { recursive: true, force: true })
}

function runCodex(command: string, args: string[], timeoutMs: number, codexHome?: string) {
  return new Promise<{
    exitCode: number | null
    signal: NodeJS.Signals | null
    timedOut: boolean
    stdout: string
    stderr: string
  }>((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, timeoutMs)

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer)
      resolve({ exitCode, signal, timedOut, stdout, stderr })
    })
  })
}
```

**Step 2: Run the live probe locally**

Run:

```bash
pnpm --dir services/den exec node --import tsx scripts/probe-codex-cli-worker.ts
```

Expected: If the current environment has a valid Codex login and network access, the command exits 0 and `finalMessage` contains `ok`. If the command fails because of sandboxed network, rerun with escalation. If it fails because there is no valid Codex login, record that as a worker provisioning blocker.

**Step 3: Commit**

```bash
git add services/den/scripts/probe-codex-cli-worker.ts
git commit -m "chore: add codex cli worker probe"
```

## Task 2: Add Shared `codex_oauth` Provider Identity

**Files:**
- Create: `services/den/src/managed-ai/providers/ids.ts`
- Modify: `services/den/src/managed-ai/leases/repository.ts`
- Modify: `services/den/src/managed-ai/access/repository.ts`
- Modify: `services/den/src/managed-ai/credentials/platform-owner.ts`
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Test: `services/den/test/admin-managed-ai-user-access.test.ts`

**Step 1: Write failing user-access tests**

Add a test proving admin AI access accepts `codex_oauth`:

```ts
test("admin can assign codex_oauth managed AI access", async () => {
  const response = await putUserAiAccess({
    userId: "user_1",
    enabled: true,
    provider: "codex_oauth",
    defaultModel: "gpt-5.4",
    allowedModels: ["gpt-5.4"],
  })

  assert.equal(response.status, 200)
  assert.equal(response.body.aiAccess.provider, "codex_oauth")
  assert.equal(response.body.aiAccess.defaultModel, "gpt-5.4")
})
```

Adjust helper names to match the existing test file.

**Step 2: Run the test to verify failure**

Run:

```bash
pnpm --dir services/den exec tsx --test test/admin-managed-ai-user-access.test.ts
```

Expected: FAIL with `invalid_ai_access_provider` or equivalent.

**Step 3: Add provider identity helpers**

Create `services/den/src/managed-ai/providers/ids.ts`:

```ts
export const CODEX_OAUTH_PROVIDER = "codex_oauth" as const
export const MANAGED_AI_PROVIDERS = ["openai", "anthropic", CODEX_OAUTH_PROVIDER] as const
export type ManagedAiProvider = (typeof MANAGED_AI_PROVIDERS)[number]

export function isManagedAiProvider(value: unknown): value is ManagedAiProvider {
  return value === "openai" || value === "anthropic" || value === CODEX_OAUTH_PROVIDER
}

export function isApiKeyCredentialProvider(value: unknown): value is "anthropic" {
  return value === "anthropic"
}

export function formatManagedAiProviderLabel(provider: string): string {
  if (provider === "openai") return "OpenAI"
  if (provider === "anthropic") return "Anthropic"
  if (provider === CODEX_OAUTH_PROVIDER) return "Codex OAuth"
  return provider
}
```

**Step 4: Wire provider types**

Modify the repositories and admin validation so AI access and leases accept `codex_oauth`, but generic API-key credential creation still only accepts API-key providers.

**Step 5: Run focused tests and commit**

Run:

```bash
pnpm --dir services/den exec tsx --test test/admin-managed-ai-user-access.test.ts
git add services/den/src/managed-ai/providers/ids.ts services/den/src/managed-ai/leases/repository.ts services/den/src/managed-ai/access/repository.ts services/den/src/managed-ai/credentials/platform-owner.ts services/den/src/managed-ai/http/admin.ts services/den/test/admin-managed-ai-user-access.test.ts
git commit -m "feat: add codex oauth managed provider id"
```

Expected: PASS before commit.

## Task 3: Add Codex CLI Worker Transport

**Files:**
- Create: `services/den/src/managed-ai/providers/codex-cli-worker-transport.ts`
- Modify: `services/den/src/managed-ai/providers/transport.ts`
- Test: `services/den/test/managed-ai-codex-cli-worker-transport.test.ts`

**Step 1: Write failing transport tests**

Create `services/den/test/managed-ai-codex-cli-worker-transport.test.ts` with tests that use a fake `spawnCodex` function:

```ts
test("converts chat completion messages into a codex prompt and wraps the final answer", async () => {
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async (input) => {
      assert.match(input.prompt, /system: You are concise/)
      assert.match(input.prompt, /user: Say ok/)
      return { exitCode: 0, signal: null, timedOut: false, finalMessage: "ok", stdout: "", stderr: "" }
    },
  })

  const response = await transport.chatCompletions({
    body: {
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "You are concise" },
        { role: "user", content: "Say ok" },
      ],
    },
  })

  assert.equal(response.status, 200)
  assert.equal(response.body.choices[0].message.content, "ok")
  assert.equal(response.body.model, "gpt-5.4")
})

test("rejects streaming requests until streaming is implemented", async () => {
  const transport = new CodexCliWorkerTransport({ spawnCodex: async () => unreachable() })
  await assert.rejects(
    () => transport.chatCompletions({ body: { model: "gpt-5.4", stream: true, messages: [] } }),
    /codex_streaming_not_supported/,
  )
})
```

**Step 2: Run the test to verify failure**

Run:

```bash
pnpm --dir services/den exec tsx --test test/managed-ai-codex-cli-worker-transport.test.ts
```

Expected: FAIL because the transport does not exist.

**Step 3: Add the transport interface**

Modify `services/den/src/managed-ai/providers/transport.ts`:

```ts
export type CodexChatCompletionsTransportInput = {
  body: unknown
}

export interface CodexOAuthProviderTransport {
  chatCompletions(input: CodexChatCompletionsTransportInput): Promise<ProviderTransportResponse>
}
```

**Step 4: Implement the worker transport**

Create `services/den/src/managed-ai/providers/codex-cli-worker-transport.ts`.

Required behavior:

- Extract `model`, `messages`, and `stream` from OpenAI-compatible chat completion bodies.
- Throw `ProviderTransportError("codex_streaming_not_supported", { statusCode: 400 })` for `stream: true`.
- Convert text-only messages into a plain prompt transcript.
- Spawn `codex exec --cd <scratch> --skip-git-repo-check --sandbox read-only --ask-for-approval never --ephemeral --output-last-message <file> --model <model> <prompt>`.
- Use optional env config:
  - `MANAGED_AI_CODEX_COMMAND`
  - `MANAGED_AI_CODEX_HOME`
  - `MANAGED_AI_CODEX_WORKDIR`
  - `MANAGED_AI_CODEX_TIMEOUT_MS`
- Return an OpenAI-compatible object with `id`, `object`, `created`, `model`, one assistant message choice, and `usage: null`.
- Never include raw tokens, full stderr, or local auth paths in returned errors.

**Step 5: Run focused tests and commit**

Run:

```bash
pnpm --dir services/den exec tsx --test test/managed-ai-codex-cli-worker-transport.test.ts
git add services/den/src/managed-ai/providers/transport.ts services/den/src/managed-ai/providers/codex-cli-worker-transport.ts services/den/test/managed-ai-codex-cli-worker-transport.test.ts
git commit -m "feat: add codex cli worker transport"
```

Expected: PASS before commit.

## Task 4: Add Codex OAuth Proxy Route

**Files:**
- Create: `services/den/src/managed-ai/http/providers/codex-oauth.ts`
- Modify: `services/den/src/managed-ai/http/proxy.ts`
- Modify: `services/den/src/managed-ai/runtime/default-runtime.ts`
- Test: `services/den/test/managed-ai-codex-oauth-proxy.test.ts`

**Step 1: Write failing proxy tests**

Create `services/den/test/managed-ai-codex-oauth-proxy.test.ts` using a fake Codex transport. Assert:

- `POST /providers/codex_oauth/v1/chat/completions` requires gateway auth.
- `x-veslo-session-id` is required.
- AI access policy must allow provider `codex_oauth`.
- Lease scope provider is `codex_oauth`.
- Binding owner is `platform:codex_oauth`.
- Fake transport receives the policy-filtered body.
- Response body is forwarded to OpenCode.
- Usage records provider `codex_oauth`.

**Step 2: Run the test to verify failure**

Run:

```bash
pnpm --dir services/den exec tsx --test test/managed-ai-codex-oauth-proxy.test.ts
```

Expected: FAIL because the route does not exist.

**Step 3: Implement the proxy route**

Create the route by following `services/den/src/managed-ai/http/providers/openai.ts`, with these differences:

- route provider: `codex_oauth`
- binding owner: `getPlatformCredentialOwnerUserId("codex_oauth")`
- transport call: `deps.codexOAuthTransport.chatCompletions({ body })`
- no upstream bearer token lookup for the MVP worker route
- request id prefix: `codex_oauth_req_`
- usage provider: `codex_oauth`

Modify `services/den/src/managed-ai/http/proxy.ts`:

```ts
router.use("/providers/codex_oauth", createCodexOAuthProxyRouter(deps))
```

Modify `services/den/src/managed-ai/runtime/default-runtime.ts` to instantiate `new CodexCliWorkerTransport()`.

**Step 4: Run focused tests and commit**

Run:

```bash
pnpm --dir services/den exec tsx --test test/managed-ai-codex-oauth-proxy.test.ts
git add services/den/src/managed-ai/http/providers/codex-oauth.ts services/den/src/managed-ai/http/proxy.ts services/den/src/managed-ai/runtime/default-runtime.ts services/den/test/managed-ai-codex-oauth-proxy.test.ts
git commit -m "feat: proxy codex oauth through cli worker"
```

Expected: PASS before commit.

## Task 5: Update Veslo Desktop Provider Routing

**Files:**
- Modify: `packages/app/src/app/utils/providers.ts`
- Test: `packages/app/src/app/utils/providers.test.ts`
- Test: `packages/app/src/app/lib/ai-access.test.ts`
- Test: `packages/app/src/app/lib/provider-routing.test.ts`

**Step 1: Write failing app tests**

Add tests proving `codex_oauth` is gateway-owned and formats as:

```json
{
  "model": "codex_oauth/gpt-5.4",
  "provider": {
    "codex_oauth": {
      "options": {
        "baseURL": "https://veslo.example.test/ai-gateway/providers/codex_oauth/v1"
      }
    }
  }
}
```

**Step 2: Run focused app tests to verify failure**

Run:

```bash
pnpm --dir packages/app test -- app/utils/providers.test.ts app/lib/ai-access.test.ts app/lib/provider-routing.test.ts
```

Expected: FAIL because `codex_oauth` is not gateway-owned yet.

**Step 3: Update provider utilities**

Modify `packages/app/src/app/utils/providers.ts`:

```ts
export const GATEWAY_OWNED_PROVIDER_IDS = ["openai", "anthropic", "codex_oauth"] as const
```

**Step 4: Run focused app tests and commit**

Run:

```bash
pnpm --dir packages/app test -- app/utils/providers.test.ts app/lib/ai-access.test.ts app/lib/provider-routing.test.ts
git add packages/app/src/app/utils/providers.ts packages/app/src/app/utils/providers.test.ts packages/app/src/app/lib/ai-access.test.ts packages/app/src/app/lib/provider-routing.test.ts
git commit -m "feat: route codex oauth provider from desktop"
```

Expected: PASS before commit.

## Task 6: Update DEN Admin UI Copy and Controls

**Files:**
- Modify: `services/den/public-admin/index.html`
- Modify: `services/den/public-admin/app.js`
- Test: `services/den/test/admin-managed-ai-ui.test.ts`

**Step 1: Write failing UI shell tests**

Modify `services/den/test/admin-managed-ai-ui.test.ts` to assert:

- the credentials page contains primary `Codex / ChatGPT` runtime profile copy
- the user AI access provider select contains `codex_oauth`
- legacy OpenAI/Anthropic API-key controls are labeled as fallback, not primary

**Step 2: Run the UI test to verify failure**

Run:

```bash
pnpm --dir services/den exec tsx --test test/admin-managed-ai-ui.test.ts
```

Expected: FAIL because UI still presents raw provider credentials as primary.

**Step 3: Update UI**

Update the static admin UI to show `codex_oauth` as the primary managed-AI assignment option and label API-key credentials as fallback/legacy.

Do not add a fake browser OAuth exchange unless worker auth materialization has been implemented. For the MVP, the credential/control should make clear that the Codex worker profile is provisioned server-side and validated by the worker probe.

**Step 4: Run focused UI tests and commit**

Run:

```bash
pnpm --dir services/den exec tsx --test test/admin-managed-ai-ui.test.ts
git add services/den/public-admin/index.html services/den/public-admin/app.js services/den/test/admin-managed-ai-ui.test.ts
git commit -m "feat: add codex oauth admin controls"
```

Expected: PASS before commit.

## Task 7: Full Verification and Live Gate

**Files:**
- No planned code edits.

**Step 1: Run DEN focused tests**

Run:

```bash
pnpm --dir services/den test
```

Expected: all DEN tests pass.

**Step 2: Build DEN**

Run:

```bash
pnpm --dir services/den build
```

Expected: TypeScript build exits 0.

**Step 3: Run app focused tests**

Run:

```bash
pnpm --dir packages/app test -- app/utils/providers.test.ts app/lib/ai-access.test.ts app/lib/provider-routing.test.ts
```

Expected: all focused tests pass.

**Step 4: Run local Codex CLI worker live gate**

Run:

```bash
pnpm --dir services/den exec node --import tsx scripts/probe-codex-cli-worker.ts
```

Expected: exits 0 and returns `ok` when a valid Codex login is provisioned for the worker environment.

**Step 5: Run live Render gate**

After deployment, verify:

- Render worker environment has a valid Codex runtime profile or mounted `CODEX_HOME`.
- Admin can assign provider `codex_oauth` and a Codex-runtime model to a user.
- Veslo desktop config routes the provider to `/ai-gateway/providers/codex_oauth/v1`.
- A prompt returns a model response through OpenCode.
- Usage is recorded under provider `codex_oauth`.

**Step 6: Desktop E2E only if launching Veslo**

If launching/testing Veslo internally, follow AGENTS.md and do not run the Next.js web app:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
cd ../e2e
pnpm test --spec ./specs/<target>.spec.ts
```
