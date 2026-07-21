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
const repoRoot = path.resolve(serviceRoot, "../..")
const onboardingAuthSource = readFileSync(path.join(repoRoot, "docs", "features", "onboarding-and-auth.md"), "utf8")
const stateConfigSource = readFileSync(path.join(repoRoot, "docs", "dev", "state-and-config-reference.md"), "utf8")
const testingPlaybookSource = readFileSync(path.join(repoRoot, "docs", "dev", "testing-playbook.md"), "utf8")
const designSource = readFileSync(path.join(repoRoot, "docs", "plans", "2026-07-21-email-verification-hard-gate-design.md"), "utf8")

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
  assert.equal(source.includes('"VERIFICATION_EMAIL_DELIVERY_FAILED"'), true)
  assert.equal(source.includes("createVerificationDeliveryOutcomePlugin()"), true)
  assert.equal(source.includes('disabledPaths: ["/send-verification-email"]'), true)
  assert.equal(source.includes('ctx.path === "/send-verification-email"'), false)
  assert.equal(source.includes("createEmailVerificationToken"), false)
  assert.equal(source.includes("createVerificationEmailResendHandler"), false)
  assert.equal(indexSource.includes('app.post("/api/auth/send-verification-email"'), false)
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

test("verification delivery outcome is request scoped and preserves Better Auth credential checks", () => {
  assert.match(source, /WeakMap<Request, VerificationDeliveryOutcome>/)
  assert.equal(source.includes('ctx.path === "/sign-up/email"'), true)
  assert.equal(source.includes('ctx.path === "/sign-in/email"'), true)
  assert.equal(source.includes('status: "initialized"'), true)
  assert.equal(source.includes('outcome.status = "pending"'), true)
  assert.equal(source.includes('outcome.status = "accepted"'), true)
  assert.equal(source.includes('outcome.status = "failed"'), true)
  assert.match(source, /verificationDeliveryOutcomes\.delete\((?:ctx\.)?request\)/)
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
  assert.match(readmeSource, /Production DEN forces email verification on/)
  assert.match(readmeSource, /signup waits for Lettr to accept the verification message/i)
  assert.match(readmeSource, /30-second provider timeout/i)
  assert.match(readmeSource, /local development may explicitly set .*false/i)
})

test("auth configuration docs distinguish DEN runtime enforcement from deploy policy", () => {
  for (const [label, contents] of [
    ["DEN README", readmeSource],
    ["state and config reference", stateConfigSource],
    ["approved design", designSource],
  ] as const) {
    assert.match(
      contents,
      /production[\s\S]{0,160}(?:forces|resolves)[\s\S]{0,100}(?:verification|policy)[\s\S]{0,100}(?:enabled|true)[\s\S]{0,100}(?:raw|configured)[\s\S]{0,40}false/i,
      `${label} must say production DEN forces verification on even for a raw false value`,
    )
    assert.match(
      contents,
      /startup[\s\S]{0,160}(?:missing|absent|blank)[\s\S]{0,120}(?:mail|Lettr|transport|sender)[\s\S]{0,160}invalid[\s-]*(?:verification[\s-]*)?(?:flag|boolean|syntax|value)/i,
      `${label} must limit DEN startup failures to missing mail configuration or invalid flag syntax`,
    )
    assert.match(
      contents,
      /owned-server[\s\S]{0,180}(?:workflow|deployment)[\s\S]{0,180}(?:exactly|explicit)[\s\S]{0,80}true[\s\S]{0,120}(?:rejects?|fails?)[\s\S]{0,80}false/i,
      `${label} must distinguish the stricter owned-server deploy guard`,
    )
  }
  assert.doesNotMatch(readmeSource, /rejects startup when this value is false/i)
})

test("canonical auth docs keep verification delivery outcomes request scoped", () => {
  for (const [label, contents] of [
    ["DEN README", readmeSource],
    ["onboarding feature", onboardingAuthSource],
    ["state and config reference", stateConfigSource],
    ["approved design", designSource],
  ] as const) {
    assert.match(contents, /originating (?:native )?(?:signup|sign-in)[\s\S]{0,80}request/i, `${label} must name the request boundary`)
    assert.match(contents, /concurrent[\s\S]{0,100}(?:delivery|request)[\s\S]{0,80}cannot[\s\S]{0,80}(?:contaminate|change|override)/i, `${label} must explain isolation`)
  }
})

test("desktop preflight documents a truthful read-only sidecar ownership audit", () => {
  assert.doesNotMatch(testingPlaybookSource, /scripts\/veslo-kill-zombies\.sh/)
  assert.match(testingPlaybookSource, /ps -axo pid=,ppid=,pgid=,command=/)
  assert.match(testingPlaybookSource, /lsof -a -p "\$pid" -d cwd/)
  assert.match(testingPlaybookSource, /exact PID.*parent.*working directory.*command/i)
  assert.match(testingPlaybookSource, /terminate only.*internally started.*process/i)
})
