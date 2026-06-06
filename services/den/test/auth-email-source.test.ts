import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const currentFile = fileURLToPath(import.meta.url)
const serviceRoot = path.resolve(path.dirname(currentFile), "..")
const source = readFileSync(path.join(serviceRoot, "src", "auth.ts"), "utf8")
const indexSource = readFileSync(path.join(serviceRoot, "src", "index.ts"), "utf8")
const envSource = readFileSync(path.join(serviceRoot, "src", "env.ts"), "utf8")
const envExampleSource = readFileSync(path.join(serviceRoot, ".env.example"), "utf8")
const readmeSource = readFileSync(path.join(serviceRoot, "README.md"), "utf8")

test("auth config wires Better Auth verification and reset callbacks", () => {
  assert.equal(source.includes("emailVerification:"), true)
  assert.equal(source.includes("sendVerificationEmail:"), true)
  assert.equal(source.includes("sendOnSignUp: true"), true)
  assert.equal(source.includes("sendResetPassword:"), true)
  assert.equal(source.includes("requireEmailVerification: false"), true)
  assert.equal(source.includes("maybeAssignDefaultManagedAiAccessForNewUser"), true)
})

test("den env exposes auth email provider configuration", () => {
  assert.equal(envSource.includes("LETTR_API_KEY"), true)
  assert.equal(envSource.includes("AUTH_EMAIL_ADDRESS"), true)
  assert.equal(envSource.includes("AUTH_EMAIL_FROM_NAME"), true)
})

test("auth config gates email callbacks behind explicit auth email configuration", () => {
  assert.equal(source.includes("const authEmailVerification = isAuthEmailConfigured()"), true)
  assert.equal(source.includes("autoSignInAfterVerification: false"), true)
  assert.equal(source.includes('...(authEmailVerification ? { emailVerification: authEmailVerification } : {})'), true)
  assert.equal(source.includes("emailAndPassword: {"), true)
  assert.equal(source.includes("enabled: true"), true)
  assert.equal(source.includes("requireEmailVerification: false"), true)
})

test("email signup route is gated before Better Auth creates a user", () => {
  assert.equal(source.includes("guardEmailSignupRequest"), true)
  assert.equal(indexSource.includes("createAuthNodeHandler"), true)
  assert.equal(indexSource.includes("guardEmailSignupRequest"), true)
  assert.doesNotMatch(indexSource, /app\.all\("\/api\/auth\/\*", toNodeHandler\(auth\)\)/)
})

test("auth post-create hook activates organization membership before managed AI and only creates default org as fallback", () => {
  assert.equal(source.includes("completeSignupAfterUserCreate"), true)
  assert.match(source, /if \(!signupResult\.activatedOrganizationMembership\)/)
  assert.match(source, /ensureDefaultOrg/)
  assert.match(source, /maybeAssignDefaultManagedAiAccessForNewUser/)
  assert.ok(source.lastIndexOf("completeSignupAfterUserCreate") < source.lastIndexOf("maybeAssignDefaultManagedAiAccessForNewUser"))
})

test("auth setup docs and sample config include email delivery settings", () => {
  assert.equal(envExampleSource.includes("LETTR_API_KEY="), true)
  assert.equal(envExampleSource.includes("AUTH_EMAIL_ADDRESS="), true)
  assert.equal(envExampleSource.includes("AUTH_EMAIL_FROM_NAME="), true)
  assert.equal(readmeSource.includes("Lettr"), true)
  assert.equal(readmeSource.toLowerCase().includes("blank or unset values disable email verification and password reset delivery"), true)
})
