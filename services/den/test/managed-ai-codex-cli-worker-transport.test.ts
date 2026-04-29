import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  CodexCliWorkerTransport,
  materializeCodexAuthJson,
} from "../src/managed-ai/providers/codex-cli-worker-transport.js"
import { ProviderTransportError } from "../src/managed-ai/providers/transport.js"

test("converts chat completion messages into a codex prompt and wraps the final answer", async () => {
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async (input) => {
      assert.match(input.prompt, /system: You are concise/)
      assert.match(input.prompt, /user: Say ok/)
      assert.equal(input.model, "gpt-5.4")
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
  const body = response.body as any

  assert.equal(response.status, 200)
  assert.equal(body.model, "gpt-5.4")
  assert.equal(body.choices[0].message.role, "assistant")
  assert.equal(body.choices[0].message.content, "ok")
  assert.equal(body.usage, null)
})

test("rejects streaming requests until streaming is implemented", async () => {
  const transport = new CodexCliWorkerTransport({ spawnCodex: async () => unreachable() })

  await assert.rejects(
    () => transport.chatCompletions({ body: { model: "gpt-5.4", stream: true, messages: [] } }),
    (error) => error instanceof ProviderTransportError && error.message === "codex_streaming_not_supported",
  )
})

test("passes per-request Codex auth JSON to the worker runner", async () => {
  const requestAuthJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: "request-refresh-token",
      account_id: "acct_request",
    },
  })
  const transport = new CodexCliWorkerTransport({
    authJson: JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        refresh_token: "env-refresh-token",
        account_id: "acct_env",
      },
    }),
    spawnCodex: async (input) => {
      assert.equal(input.authJson, requestAuthJson)
      return { exitCode: 0, signal: null, timedOut: false, finalMessage: "ok", stdout: "", stderr: "" }
    },
  })

  const response = await transport.chatCompletions({
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Say ok" }],
    },
    authJson: requestAuthJson,
  })

  assert.equal(response.status, 200)
})

test("includes worker stderr tail when the Codex CLI exits unsuccessfully", async () => {
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      finalMessage: "",
      stdout: "",
      stderr: "Error: Please run `codex login`.\nAuthentication required.\n",
    }),
  })

  await assert.rejects(
    () =>
      transport.chatCompletions({
        body: {
          model: "gpt-5.4",
          messages: [{ role: "user", content: "Say ok" }],
        },
      }),
    (error) => {
      assert(error instanceof ProviderTransportError)
      assert.equal(error.message, "codex_worker_failed")
      assert.deepEqual(error.body, {
        error: "codex_worker_failed",
        timedOut: false,
        exitCode: 1,
        stderrTail: "Error: Please run `codex login`.\nAuthentication required.",
      })
      return true
    },
  )
})

test("returns an actionable runtime incompatibility error when gpt-5.5 is unsupported", async () => {
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      finalMessage: "",
      stdout: "",
      stderr: "Error: unknown model gpt-5.5\n",
    }),
  })

  await assert.rejects(
    () =>
      transport.chatCompletions({
        body: {
          model: "gpt-5.5",
          messages: [{ role: "user", content: "Say ok" }],
        },
      }),
    (error) => {
      assert(error instanceof ProviderTransportError)
      assert.equal(error.message, "codex_runtime_incompatible")
      assert.equal(error.statusCode, 502)
      const body = error.body as {
        error?: {
          code?: string
          type?: string
          message?: string
        }
      }
      assert.equal(body.error?.code, "codex_runtime_incompatible")
      assert.equal(body.error?.type, "runtime_incompatible")
      assert.match(body.error?.message ?? "", /gpt-5\.5/)
      return true
    },
  )
})

test("materializes Codex auth JSON into the worker CODEX_HOME without logging secrets", async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), "veslo-codex-home-test-"))
  const authJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: "test-refresh-token",
      account_id: "acct_123",
    },
  })

  try {
    assert.equal(await materializeCodexAuthJson({ codexHome, authJson }), true)

    const authPath = path.join(codexHome, "auth.json")
    assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), JSON.parse(authJson))
    assert.equal((await stat(authPath)).mode & 0o777, 0o600)
  } finally {
    await rm(codexHome, { recursive: true, force: true })
  }
})

test("rejects invalid Codex auth JSON before writing worker credentials", async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), "veslo-codex-home-test-"))

  try {
    await assert.rejects(
      () => materializeCodexAuthJson({ codexHome, authJson: "not-json" }),
      (error) => error instanceof ProviderTransportError && error.message === "codex_worker_auth_json_invalid",
    )
  } finally {
    await rm(codexHome, { recursive: true, force: true })
  }
})

function unreachable(): never {
  throw new Error("unreachable")
}
