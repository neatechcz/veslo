const accessToken = process.env.MANAGED_AI_CODEX_ACCESS_TOKEN?.trim() ?? ""
const baseUrl = (process.env.MANAGED_AI_CODEX_TEST_BASE_URL ?? "https://api.openai.com").replace(/\/+$/, "")
const model = process.env.MANAGED_AI_CODEX_TEST_MODEL?.trim() || "gpt-5.4"

if (!accessToken) {
  throw new Error("MANAGED_AI_CODEX_ACCESS_TOKEN is required")
}

const response = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    max_tokens: 8,
  }),
})

const text = await response.text()
console.log(
  JSON.stringify(
    {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: text.slice(0, 2000),
    },
    null,
    2,
  ),
)

if (!response.ok) {
  process.exitCode = 1
}
