import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const currentFile = fileURLToPath(import.meta.url)
const serviceRoot = path.resolve(path.dirname(currentFile), "..")
const source = readFileSync(path.join(serviceRoot, "src", "auth.ts"), "utf8")
const envSource = readFileSync(path.join(serviceRoot, "src", "env.ts"), "utf8")
const envExampleSource = readFileSync(path.join(serviceRoot, ".env.example"), "utf8")
const readmeSource = readFileSync(path.join(serviceRoot, "README.md"), "utf8")

test("auth config wires Better Auth verification and reset callbacks", () => {
  assert.equal(source.includes("emailVerification:"), true)
  assert.equal(source.includes("sendVerificationEmail:"), true)
  assert.equal(source.includes("sendOnSignUp: true"), true)
  assert.equal(source.includes("sendResetPassword:"), true)
  assert.equal(source.includes("requireEmailVerification: false"), true)
})

test("den env exposes auth email provider configuration", () => {
  assert.equal(envSource.includes("RESEND_API_KEY"), true)
  assert.equal(envSource.includes("AUTH_EMAIL_FROM"), true)
})

test("auth config gates email callbacks behind explicit auth email configuration", () => {
  assert.equal(source.includes("const authEmailVerification = isAuthEmailConfigured()"), true)
  assert.equal(source.includes("autoSignInAfterVerification: false"), true)
  assert.equal(source.includes('...(authEmailVerification ? { emailVerification: authEmailVerification } : {})'), true)
  assert.equal(source.includes("emailAndPassword: {"), true)
  assert.equal(source.includes("enabled: true"), true)
  assert.equal(source.includes("requireEmailVerification: false"), true)
})

test("auth setup docs and sample config include email delivery settings", () => {
  assert.equal(envExampleSource.includes("RESEND_API_KEY="), true)
  assert.equal(envExampleSource.includes("AUTH_EMAIL_FROM="), true)
  assert.equal(readmeSource.toLowerCase().includes("blank or unset values disable email verification and password reset delivery"), true)
})
