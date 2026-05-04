import assert from "node:assert/strict"
import test from "node:test"

import { CodexOAuthInferenceProxyTransport } from "../src/managed-ai/providers/codex-oauth-inference-proxy-transport.js"
import { ProviderTransportError } from "../src/managed-ai/providers/transport.js"

test("managed ai codex oauth inference proxy forwards tool-capable requests with server-side auth", async () => {
  const body = {
    model: "gpt-5.5",
    stream: false,
    messages: [{ role: "user", content: "Read a file." }],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      },
    ],
    tool_choice: "auto",
  }
  const fetchCalls: Array<{ url: string; init: RequestInit }> = []
  const transport = new CodexOAuthInferenceProxyTransport({
    baseUrl: "https://codex-inference.example.test",
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), init: init ?? {} })
      return new Response(
        makeResponsesSse([
          {
            event: "response.created",
            data: {
              type: "response.created",
              response: { id: "resp_codex_proxy_1", created_at: 1777906000, model: "gpt-5.5" },
            },
          },
          {
            event: "response.output_item.added",
            data: {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                id: "fc_1",
                type: "function_call",
                call_id: "call_read_file",
                name: "read_file",
                arguments: "",
              },
            },
          },
          {
            event: "response.function_call_arguments.delta",
            data: {
              type: "response.function_call_arguments.delta",
              output_index: 0,
              item_id: "fc_1",
              delta: "{\"path\":\"NDA.docx\"}",
            },
          },
          {
            event: "response.output_item.done",
            data: {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                id: "fc_1",
                type: "function_call",
                call_id: "call_read_file",
                name: "read_file",
                arguments: "{\"path\":\"NDA.docx\"}",
              },
            },
          },
          {
            event: "response.completed",
            data: {
              type: "response.completed",
              response: {
                id: "resp_codex_proxy_1",
                created_at: 1777906000,
                model: "gpt-5.5",
                usage: {
                  input_tokens: 20,
                  output_tokens: 5,
                  total_tokens: 25,
                  input_tokens_details: { cached_tokens: 3 },
                },
              },
            },
          },
        ]),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "codex_proxy_req_1",
          },
        },
      )
    },
  })

  const response = await transport.chatCompletions({
    body,
    authJson: JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "codex-access-token",
        refresh_token: "codex-refresh-token",
        account_id: "acct_1",
      },
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0]?.url, "https://codex-inference.example.test/backend-api/codex/responses")
  assert.deepEqual(fetchCalls[0]?.init.headers, {
    "content-type": "application/json",
    authorization: "Bearer codex-access-token",
    "chatgpt-account-id": "acct_1",
  })
  assert.deepEqual(JSON.parse(String(fetchCalls[0]?.init.body)), {
    model: "gpt-5.5",
    instructions: "You are a helpful coding assistant.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Read a file." }] }],
    tools: [
      {
        type: "function",
        name: "read_file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    ],
    tool_choice: "auto",
    stream: true,
    store: false,
  })
  assert.equal(response.headers?.["x-request-id"], "codex_proxy_req_1")
  assert.equal(response.headers?.["content-type"], "application/json")
  assert.deepEqual(
    (response.body as { choices: Array<{ message: { tool_calls?: unknown } }> }).choices[0]?.message.tool_calls,
    [
      {
        id: "call_read_file",
        type: "function",
        function: {
          name: "read_file",
          arguments: "{\"path\":\"NDA.docx\"}",
        },
      },
    ],
  )
  assert.deepEqual(response.usage, {
    inputTokens: 20,
    outputTokens: 5,
    cachedTokens: 3,
    totalTokens: 25,
  })
})

test("managed ai codex oauth inference proxy translates responses streaming to chat completion streaming", async () => {
  const transport = new CodexOAuthInferenceProxyTransport({
    baseUrl: "https://codex-inference.example.test",
    fetchImpl: async () =>
      new Response(
        makeResponsesSse([
          {
            event: "response.created",
            data: {
              type: "response.created",
              response: { id: "resp_stream_1", created_at: 1777907000, model: "gpt-5.5" },
            },
          },
          {
            event: "response.output_text.delta",
            data: {
              type: "response.output_text.delta",
              output_index: 0,
              delta: "Hotovo",
            },
          },
          {
            event: "response.output_text.delta",
            data: {
              type: "response.output_text.delta",
              output_index: 0,
              delta: " s mezerou.",
            },
          },
          {
            event: "response.completed",
            data: {
              type: "response.completed",
              response: {
                id: "resp_stream_1",
                created_at: 1777907000,
                model: "gpt-5.5",
                usage: {
                  input_tokens: 10,
                  output_tokens: 3,
                  total_tokens: 13,
                },
              },
            },
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
  })

  const response = await transport.chatCompletions({
    body: {
      model: "gpt-5.5",
      stream: true,
      messages: [
        { role: "system", content: "Use Czech." },
        { role: "user", content: "Say done." },
      ],
    },
    authJson: JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "codex-access-token",
        account_id: "acct_1",
      },
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers?.["content-type"], "text/event-stream")
  const sse = String(response.body)
  assert.match(sse, /^data: /m)
  assert.match(sse, /"object":"chat.completion.chunk"/)
  assert.match(sse, /"content":"Hotovo"/)
  assert.match(sse, /"content":" s mezerou\."/)
  assert.match(sse, /"finish_reason":"stop"/)
  assert.match(sse, /data: \[DONE\]/)
  assert.deepEqual(response.usage, {
    inputTokens: 10,
    outputTokens: 3,
    cachedTokens: 0,
    totalTokens: 13,
  })
})

test("managed ai codex oauth inference proxy fails before upstream when auth json has no access token", async () => {
  const transport = new CodexOAuthInferenceProxyTransport({
    fetchImpl: async () => {
      assert.fail("upstream fetch should not run without a server-side Codex access token")
    },
  })

  await assert.rejects(
    () =>
      transport.chatCompletions({
        body: {
          model: "gpt-5.5",
          messages: [{ role: "user", content: "hello" }],
        },
        authJson: JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            refresh_token: "codex-refresh-token",
            account_id: "acct_1",
          },
        }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderTransportError)
      assert.equal(error.code, "codex_oauth_access_token_required")
      assert.equal(error.statusCode, 503)
      return true
    },
  )
})

function makeResponsesSse(events: Array<{ event: string; data: unknown }>): string {
  return events.map((entry) => `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`).join("")
}
