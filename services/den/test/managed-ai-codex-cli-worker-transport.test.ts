import assert from "node:assert/strict"
import test from "node:test"

import { CodexCliWorkerTransport } from "../src/managed-ai/providers/codex-cli-worker-transport.js"
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

function unreachable(): never {
  throw new Error("unreachable")
}
