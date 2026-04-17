import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  CodexCliWorkerTransport,
  materializeCodexAuthJson,
} from "../src/providers/codex-cli-worker-transport.js"
import { ProviderTransportError } from "../src/providers/transport.js"

test("converts chat completion messages into a codex prompt and wraps the final answer", async () => {
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async ({ prompt, model }) => {
      assert.equal(model, "gpt-5.4")
      assert.equal(prompt, "system: Be brief.\n\nuser: Say ok.")
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        finalMessage: "ok",
        stdout: "",
        stderr: "",
      }
    },
    now: () => new Date("2026-04-13T10:00:00.000Z"),
    randomId: () => "codex-test-id",
  })

  const response = await transport.chatCompletions({
    body: {
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Say ok." },
      ],
    },
  })

  assert.equal(response.status, 200)
  assert.equal((response.body as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content, "ok")
})

test("returns OpenAI-compatible SSE chunks when Codex chat completion requests streaming", async () => {
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async ({ prompt, model }) => {
      assert.equal(model, "gpt-5.4")
      assert.equal(prompt, "user: Say stream ok.")
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        finalMessage: "stream ok",
        stdout: "",
        stderr: "",
      }
    },
    now: () => new Date("2026-04-13T10:00:00.000Z"),
    randomId: () => "codex-stream-test-id",
  })

  const response = await transport.chatCompletions({
    body: {
      model: "gpt-5.4",
      stream: true,
      messages: [{ role: "user", content: "Say stream ok." }],
    },
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers?.["content-type"], "text/event-stream")
  assert.match(String(response.body), /"object":"chat\.completion\.chunk"/)
  assert.match(String(response.body), /"content":"stream ok"/)
  assert.match(String(response.body), /data: \[DONE\]/)
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
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        finalMessage: "ok",
        stdout: "",
        stderr: "",
      }
    },
  })

  const response = await transport.chatCompletions({
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Say ok." }],
    },
    authJson: requestAuthJson,
  })

  assert.equal(response.status, 200)
})

test("materializes Codex auth JSON into the worker CODEX_HOME without logging secrets", async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), "veslo-ai-gateway-codex-home-test-"))
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
  const codexHome = await mkdtemp(path.join(tmpdir(), "veslo-ai-gateway-codex-home-test-"))

  try {
    await assert.rejects(
      () => materializeCodexAuthJson({ codexHome, authJson: "not-json" }),
      (error) => error instanceof ProviderTransportError && error.message === "codex_worker_auth_json_invalid",
    )
  } finally {
    await rm(codexHome, { recursive: true, force: true })
  }
})
