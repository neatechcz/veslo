# Image Generation Broker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an agent-callable Veslo image generation broker that tries Codex OAuth Responses image generation first, saves generated images as workspace/session artifacts, renders them in the transcript, and never silently falls back to a platform OpenAI credential.

**Architecture:** Provision a Veslo-managed OpenCode plugin tool named `veslo_image_generate`; the tool calls the local Veslo server instead of holding credentials or writing files. The local server brokers the request, calls the managed AI Gateway image route for `codex_oauth`, persists valid image bytes into the outbox, and returns normalized media artifact metadata. AI Gateway and Den both get the same Codex OAuth image route and transport parsing so owned-server and Den-managed deployments stay in sync.

**Tech Stack:** TypeScript, Bun server tests, Node `tsx --test`, Solid/PartView rendering, OpenCode plugin tools, Tauri desktop WebdriverIO E2E, Codex Responses `image_generation` tool.

---

## Setup Notes

- Work in a clean dedicated worktree if possible:

```bash
git worktree add ../Veslo-image-generation-broker -b codex/image-generation-broker dev_vaclav
cd ../Veslo-image-generation-broker
```

- The current package name for the server is `veslo-server`. Repo instructions still mention `openwork-server` in places; use `pnpm --filter veslo-server build:bin` for the actual rebuild and record if the stale filter name is encountered.
- Do not start UI-only Vite servers as app verification. Desktop behavior must be verified through `packages/desktop` and `packages/e2e`.
- If a task changes `packages/server/src`, rebuild the server binary before desktop/E2E verification.

## Shared Route And Payload Names

Use these names consistently through the implementation:

- OpenCode tool name: `veslo_image_generate`
- Local server route: `POST /workspace/:id/image-generation`
- Managed gateway route: `POST /providers/codex_oauth/v1/images/generations`
- Local server proxy route: `POST /ai-gateway/providers/codex_oauth/v1/images/generations`
- Output directory under workspace: `.opencode/veslo/outbox/generated-images/`

Core request shape:

```ts
export type ImageGenerationRequest = {
  prompt: string;
  sessionId?: string;
  activeProvider?: string;
  activeModel?: string;
  outputFormat?: "png" | "jpeg" | "webp";
  size?: string;
  quality?: "low" | "medium" | "high" | "auto";
};
```

Core success shape:

```ts
export type ImageGenerationSuccess = {
  ok: true;
  backend: "codex_oauth" | "fallback";
  artifact: {
    id: string;
    path: string;
    mimeType: string;
    bytes: number;
    filename: string;
  };
  image: {
    mediaType: string;
    data: string;
    alt: string;
  };
  metadata: {
    requestId?: string;
    model?: string;
    provider?: string;
    revisedPrompt?: string;
    usage?: Record<string, unknown>;
  };
};
```

Core error shape:

```ts
export type ImageGenerationFailure = {
  ok: false;
  code:
    | "unsupported"
    | "unavailable"
    | "exhausted"
    | "not_configured"
    | "policy_rejected"
    | "invalid_result"
    | "persistence_failed";
  message: string;
  backend?: "codex_oauth" | "fallback";
  requestId?: string;
};
```

---

### Task 1: Server Image Result Validation And Persistence

**Files:**

- Create: `packages/server/src/image-generation.ts`
- Create: `packages/server/src/image-generation.test.ts`

**Step 1: Write the failing tests**

Add tests for prompt validation, safe filename generation, MIME validation, base64 decoding, outbox persistence, and no final artifact on invalid bytes.

```ts
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  classifyImageGenerationFailure,
  persistGeneratedImage,
  validateImageGenerationRequest,
} from "./image-generation.js";

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

describe("image generation broker primitives", () => {
  test("validates a minimal prompt request", () => {
    expect(validateImageGenerationRequest({ prompt: "Draw a red Veslo icon" })).toEqual({
      prompt: "Draw a red Veslo icon",
      outputFormat: "png",
      quality: "auto",
    });
  });

  test("persists generated image bytes under generated-images", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-image-generation-"));
    const result = await persistGeneratedImage({
      workspaceRoot,
      sessionId: "ses_123",
      prompt: "Draw a red Veslo icon",
      mimeType: "image/png",
      base64: onePixelPng,
      requestedFormat: "png",
      now: () => new Date("2026-05-27T10:20:30.000Z"),
    });

    expect(result.path).toMatch(/^\.opencode\/veslo\/outbox\/generated-images\/2026-05-27-102030-red-veslo-icon-[a-z0-9]+\.png$/);
    expect(result.mimeType).toBe("image/png");
    expect(result.bytes).toBeGreaterThan(0);
    expect(await stat(join(workspaceRoot, result.path))).toMatchObject({ size: result.bytes });
    expect(await readFile(join(workspaceRoot, result.path))).toEqual(Buffer.from(onePixelPng, "base64"));
  });

  test("classifies policy failures as non-fallbackable", () => {
    expect(classifyImageGenerationFailure({ status: 400, code: "content_policy_violation" })).toEqual({
      code: "policy_rejected",
      fallbackAllowed: false,
    });
  });
});
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
pnpm --filter veslo-server exec bun test src/image-generation.test.ts
```

Expected: FAIL because `image-generation.ts` does not exist.

**Step 3: Implement the primitives**

Create `packages/server/src/image-generation.ts` with narrow, dependency-free helpers:

```ts
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export type ImageGenerationFailureCode =
  | "unsupported"
  | "unavailable"
  | "exhausted"
  | "not_configured"
  | "policy_rejected"
  | "invalid_result"
  | "persistence_failed";

export type ImageGenerationRequest = {
  prompt: string;
  sessionId?: string;
  activeProvider?: string;
  activeModel?: string;
  outputFormat?: "png" | "jpeg" | "webp";
  size?: string;
  quality?: "low" | "medium" | "high" | "auto";
};

export function validateImageGenerationRequest(input: unknown): ImageGenerationRequest {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) throw new Error("prompt_required");

  const outputFormat =
    body.outputFormat === "jpeg" || body.outputFormat === "webp" || body.outputFormat === "png"
      ? body.outputFormat
      : "png";
  const quality =
    body.quality === "low" || body.quality === "medium" || body.quality === "high" || body.quality === "auto"
      ? body.quality
      : "auto";

  return {
    prompt,
    outputFormat,
    quality,
    ...(typeof body.sessionId === "string" && body.sessionId.trim() ? { sessionId: body.sessionId.trim() } : {}),
    ...(typeof body.activeProvider === "string" && body.activeProvider.trim() ? { activeProvider: body.activeProvider.trim() } : {}),
    ...(typeof body.activeModel === "string" && body.activeModel.trim() ? { activeModel: body.activeModel.trim() } : {}),
    ...(typeof body.size === "string" && body.size.trim() ? { size: body.size.trim() } : {}),
  };
}

export function classifyImageGenerationFailure(input: { status?: number; code?: string; message?: string }): {
  code: ImageGenerationFailureCode;
  fallbackAllowed: boolean;
} {
  const code = String(input.code ?? input.message ?? "").toLowerCase();
  if (code.includes("policy") || code.includes("safety") || code.includes("content")) {
    return { code: "policy_rejected", fallbackAllowed: false };
  }
  if (code.includes("unsupported") || input.status === 404) return { code: "unsupported", fallbackAllowed: true };
  if (code.includes("exhausted") || code.includes("rate_limit")) return { code: "exhausted", fallbackAllowed: true };
  return { code: "unavailable", fallbackAllowed: true };
}

export async function persistGeneratedImage(input: {
  workspaceRoot: string;
  sessionId?: string;
  prompt: string;
  mimeType: string;
  base64: string;
  requestedFormat?: "png" | "jpeg" | "webp";
  now?: () => Date;
}) {
  const extension = extensionForMime(input.mimeType, input.requestedFormat);
  const bytes = Buffer.from(input.base64, "base64");
  if (bytes.length === 0) throw new Error("invalid_result");

  const now = input.now?.() ?? new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const slug = slugFromPrompt(input.prompt);
  const suffix = randomBytes(4).toString("hex");
  const filename = `${stamp}-${slug}-${suffix}.${extension}`;
  const relativePath = `.opencode/veslo/outbox/generated-images/${filename}`;
  const absolutePath = join(input.workspaceRoot, relativePath);
  await mkdir(join(input.workspaceRoot, ".opencode", "veslo", "outbox", "generated-images"), { recursive: true });
  await writeFile(absolutePath, bytes);

  return {
    id: Buffer.from(relativePath, "utf8").toString("base64url"),
    path: relativePath,
    filename: basename(relativePath),
    mimeType: input.mimeType,
    bytes: bytes.length,
  };
}

function extensionForMime(mimeType: string, requested?: string) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (requested === "jpeg") return "jpg";
  if (requested === "webp") return "webp";
  if (requested === "png") return "png";
  throw new Error("invalid_result");
}

function slugFromPrompt(prompt: string) {
  const clean = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return clean || createHash("sha1").update(prompt).digest("hex").slice(0, 8);
}
```

**Step 4: Run the focused test**

Run:

```bash
pnpm --filter veslo-server exec bun test src/image-generation.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/image-generation.ts packages/server/src/image-generation.test.ts
git commit -m "feat: add image generation broker primitives"
```

---

### Task 2: Codex OAuth Image Generation Transport In AI Gateway

**Files:**

- Modify: `services/ai-gateway/src/providers/transport.ts`
- Modify: `services/ai-gateway/src/providers/codex-oauth-inference-proxy-transport.ts`
- Create: `services/ai-gateway/test/codex-oauth-image-generation.test.ts`

**Step 1: Write the failing transport test**

Create a test that proves the transport sends a Responses request with `image_generation`, uses server-side Codex OAuth auth JSON, and normalizes the returned `image_generation_call`.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { CodexOAuthInferenceProxyTransport } from "../src/providers/codex-oauth-inference-proxy-transport.js";

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

test("codex oauth image generation uses Responses image_generation tool", async () => {
  const calls: Array<{ url: string; body: any; headers: any }> = [];
  const transport = new CodexOAuthInferenceProxyTransport({
    baseUrl: "https://codex-inference.example.test",
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        headers: init?.headers,
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({
        id: "resp_img_1",
        model: "gpt-5.5",
        output: [{
          type: "image_generation_call",
          id: "ig_1",
          result: onePixelPng,
          revised_prompt: "A red Veslo icon on a transparent background",
        }],
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
      }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "req_img_1" },
      });
    },
  });

  const result = await transport.generateImage({
    body: { model: "gpt-5.5", prompt: "Draw a red Veslo icon", outputFormat: "png", quality: "auto" },
    authJson: JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "codex-access-token", account_id: "acct_1" },
    }),
  });

  assert.equal(calls[0]?.url, "https://codex-inference.example.test/backend-api/codex/responses");
  assert.deepEqual(calls[0]?.body.tools, [{ type: "image_generation" }]);
  assert.deepEqual(calls[0]?.body.input, "Draw a red Veslo icon");
  assert.equal(calls[0]?.headers.authorization, "Bearer codex-access-token");
  assert.equal(result.ok, true);
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.base64, onePixelPng);
  assert.equal(result.requestId, "req_img_1");
  assert.equal(result.revisedPrompt, "A red Veslo icon on a transparent background");
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/codex-oauth-image-generation.test.ts
```

Expected: FAIL because `generateImage` is missing.

**Step 3: Extend transport types**

In `services/ai-gateway/src/providers/transport.ts`, add:

```ts
export type CodexImageGenerationTransportInput = {
  body: unknown;
  authJson?: string | null;
};

export type ProviderImageGenerationResponse =
  | {
      ok: true;
      mimeType: string;
      base64: string;
      requestId?: string;
      model?: string;
      revisedPrompt?: string;
      usage?: TokenUsageAccounting;
    }
  | {
      ok: false;
      code: "unsupported" | "unavailable" | "exhausted" | "policy_rejected" | "invalid_result";
      message: string;
      requestId?: string;
    };
```

Then extend `CodexOAuthProviderTransport`:

```ts
generateImage?(input: CodexImageGenerationTransportInput): Promise<ProviderImageGenerationResponse>;
```

**Step 4: Implement `generateImage`**

Add `generateImage` to `CodexOAuthInferenceProxyTransport`. Keep it separate from chat completion translation; it should call the same Codex Responses URL with a JSON body:

```ts
{
  model,
  input: prompt,
  tools: [{ type: "image_generation" }],
  store: false
}
```

Parse the first output item with `type === "image_generation_call"` and a string `result`. Return `invalid_result` when result is missing or empty. Read request id from `x-request-id` or `x-upstream-request-id`.

**Step 5: Run focused AI Gateway tests**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/codex-oauth-image-generation.test.ts test/codex-oauth-inference-proxy-transport.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/ai-gateway/src/providers/transport.ts services/ai-gateway/src/providers/codex-oauth-inference-proxy-transport.ts services/ai-gateway/test/codex-oauth-image-generation.test.ts
git commit -m "feat: add codex oauth image transport"
```

---

### Task 3: AI Gateway HTTP Route For Codex Image Generation

**Files:**

- Modify: `services/ai-gateway/src/http/providers/codex-oauth.ts`
- Create: `services/ai-gateway/test/codex-oauth-image-route.test.ts`

**Step 1: Write the failing route test**

Test that `POST /providers/codex_oauth/v1/images/generations` requires a session id, applies the assigned `codex_oauth` credential, calls `codexOAuthTransport.generateImage`, records usage when available, and returns the normalized image result.

Use dependency fakes matching existing `codex-oauth` route tests. The important assertion:

```ts
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), {
  ok: true,
  mimeType: "image/png",
  base64: onePixelPng,
  requestId: "req_img_1",
  model: "gpt-5.5",
  revisedPrompt: "A red Veslo icon",
});
```

Add a second test for a transport `policy_rejected` result:

```ts
assert.equal(response.status, 400);
assert.deepEqual(await response.json(), {
  ok: false,
  code: "policy_rejected",
  message: "Image request rejected by provider policy.",
  requestId: "req_policy_1",
});
```

**Step 2: Run the route test to verify it fails**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/codex-oauth-image-route.test.ts
```

Expected: FAIL because the route does not exist.

**Step 3: Implement the route**

In `createCodexOAuthProxyRouter`, add:

```ts
router.post("/v1/images/generations", async (req, res) => {
  // Same auth/session/access-policy/assigned-binding flow as chat completions.
  // Require x-veslo-session-id.
  // Require deps.codexOAuthTransport.generateImage.
  // Load assigned auth JSON.
  // Call generateImage({ body: req.body, authJson }).
  // Map ok result to 200.
  // Map policy_rejected to 400, unsupported to 422, exhausted/unavailable to 503.
  // Record usage when result.ok && result.usage exists.
});
```

Do not route image generation through OpenAI or OpenAI-compatible credentials here.

**Step 4: Run the route test**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/codex-oauth-image-route.test.ts
```

Expected: PASS.

**Step 5: Run focused AI Gateway suite**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/codex-oauth-image-generation.test.ts test/codex-oauth-image-route.test.ts test/codex-oauth-inference-proxy-transport.test.ts
pnpm --dir services/ai-gateway build
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/ai-gateway/src/http/providers/codex-oauth.ts services/ai-gateway/test/codex-oauth-image-route.test.ts
git commit -m "feat: expose codex oauth image generation route"
```

---

### Task 4: Den Managed-AI Parity

**Files:**

- Modify: `services/den/src/managed-ai/providers/transport.ts`
- Modify: `services/den/src/managed-ai/providers/codex-oauth-inference-proxy-transport.ts`
- Modify: `services/den/src/managed-ai/http/providers/codex-oauth.ts`
- Create: `services/den/test/managed-ai-codex-image-generation.test.ts`

**Step 1: Write the failing parity test**

Copy the AI Gateway transport and route coverage into one Den-focused test file. Import from `services/den/src/managed-ai/...` and assert the same request/response behavior.

**Step 2: Run it to verify failure**

Run:

```bash
pnpm --dir services/den exec tsx --test test/managed-ai-codex-image-generation.test.ts
```

Expected: FAIL because Den managed-AI lacks the image route/transport.

**Step 3: Mirror the AI Gateway implementation**

Keep names, response shapes, error classification, and usage handling identical to `services/ai-gateway`. Do not introduce Den-specific divergence unless a test proves it is required.

**Step 4: Run Den focused tests**

Run:

```bash
pnpm --dir services/den exec tsx --test test/managed-ai-codex-image-generation.test.ts test/managed-ai-codex-oauth-inference-proxy-transport.test.ts
pnpm --dir services/den build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/managed-ai/providers/transport.ts services/den/src/managed-ai/providers/codex-oauth-inference-proxy-transport.ts services/den/src/managed-ai/http/providers/codex-oauth.ts services/den/test/managed-ai-codex-image-generation.test.ts
git commit -m "feat: mirror codex image generation in den"
```

---

### Task 5: Local Veslo Server Proxy And Broker Route

**Files:**

- Modify: `packages/server/src/server.ts`
- Create: `packages/server/src/server.image-generation.test.ts`
- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/README.md`

**Step 1: Write failing local server tests**

Create tests covering:

1. `/ai-gateway/providers/codex_oauth/v1/images/generations` proxies to the managed AI base URL with `x-veslo-gateway-token` and `x-veslo-session-id`.
2. `/workspace/:id/image-generation` with `activeProvider: "codex_oauth"` calls the local proxy path first.
3. Valid image bytes are persisted under `.opencode/veslo/outbox/generated-images/`.
4. `activeProvider !== "codex_oauth"` returns `not_configured` unless explicit fallback support is later configured.
5. A `policy_rejected` Codex response does not attempt fallback and does not write a file.

Use the existing `server.ai-gateway.test.ts` fake upstream style.

**Step 2: Run the tests to verify failure**

Run:

```bash
pnpm --filter veslo-server exec bun test src/server.image-generation.test.ts
```

Expected: FAIL because routes do not exist.

**Step 3: Add the local proxy route**

In `packages/server/src/server.ts`, add a route beside existing `codex_oauth` chat completions:

```ts
addRoute(routes, "POST", "/ai-gateway/providers/codex_oauth/v1/images/generations", "client", async (ctx) => {
  return proxyManagedAiRequest(ctx, {
    gatewayPath: "/providers/codex_oauth/v1/images/generations",
    auth: "gateway-token",
  });
});
```

If `proxyManagedAiRequest` currently assumes chat-completions behavior, keep the proxy generic and update tests around compression/header stripping only if needed.

**Step 4: Add the broker route**

Implement `POST /workspace/:id/image-generation`:

- require client auth and collaborator scope
- validate request with `validateImageGenerationRequest`
- require `x-veslo-gateway-token` when `activeProvider === "codex_oauth"`
- call the local managed AI proxy route or shared proxy helper
- normalize success/failure
- persist only valid `ok: true` image results
- record audit with provider, session id, request id, and artifact path
- return the core success/failure shape from this plan

**Step 5: Add capability metadata**

In `packages/server/src/types.ts`, extend capabilities:

```ts
media: {
  imageGeneration: {
    read: boolean;
    write: boolean;
    codexOauth: boolean;
    fallback: boolean;
  };
};
```

In `buildCapabilities`, set `write` from `!config.readOnly`, `codexOauth` to `true`, and `fallback` to `false` until a concrete fallback adapter is configured.

**Step 6: Document server routes**

In `packages/server/README.md`, add the two new routes and a short note that fallback never uses a hidden platform credential.

**Step 7: Run server focused tests**

Run:

```bash
pnpm --filter veslo-server exec bun test src/image-generation.test.ts src/server.image-generation.test.ts src/server.ai-gateway.test.ts
pnpm --filter veslo-server build
```

Expected: PASS.

**Step 8: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/types.ts packages/server/src/server.image-generation.test.ts packages/server/README.md
git commit -m "feat: add veslo image generation broker route"
```

---

### Task 6: Provision The Agent Tool

**Files:**

- Modify: `packages/server/src/internal-system.ts`
- Modify: `packages/server/src/internal-system.test.ts`
- Modify: `packages/desktop/src-tauri/src/workspace/internal_provision.rs`
- Test: `packages/server/src/delegate-plugin.e2e.test.ts` if plugin runtime assertions need updating

**Step 1: Write failing provisioning tests**

In `packages/server/src/internal-system.test.ts`, assert provisioning writes a plugin that contains `veslo_image_generate`, calls `/image-generation`, and does not contain hardcoded provider secrets.

```ts
expect(plugin).toContain("veslo_image_generate");
expect(plugin).toContain("/image-generation");
expect(plugin).not.toContain("gateway-access-token");
expect(plugin).not.toContain("codex-access-token");
```

Add the matching Rust provisioning assertion in `packages/desktop/src-tauri/src/workspace/internal_provision.rs`.

**Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter veslo-server exec bun test src/internal-system.test.ts
cd packages/desktop && cargo test internal_provision --manifest-path src-tauri/Cargo.toml
```

Expected: FAIL because the tool is not provisioned.

**Step 3: Implement the tool source**

Add the image tool to the managed internal plugin. The execute function should:

- resolve local server URL and client token from `process.env.VESLO_SERVER_URL` / `process.env.VESLO_TOKEN` when present
- fall back to parsing `opencode.jsonc` / `opencode.json` for a managed provider base URL and `options.apiKey`
- parse active model/provider from top-level `model`
- parse gateway token from model headers `x-veslo-gateway-token`
- use `context.sessionID` as the runtime session id
- call `POST /workspace/:activeId/image-generation`
- pass `Authorization: Bearer <client token>`
- pass `x-veslo-gateway-token` and `x-veslo-session-id` when available
- return a compact JSON string with `ok`, `path`, `mimeType`, `image`, and `metadata`

Tool args:

```ts
args: {
  prompt: tool.schema.string().describe("Detailed image prompt"),
  outputFormat: tool.schema.enum(["png", "jpeg", "webp"]).optional(),
  size: tool.schema.string().optional(),
  quality: tool.schema.enum(["low", "medium", "high", "auto"]).optional(),
}
```

Tool description must say it is for ordinary user requests to generate images and that it automatically saves the result.

**Step 4: Add OpenCode env injection in orchestrator**

Modify `packages/orchestrator/src/cli.ts` so `startOpencode` can receive:

```ts
vesloServerUrl?: string;
vesloToken?: string;
```

Pass `VESLO_SERVER_URL` and `VESLO_TOKEN` into the OpenCode process env when starting in normal local mode. This makes the tool reliable without parsing config when the orchestrator owns both processes.

**Step 5: Run provisioning tests**

Run:

```bash
pnpm --filter veslo-server exec bun test src/internal-system.test.ts
cd packages/desktop && cargo test internal_provision --manifest-path src-tauri/Cargo.toml
pnpm test:orchestrator
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/server/src/internal-system.ts packages/server/src/internal-system.test.ts packages/desktop/src-tauri/src/workspace/internal_provision.rs packages/orchestrator/src/cli.ts
git commit -m "feat: provision veslo image generation tool"
```

---

### Task 7: Transcript Rendering And Artifact Provenance

**Files:**

- Modify: `packages/server/src/session-artifacts.ts`
- Modify: `packages/server/src/session-artifacts.test.ts`
- Modify: `packages/app/src/app/components/part-view.tsx`
- Create: `packages/app/src/app/components/part-view-image-generation.test.ts`
- Modify: `packages/app/src/app/components/session/artifact-family-model.ts`
- Modify: `packages/app/src/app/components/session/artifact-family-model.test.ts`

**Step 1: Write failing artifact provenance test**

Add a server test where a tool part named `veslo_image_generate` has output JSON containing the saved path and media metadata. Assert it becomes a `files` artifact with `kind: "file_output"` and metadata `{ mediaKind: "image" }`.

**Step 2: Write failing PartView test**

Use a source test first if component rendering harness is not already available:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./part-view.tsx", import.meta.url), "utf8");

test("PartView renders veslo image generation tool output", () => {
  assert.match(source, /veslo_image_generate/);
  assert.match(source, /image_generation/);
  assert.match(source, /data:\$\{image\.mediaType\};base64/);
});
```

**Step 3: Run tests to verify failure**

Run:

```bash
pnpm --filter veslo-server exec bun test src/session-artifacts.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/part-view-image-generation.test.ts
```

Expected: FAIL.

**Step 4: Implement artifact derivation**

In `session-artifacts.ts`, treat `veslo_image_generate` as an output-producing tool. Parse `state.output` JSON safely and extract:

- `artifact.path`
- `path`
- `mimeType`
- `metadata.requestId`

Create a file artifact with `metadata.mediaKind = "image"` and `metadata.provider`.

**Step 5: Implement transcript rendering**

In `PartView`, add a memo that parses tool output JSON for `veslo_image_generate` and renders the `image` payload as an image preview before the raw output block. Reuse existing data URL logic:

```ts
const imageGenerationPreview = () => {
  if (p().type !== "tool") return null;
  const record = p() as any;
  if (record.tool !== "veslo_image_generate") return null;
  const output = toolOutput();
  try {
    const parsed = JSON.parse(output);
    const image = parsed?.image;
    if (!parsed?.ok || !image?.data || !image?.mediaType) return null;
    return {
      src: `data:${image.mediaType};base64,${image.data}`,
      alt: image.alt || "Generated image",
      path: parsed?.artifact?.path || parsed?.path || "",
    };
  } catch {
    return null;
  }
};
```

Render with stable dimensions and avoid layout shift.

**Step 6: Run focused tests**

Run:

```bash
pnpm --filter veslo-server exec bun test src/session-artifacts.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/part-view-image-generation.test.ts src/app/components/session/artifact-family-model.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/server/src/session-artifacts.ts packages/server/src/session-artifacts.test.ts packages/app/src/app/components/part-view.tsx packages/app/src/app/components/part-view-image-generation.test.ts packages/app/src/app/components/session/artifact-family-model.ts packages/app/src/app/components/session/artifact-family-model.test.ts
git commit -m "feat: render generated image artifacts"
```

---

### Task 8: App Client Types And Capability Surface

**Files:**

- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/lib/veslo-server.test.ts`
- Modify: `packages/app/src/app/components/session/session-capabilities-panel.tsx` only if image generation should appear in the right menu now
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`

**Step 1: Write failing client tests**

Add a `veslo-server.test.ts` test proving the client has a `generateImage` method that POSTs to `/workspace/:id/image-generation` and forwards gateway/session headers when provided.

**Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/veslo-server.test.ts
```

Expected: FAIL because the client method/types do not exist.

**Step 3: Add types and client method**

Add `VesloImageGenerationRequest`, `VesloImageGenerationResult`, and:

```ts
generateImage: (
  workspaceId: string,
  input: VesloImageGenerationRequest,
  options?: { gatewayToken?: string; sessionId?: string },
) => requestJson<VesloImageGenerationResult>(
  baseUrl,
  `/workspace/${encodeURIComponent(workspaceId)}/image-generation`,
  {
    token,
    hostToken,
    method: "POST",
    body: input,
    extraHeaders: {
      ...(options?.gatewayToken ? { "x-veslo-gateway-token": options.gatewayToken } : {}),
      ...(options?.sessionId ? { "x-veslo-session-id": options.sessionId } : {}),
    },
  },
)
```

**Step 4: Run focused app tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/veslo-server.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/veslo-server.ts packages/app/src/app/lib/veslo-server.test.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts
git commit -m "feat: add app image generation client contract"
```

---

### Task 9: Durable Docs

**Files:**

- Modify: `docs/dev/veslo-server-app-contract.md`
- Modify: `docs/features/session-runtime.md`
- Modify: `docs/features/extensions-and-integrations.md`
- Modify: `docs/dev/testing-playbook.md` only if the E2E command or fake backend env is new

**Step 1: Update canonical behavior docs**

Document:

- the broker route and managed gateway image route
- Codex OAuth first behavior
- no hidden platform fallback
- policy rejection no-fallback rule
- generated image artifact persistence
- media/preview direction

**Step 2: Verify docs mention shipped behavior**

Run:

```bash
rg -n "image generation|image-generation|veslo_image_generate|policy_rejected|generated-images" docs/dev docs/features
```

Expected: matches in canonical docs, not only `docs/plans`.

**Step 3: Commit**

```bash
git add docs/dev/veslo-server-app-contract.md docs/features/session-runtime.md docs/features/extensions-and-integrations.md docs/dev/testing-playbook.md
git commit -m "docs: document image generation broker behavior"
```

---

### Task 10: Desktop E2E Smoke With Fake Backend

**Files:**

- Create: `packages/e2e/specs/image-generation-broker.spec.ts`
- Create or modify: `packages/e2e/helpers/image-generation-backend.ts`
- Modify: `packages/e2e/wdio.conf.ts` only if new env plumbing is needed

**Step 1: Write the failing E2E spec**

The spec should:

1. Start or point Veslo at a fake managed AI backend that returns one base64 PNG for `/providers/codex_oauth/v1/images/generations`.
2. Open the real desktop runtime via the WebdriverIO harness.
3. Send a normal chat prompt such as `Generate a small red square image and save it.`
4. Wait for an inline image preview in the transcript.
5. Wait for an artifacts entry with an image filename.

Use test ids if they already exist; otherwise add minimal stable test ids in the UI during this task.

**Step 2: Run desktop preflight**

Run from repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If the process is internally started from this repo, stop it:

```bash
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Then verify:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Expected: no relevant process remains.

**Step 3: Build desktop E2E binary**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e
```

Expected: PASS.

**Step 4: Run the E2E spec and verify it fails before wiring**

Run:

```bash
cd packages/e2e
VESLO_E2E_FAKE_IMAGE_GENERATION=1 pnpm test --spec ./specs/image-generation-broker.spec.ts
```

Expected before implementation: FAIL because the image tool/route/UI is missing. Expected after prior tasks: PASS.

**Step 5: Commit**

```bash
git add packages/e2e/specs/image-generation-broker.spec.ts packages/e2e/helpers/image-generation-backend.ts packages/e2e/wdio.conf.ts
git commit -m "test: add image generation desktop smoke"
```

---

### Task 11: Final Verification And Server Binary

**Files:**

- No new files unless verification reveals required fixes.

**Step 1: Run all focused backend checks**

Run:

```bash
pnpm --filter veslo-server exec bun test src/image-generation.test.ts src/server.image-generation.test.ts src/server.ai-gateway.test.ts src/session-artifacts.test.ts src/internal-system.test.ts
pnpm --dir services/ai-gateway exec tsx --test test/codex-oauth-image-generation.test.ts test/codex-oauth-image-route.test.ts test/codex-oauth-inference-proxy-transport.test.ts
pnpm --dir services/den exec tsx --test test/managed-ai-codex-image-generation.test.ts test/managed-ai-codex-oauth-inference-proxy-transport.test.ts
```

Expected: PASS.

**Step 2: Run app checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/part-view-image-generation.test.ts src/app/components/session/artifact-family-model.test.ts src/app/lib/veslo-server.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 3: Rebuild server binary**

Run:

```bash
pnpm --filter veslo-server build:bin
```

Expected: PASS and `packages/server/dist/bin/veslo-server` is refreshed.

**Step 4: Run desktop E2E**

Run the desktop preflight from Task 10, then:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e

cd ../e2e
VESLO_E2E_FAKE_IMAGE_GENERATION=1 pnpm test --spec ./specs/image-generation-broker.spec.ts
```

Expected: PASS.

**Step 5: Broad sanity**

Run:

```bash
pnpm --filter veslo-server build
pnpm --dir services/ai-gateway build
pnpm --dir services/den build
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 6: Commit final fixes if any**

```bash
git status --short
git add <only files changed by final fixes>
git commit -m "fix: stabilize image generation broker"
```

Only commit if final verification required fixes.

---

## Explicit Follow-Up Boundaries

Do not expand the first slice into a general preview service for PDF/DOCX/HTML. Preserve the data model hooks, but implement only generated image preview/rendering.

Do not add a hidden OpenAI API-key fallback. If Codex OAuth is unavailable and no explicit fallback capability is configured, return `not_configured`.

Do not bypass provider policy refusals. `policy_rejected` is terminal for the request.

Do not treat UI-only Vite checks as runtime validation.
