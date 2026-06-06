import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
})

const adminRuntime = await import("../src/http/admin-runtime.js")

test("bootstrap platform admin allowlist recognizes michal.sara@neatech.cz", () => {
  assert.equal(typeof adminRuntime.isBootstrapPlatformAdminEmail, "function")
  assert.equal(adminRuntime.isBootstrapPlatformAdminEmail("michal.sara@neatech.cz"), true)
  assert.equal(adminRuntime.isBootstrapPlatformAdminEmail("MICHAL.SARA@NEATECH.CZ"), true)
  assert.equal(adminRuntime.isBootstrapPlatformAdminEmail("someone@example.com"), false)
})

test("admin runtime forwards managed AI Codex status provider into route deps", async () => {
  const source = await readFile(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")

  assert.match(source, /codexStatusProvider:\s*options\.managedAi\.codexStatusProvider/)
})

test("admin-created users use the internal provisioning override for email signup", async () => {
  const source = await readFile(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")
  const signupFetch = source.match(/fetch\(`\$\{baseUrl\}\/api\/auth\/sign-up\/email`, \{[\s\S]*?body:/)?.[0] ?? ""

  assert.match(source, /createAdminProvisioningSignupHeaders/)
  assert.match(signupFetch, /\.\.\.createAdminProvisioningSignupHeaders\(\)/)
})
