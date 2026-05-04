import assert from "node:assert/strict"
import test from "node:test"

import { CodexOAuthInferenceProxyTransport } from "../src/managed-ai/providers/codex-oauth-inference-proxy-transport.js"
import { ProviderTransportError } from "../src/managed-ai/providers/transport.js"

test("managed ai codex oauth inference proxy forwards tool-capable requests with server-side auth", async () => {
  const body = {
    model: "gpt-5.5",
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
        JSON.stringify({
          id: "chatcmpl_codex_proxy_1",
          object: "chat.completion",
          model: "gpt-5.5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_read_file",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: "{\"path\":\"NDA.docx\"}",
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 5,
            total_tokens: 25,
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
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
  assert.equal(fetchCalls[0]?.url, "https://codex-inference.example.test/v1/chat/completions")
  assert.deepEqual(fetchCalls[0]?.init.headers, {
    "content-type": "application/json",
    authorization: "Bearer codex-access-token",
    "chatgpt-account-id": "acct_1",
  })
  assert.deepEqual(JSON.parse(String(fetchCalls[0]?.init.body)), body)
  assert.equal(response.headers?.["x-request-id"], "codex_proxy_req_1")
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
