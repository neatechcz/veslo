import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const currentFile = fileURLToPath(import.meta.url)
const serviceRoot = path.resolve(path.dirname(currentFile), "..")
const onboardingPage = readFileSync(path.join(serviceRoot, "public", "index.html"), "utf8")

test("desktop onboarding page exposes a manual deep-link fallback CTA", () => {
  assert.equal(
    onboardingPage.includes('id="onboard-open-app"'),
    true,
    "onboarding page must render an explicit Open App fallback link",
  )

  assert.equal(
    onboardingPage.includes("openAppLink.href = redirectUrl"),
    true,
    "onboarding script must assign the runtime redirectUrl to the fallback link",
  )

  assert.equal(
    onboardingPage.includes("openAppHint.classList.remove(\"hidden\")"),
    true,
    "onboarding script must show fallback guidance before triggering protocol navigation",
  )
})

test("desktop onboarding page requests JSON authorize transport and keeps authorize errors visible", () => {
  assert.equal(
    onboardingPage.includes('"x-veslo-desktop-auth-transport": "json"'),
    true,
    "onboarding authorize fetch must opt into JSON transport for deep links",
  )

  assert.equal(
    onboardingPage.includes("authorizeResponse.status === 200"),
    true,
    "onboarding page must accept a JSON authorize success response",
  )

  assert.match(
    onboardingPage,
    /updateUI\(\);[\s\S]*?showError\(errorMessage\);/,
    "onboarding page must restore the form before rendering the authorize error",
  )

  assert.equal(
    onboardingPage.includes("showError(errorMessage);\n                updateUI();"),
    false,
    "onboarding page must not hide the authorize error immediately after showing it",
  )
})

test("desktop onboarding page exposes forgot-password and reset-password browser flows", () => {
  assert.equal(onboardingPage.includes("Forgot password?"), true)
  assert.equal(onboardingPage.includes("/api/auth/request-password-reset"), true)
  assert.equal(onboardingPage.includes("/api/auth/reset-password"), true)
  assert.equal(onboardingPage.includes('search.get("token")'), true)
})

test("desktop reset password keeps the reset token out of visible UI and browser history", () => {
  assert.equal(onboardingPage.includes('for="reset-password-token"'), false)
  assert.equal(onboardingPage.includes('id="reset-password-token"'), false)
  assert.equal(onboardingPage.includes("resetTokenInput.value"), false)
  assert.equal(onboardingPage.includes("scrubResetPasswordTokenFromLocation()"), true)
  assert.equal(onboardingPage.includes('url.searchParams.delete("token")'), true)
})

test("desktop reset password signs in and completes handoff after password update", () => {
  assert.equal(onboardingPage.includes("storeResetPasswordEmail(trimmedEmail)"), true)
  assert.equal(onboardingPage.includes("signInAfterPasswordReset(resetPasswordInput.value)"), true)
  assert.equal(onboardingPage.includes('await doHandoff("reset-password")'), true)
  assert.equal(onboardingPage.includes("Return to sign in and use the new password."), false)
})

test("desktop onboarding page exposes verification and resend affordances", () => {
  assert.equal(onboardingPage.includes("/api/auth/send-verification-email"), false)
  assert.equal(onboardingPage.includes('id="verify-required-form"'), true)
  assert.equal(onboardingPage.includes('id="verify-required-password"'), true)
  assert.equal(onboardingPage.includes('autocomplete="current-password"'), true)
  assert.equal(onboardingPage.includes('fetch("/api/auth/sign-in/email"'), true)
  assert.equal(onboardingPage.includes('id="verify-required-card"'), true)
  assert.equal(onboardingPage.includes('buildDesktopOnboardingUrl("verify-email")'), true)
})

test("verification resend password is cleared around every recovery attempt", () => {
  assert.match(onboardingPage, /function showVerificationRequired[\s\S]*verifyRequiredPassword\.value = ""/)
  assert.match(onboardingPage, /finally \{[\s\S]*verifyRequiredPassword\.value = ""/)
})

test("unverified browser auth cannot continue to Veslo", () => {
  assert.equal(onboardingPage.includes('id="continue-to-veslo"'), false)
  assert.equal(onboardingPage.includes("continueToVesloBtn"), false)
  assert.equal(onboardingPage.includes("You can still continue to Veslo right now"), false)
  assert.equal(onboardingPage.includes("cloud-gated actions still require"), false)
  assert.equal(
    onboardingPage.includes("Verify this email address before signing in to Veslo."),
    true,
  )
})

test("tokenless signup and unverified sign-in share one verification recovery transition", () => {
  assert.equal(onboardingPage.includes("function showVerificationRequired("), true)
  assert.equal(onboardingPage.includes('"EMAIL_NOT_VERIFIED"'), true)
  assert.equal(onboardingPage.includes('"verification_email_delivery_failed"'), true)
  assert.equal(onboardingPage.includes('fetch("/v1/me"'), false)
  assert.match(
    onboardingPage,
    /if \(!bearerToken\)[\s\S]+showVerificationRequired\([\s\S]+submittedMode === "sign-up"/,
    "a tokenless signup must enter verification recovery without probing an authenticated session",
  )
})

test("only a successful sign-in or opt-out signup with a non-empty token can hand off to Veslo", () => {
  assert.match(
    onboardingPage,
    /if \(!bearerToken\)[\s\S]+showVerificationRequired\([\s\S]+return;[\s\S]+await doHandoff\("auth"\)/,
  )
})

test("desktop onboarding page uses Veslo auth copy", () => {
  assert.equal(onboardingPage.includes("Sign in to Veslo"), true)
  assert.equal(onboardingPage.includes("Openwork"), false)
})

test("desktop email sign-up explains the company email requirement", () => {
  const companyEmailMessage =
    "Use your company email to register. Personal email addresses are not supported. If your organization invited you, open the registration link from that invitation."

  assert.equal(
    onboardingPage.split(companyEmailMessage).length - 1,
    1,
    "the approved company-email guidance must have one source of truth",
  )
  assert.equal(onboardingPage.includes("function formatEmailSignUpError(data, status)"), true)
  assert.equal(
    onboardingPage.includes(
      '[data?.code, data?.error, data?.message].some((value) => value === "domain_not_allowed")',
    ),
    true,
    "sign-up errors must recognize the stable code in every supported response field",
  )
  assert.match(
    onboardingPage,
    /if \(submittedMode === "sign-up"\) \{\s+showError\(formatEmailSignUpError\(data, response\.status\)\);\s+\} else \{\s+showError\(data\?\.message \|\| data\?\.error \|\| `Request failed \(\$\{response\.status\}\)`\);\s+\}/,
    "only the email sign-up failure branch should use the company-email formatter",
  )
})

test("desktop auth submit handling stays bound to the submitted mode", () => {
  const handlerStart = onboardingPage.indexOf('form.addEventListener("submit"')
  const handlerEnd = onboardingPage.indexOf('forgotForm.addEventListener("submit"', handlerStart)
  const submitHandler = onboardingPage.slice(handlerStart, handlerEnd)

  assert.notEqual(handlerStart, -1)
  assert.notEqual(handlerEnd, -1)
  assert.equal(submitHandler.includes("const submittedMode = mode;"), true)
  assert.equal(submitHandler.includes('const endpoint = submittedMode === "sign-up"'), true)
  assert.match(
    submitHandler,
    /if \(submittedMode === "sign-up"\) \{\s+body\.name =/,
    "the submitted mode must select sign-up request fields",
  )
  assert.match(
    submitHandler,
    /if \(submittedMode === "sign-up"\) \{\s+showError\(formatEmailSignUpError/,
    "the submitted mode must select sign-up error formatting",
  )
  assert.match(
    submitHandler,
    /showVerificationRequired\([\s\S]*?submittedMode === "sign-up"[\s\S]*?Verification email sent/,
    "the submitted mode must select request-specific follow-up copy",
  )
  assert.equal(
    /(?:const endpoint =|if \(|showVerificationRequired\() mode === "sign-up"/.test(submitHandler),
    false,
    "async request handling must not consult the mutable UI mode",
  )
  assert.equal(submitHandler.includes("toggleBtn.disabled = true;"), true)
  assert.equal(submitHandler.includes("toggleBtn.disabled = false;"), true)
})

test("desktop onboarding captures and scrubs signup invitations in session storage", () => {
  assert.equal(onboardingPage.includes('const SIGNUP_INVITATION_SESSION_STORAGE_KEY = "veslo:signup-invite-token";'), true)
  assert.equal(onboardingPage.includes("captureSignupInvitationFromLocation();"), true)
  assert.equal(onboardingPage.includes("window.sessionStorage.setItem(SIGNUP_INVITATION_SESSION_STORAGE_KEY"), true)
  assert.equal(onboardingPage.includes('url.searchParams.delete("inviteToken")'), true)
  assert.equal(onboardingPage.includes('fragmentParams.delete("inviteToken")'), true)
  assert.equal(onboardingPage.includes("window.history.replaceState({}, \"\", url.toString())"), true)
  assert.match(
    onboardingPage,
    /if \(inviteToken\) \{[\s\S]*?sessionStorage\.setItem[\s\S]*?\} else if \(hadInvitationParameter\) \{[\s\S]*?sessionStorage\.removeItem/,
    "an invalid incoming token must not leave a stale invitation active",
  )
  assert.equal(onboardingPage.includes("window.localStorage.setItem(SIGNUP_INVITATION_SESSION_STORAGE_KEY"), false)
})

test("desktop email signup sends and consumes invitation state only on success", () => {
  const handlerStart = onboardingPage.indexOf('form.addEventListener("submit"')
  const handlerEnd = onboardingPage.indexOf('forgotForm.addEventListener("submit"', handlerStart)
  const submitHandler = onboardingPage.slice(handlerStart, handlerEnd)

  assert.match(
    submitHandler,
    /if \(submittedMode === "sign-up"\) \{[\s\S]*?const signupInviteToken = readStoredSignupInvitation\(\);[\s\S]*?body\.inviteToken = signupInviteToken;/,
  )
  assert.match(
    submitHandler,
    /if \(!response\.ok\) \{[\s\S]*?return;[\s\S]*?if \(submittedMode === "sign-up"\) \{\s+clearStoredSignupInvitation\(\);\s+\}/,
    "invitation state must survive recoverable errors and clear after signup succeeds",
  )
  assert.equal(
    /submittedMode === "sign-in"[\s\S]{0,200}inviteToken/.test(submitHandler),
    false,
    "sign-in bodies must never include an invitation token",
  )
})

test("desktop onboarding inline script remains valid JavaScript", () => {
  const inlineScript = onboardingPage.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(inlineScript)
  assert.doesNotThrow(() => new Function(inlineScript))
})

test("desktop onboarding page does not ship the public control-plane demo", () => {
  for (const forbiddenText of [
    "Den Control Plane Demo",
    "TestPass123!",
    "GET /v1/me",
    "POST /v1/workers",
  ]) {
    assert.equal(
      onboardingPage.includes(forbiddenText),
      false,
      `desktop onboarding page must not include ${forbiddenText}`,
    )
  }
})
