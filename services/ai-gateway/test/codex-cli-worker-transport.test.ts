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

test("maps Codex token_count worker output to OpenAI-compatible usage", async () => {
  const tokenCountLine = JSON.stringify({
    payload: {
      type: "token_count",
      info: {
        input_tokens: 30,
        output_tokens: 9,
        total_tokens: 39,
        cached_tokens: 21,
      },
    },
  })
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async () => {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        finalMessage: "ok",
        stdout: `ignored\n${tokenCountLine}\n`,
        stderr: "",
      }
    },
    now: () => new Date("2026-04-13T10:00:00.000Z"),
    randomId: () => "codex-usage-test-id",
  })

  const response = await transport.chatCompletions({
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Say ok." }],
    },
  })

  assert.equal(response.status, 200)
  assert.deepEqual((response.body as { usage: unknown }).usage, {
    prompt_tokens: 30,
    completion_tokens: 9,
    total_tokens: 39,
    prompt_tokens_details: {
      cached_tokens: 21,
    },
  })
})

test("maps Codex total_token_usage worker output to OpenAI-compatible usage", async () => {
  const tokenCountLine = JSON.stringify({
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 40,
          output_tokens: 11,
          total_tokens: 51,
          cached_tokens: 22,
        },
      },
    },
  })
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      finalMessage: "ok",
      stdout: `${tokenCountLine}\n`,
      stderr: "",
    }),
    now: () => new Date("2026-04-13T10:00:00.000Z"),
    randomId: () => "codex-total-usage-test-id",
  })

  const response = await transport.chatCompletions({
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Say ok." }],
    },
  })

  assert.equal(response.status, 200)
  assert.deepEqual((response.body as { usage: unknown }).usage, {
    prompt_tokens: 40,
    completion_tokens: 11,
    total_tokens: 51,
    prompt_tokens_details: {
      cached_tokens: 22,
    },
  })
})

test("skips malformed newer Codex token_count output and uses older valid usage", async () => {
  const validTokenCountLine = JSON.stringify({
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
          cached_tokens: 8,
        },
      },
    },
  })
  const malformedTokenCountLine = JSON.stringify({
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: "unknown",
          output_tokens: null,
        },
      },
    },
  })
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      finalMessage: "ok",
      stdout: `${validTokenCountLine}\n${malformedTokenCountLine}\n`,
      stderr: "",
    }),
    now: () => new Date("2026-04-13T10:00:00.000Z"),
    randomId: () => "codex-skip-malformed-usage-test-id",
  })

  const response = await transport.chatCompletions({
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Say ok." }],
    },
  })

  assert.equal(response.status, 200)
  assert.deepEqual((response.body as { usage: unknown }).usage, {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
    prompt_tokens_details: {
      cached_tokens: 8,
    },
  })
})

test("maps Codex direct token_count fields and falls back to input plus output total", async () => {
  const tokenCountLine = JSON.stringify({
    payload: {
      type: "token_count",
      input_tokens: 13,
      output_tokens: 5,
      cached_tokens: 7,
    },
  })
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      finalMessage: "ok",
      stdout: `${tokenCountLine}\n`,
      stderr: "",
    }),
    now: () => new Date("2026-04-13T10:00:00.000Z"),
    randomId: () => "codex-direct-usage-test-id",
  })

  const response = await transport.chatCompletions({
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Say ok." }],
    },
  })

  assert.equal(response.status, 200)
  assert.deepEqual((response.body as { usage: unknown }).usage, {
    prompt_tokens: 13,
    completion_tokens: 5,
    total_tokens: 18,
    prompt_tokens_details: {
      cached_tokens: 7,
    },
  })
})

test("returns OpenAI-compatible SSE chunks when Codex chat completion requests streaming", async () => {
  const tokenCountLine = JSON.stringify({
    payload: {
      type: "token_count",
      info: {
        input_tokens: 17,
        output_tokens: 6,
        total_tokens: 23,
        cached_tokens: 11,
      },
    },
  })
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async ({ prompt, model }) => {
      assert.equal(model, "gpt-5.4")
      assert.equal(prompt, "user: Say stream ok.")
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        finalMessage: "stream ok",
        stdout: tokenCountLine,
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
  assert.deepEqual((response as { usage?: unknown }).usage, {
    inputTokens: 17,
    outputTokens: 6,
    cachedTokens: 11,
    totalTokens: 23,
  })
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

test("keeps Codex authentication failures as worker failures", async () => {
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      finalMessage: "",
      stdout: "",
      stderr: "Error running model gpt-5.6-sol: codex login required.\nAuthentication required.\n",
    }),
  })

  await assert.rejects(
    () =>
      transport.chatCompletions({
        body: {
          model: "gpt-5.6-sol",
          messages: [{ role: "user", content: "Say ok." }],
        },
      }),
    (error) => {
      assert(error instanceof ProviderTransportError)
      assert.equal(error.message, "codex_worker_failed")
      assert.deepEqual(error.body, {
        error: "codex_worker_failed",
        timedOut: false,
        exitCode: 1,
        stderrTail: "Error running model gpt-5.6-sol: codex login required.\nAuthentication required.",
      })
      return true
    },
  )
})

test("keeps mixed requested-model authentication failures as worker failures", async () => {
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      finalMessage: "",
      stdout: "",
      stderr: "Error: requested model gpt-5.6-sol; authentication token invalid, codex login required\n",
    }),
  })

  await assert.rejects(
    () =>
      transport.chatCompletions({
        body: {
          model: "gpt-5.6-sol",
          messages: [{ role: "user", content: "Say ok." }],
        },
      }),
    (error) => {
      assert(error instanceof ProviderTransportError)
      assert.equal(error.message, "codex_worker_failed")
      assert.deepEqual(error.body, {
        error: "codex_worker_failed",
        timedOut: false,
        exitCode: 1,
        stderrTail: "Error: requested model gpt-5.6-sol; authentication token invalid, codex login required",
      })
      return true
    },
  )
})

test("keeps explicit credential and token failures as worker failures", async () => {
  const authenticationErrors = [
    "Error: requested model gpt-5.6-sol; credentials invalid",
    "Error: requested model gpt-5.6-sol; invalid_grant",
    "Error: requested model gpt-5.6-sol; refresh-token invalid",
  ]

  for (const stderr of authenticationErrors) {
    const transport = new CodexCliWorkerTransport({
      spawnCodex: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        finalMessage: "",
        stdout: "",
        stderr,
      }),
    })

    await assert.rejects(
      () =>
        transport.chatCompletions({
          body: {
            model: "gpt-5.6-sol",
            messages: [{ role: "user", content: "Say ok." }],
          },
        }),
      (error) => error instanceof ProviderTransportError && error.message === "codex_worker_failed",
    )
  }
})

test("keeps unrelated provider errors that mention the requested model as worker failures", async () => {
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      finalMessage: "",
      stdout: "",
      stderr: "Error: requested model gpt-5.6-sol; provider request invalid\n",
    }),
  })

  await assert.rejects(
    () =>
      transport.chatCompletions({
        body: {
          model: "gpt-5.6-sol",
          messages: [{ role: "user", content: "Say ok." }],
        },
      }),
    (error) => error instanceof ProviderTransportError && error.message === "codex_worker_failed",
  )
})

test("returns an actionable runtime incompatibility error for an unsupported requested model", async () => {
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      finalMessage: "",
      stdout: "",
      stderr: "Error: unknown model gpt-5.6-sol\n",
    }),
  })

  await assert.rejects(
    () =>
      transport.chatCompletions({
        body: {
          model: "gpt-5.6-sol",
          messages: [{ role: "user", content: "Say ok." }],
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
      assert.match(body.error?.message ?? "", /gpt-5\.6-sol/)
      return true
    },
  )
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
    if (process.platform !== "win32") {
      assert.equal((await stat(authPath)).mode & 0o777, 0o600)
    }
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
