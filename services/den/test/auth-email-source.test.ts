import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const currentFile = fileURLToPath(import.meta.url)
const serviceRoot = path.resolve(path.dirname(currentFile), "..")
const source = readFileSync(path.join(serviceRoot, "src", "auth.ts"), "utf8")
const verifiedSignupSource = readFileSync(path.join(serviceRoot, "src", "auth", "verified-signup.ts"), "utf8")
const indexSource = readFileSync(path.join(serviceRoot, "src", "index.ts"), "utf8")
const envSource = readFileSync(path.join(serviceRoot, "src", "env.ts"), "utf8")
const envExampleSource = readFileSync(path.join(serviceRoot, ".env.example"), "utf8")
const readmeSource = readFileSync(path.join(serviceRoot, "README.md"), "utf8")

test("auth config wires Better Auth verification and reset callbacks", () => {
  assert.equal(source.includes("emailVerification:"), true)
  assert.equal(source.includes("sendVerificationEmail:"), true)
  assert.equal(source.includes("sendOnSignUp: true"), true)
  assert.equal(source.includes("sendOnSignIn: true"), true)
  assert.equal(source.includes("await sendVerificationAuthEmail"), true)
  assert.equal(source.includes("sendResetPassword:"), true)
  assert.equal(source.includes("requireEmailVerification: env.authRequireEmailVerification"), true)
  assert.equal(source.includes("fireAndForgetAuthEmail(sendVerificationAuthEmail"), false)
  assert.equal(source.includes("fireAndForgetAuthEmail(sendResetPasswordAuthEmail"), true)
  assert.equal(source.includes('code: "VERIFICATION_EMAIL_DELIVERY_FAILED"'), true)
  assert.equal(source.includes("createVerificationDeliveryOutcomePlugin()"), true)
  assert.equal(source.includes('disabledPaths: ["/send-verification-email"]'), true)
  assert.equal(source.includes('ctx.path === "/send-verification-email"'), false)
  assert.equal(source.includes("maybeAssignDefaultManagedAiAccessForNewUser"), true)
  assert.equal(source.includes("afterEmailVerification:"), true)
  assert.equal(source.includes("provisionVerifiedSignupIdentity"), true)
})

test("den env exposes auth email provider configuration", () => {
  assert.equal(envSource.includes("LETTR_API_KEY"), true)
  assert.equal(envSource.includes("AUTH_EMAIL_ADDRESS"), true)
  assert.equal(envSource.includes("AUTH_EMAIL_FROM_NAME"), true)
  assert.equal(envSource.includes("authRequireEmailVerification"), true)
  assert.equal(envSource.includes("desktopAuthRequireEmailVerified: authRequireEmailVerification"), true)
})

test("auth config gates email callbacks behind explicit auth email configuration", () => {
  assert.equal(source.includes("const authEmailVerification = isAuthEmailConfigured()"), true)
  assert.equal(source.includes("autoSignInAfterVerification: false"), true)
  assert.equal(source.includes('...(authEmailVerification ? { emailVerification: authEmailVerification } : {})'), true)
  assert.equal(source.includes("emailAndPassword: {"), true)
  assert.equal(source.includes("enabled: true"), true)
  assert.equal(source.includes("requireEmailVerification: env.authRequireEmailVerification"), true)
})

test("email signup route is gated before Better Auth creates a user", () => {
  assert.equal(source.includes("guardEmailSignupRequest"), true)
  assert.equal(indexSource.includes("createAuthNodeHandler"), true)
  assert.equal(indexSource.includes("guardEmailSignupRequest"), true)
  assert.doesNotMatch(indexSource, /app\.all\("\/api\/auth\/\*", toNodeHandler\(auth\)\)/)
  assert.equal(indexSource.includes('app.all("/api/auth/*", asyncRoute(createAuthNodeHandler('), true)
  assert.equal(source.includes("AUTH_REQUEST_BODY_LIMIT_BYTES = 64 * 1024"), true)
})

test("auth user create hook gates before insert, activates organization access, and assigns managed AI last", () => {
  assert.equal(source.includes("runSignupAfterUserCreateSideEffects"), true)
  assert.equal(source.includes("authorizeSignupBeforeUserCreate"), true)
  assert.doesNotMatch(source, /pendingEmailSignupAccess/)
  assert.match(source, /before: async/)
  assert.match(source, /cleanupCreatedAuthUser/)
  assert.match(source, /ensureSignupOrganization/)
  assert.doesNotMatch(source, /import \{ ensureDefaultOrg \} from "\.\/orgs\.js"/)
  assert.match(source, /maybeAssignDefaultManagedAiAccessForNewUser/)
  const beforeHookIndex = source.indexOf("before: async")
  const afterHookIndex = source.indexOf("after: async")
  assert.ok(beforeHookIndex >= 0)
  assert.ok(afterHookIndex > beforeHookIndex)
  assert.ok(source.indexOf("authorizeSignupBeforeUserCreate", beforeHookIndex) < source.indexOf("runSignupAfterUserCreateSideEffects", afterHookIndex))
  assert.ok(source.lastIndexOf("runSignupAfterUserCreateSideEffects") < source.lastIndexOf("maybeAssignDefaultManagedAiAccessForNewUser"))
})

test("auth user creation defers unverified identities, provisions trusted verified identities, and preserves admin provisioning", () => {
  const afterHookIndex = source.indexOf("after: async (user, context)")
  assert.ok(afterHookIndex >= 0)
  const afterHookSource = source.slice(afterHookIndex, source.indexOf("},\n      },", afterHookIndex))

  assert.match(afterHookSource, /isAdminProvisioningSignupRequest\(context\)/)
  assert.match(afterHookSource, /emailVerified: user\.emailVerified === true/)
  assert.match(afterHookSource, /findExistingOrganizationId: findExistingActiveOrganizationId/)
  assert.match(afterHookSource, /runWithUserProvisioningLock/)
  assert.match(source, /afterEmailVerification: async \(user(?:[^)]*)\)/)
  assert.match(source, /await provisionVerifiedSignupIdentity/)
  assert.match(verifiedSignupSource, /GET_LOCK/)
  assert.match(verifiedSignupSource, /RELEASE_LOCK/)
})

test("auth activation cleanup removes only Better Auth rows for the created user", () => {
  const cleanupIndex = source.indexOf("async function cleanupCreatedAuthUser")
  assert.ok(cleanupIndex >= 0)
  const cleanupSource = source.slice(cleanupIndex)

  assert.equal(cleanupSource.includes("db.transaction"), true)
  assert.equal(cleanupSource.includes("schema.AuthSessionTable"), true)
  assert.equal(cleanupSource.includes("schema.AuthAccountTable"), true)
  assert.equal(cleanupSource.includes("schema.AuthVerificationTable"), true)
  assert.equal(cleanupSource.includes("schema.AuthUserTable"), true)
  assert.equal(cleanupSource.includes("schema.OrgMembershipTable"), false)
  assert.equal(cleanupSource.includes("schema.OrgTable"), false)
})

test("auth setup docs and sample config include email delivery settings", () => {
  assert.equal(envExampleSource.includes("LETTR_API_KEY="), true)
  assert.equal(envExampleSource.includes("AUTH_EMAIL_ADDRESS="), true)
  assert.equal(envExampleSource.includes("AUTH_EMAIL_FROM_NAME="), true)
  assert.match(envExampleSource, /# .*local.*email verification/i)
  assert.equal(envExampleSource.includes("DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=false"), true)
  assert.equal(readmeSource.includes("Lettr"), true)
  assert.equal(readmeSource.toLowerCase().includes("blank or unset values disable email verification and password reset delivery"), true)
})
