import assert from "node:assert/strict"
import test from "node:test"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
  MANAGED_AI_DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_ai_gateway",
  MANAGED_AI_SECRET_KEY: "abcdefghijklmnopqrstuvwxyz123456",
})

for (const key of [
  "MANAGED_AI_OPENAI_CLIENT_ID",
  "MANAGED_AI_OPENAI_CLIENT_SECRET",
  "MANAGED_AI_OPENAI_REDIRECT_BASE",
]) {
  delete process.env[key]
}

const { createDefaultProxyDependencies, createDefaultRuntimeState } = await import("../src/managed-ai/runtime/default-runtime.js")

test("default managed ai proxy dependencies allow codex-only runtime without OpenAI OAuth fallback config", () => {
  const runtime = createDefaultRuntimeState({
    db: {},
    secretKey: "abcdefghijklmnopqrstuvwxyz123456",
  })

  const deps = createDefaultProxyDependencies(runtime)

  assert.equal(typeof deps.codexOAuthTransport.chatCompletions, "function")
})
