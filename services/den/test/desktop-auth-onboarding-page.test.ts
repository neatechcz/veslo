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

  assert.equal(
    onboardingPage.includes("updateUI();\n                showError(errorMessage);"),
    true,
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

test("desktop onboarding page exposes verification and resend affordances", () => {
  assert.equal(onboardingPage.includes("/api/auth/send-verification-email"), true)
  assert.equal(onboardingPage.includes("emailVerified"), true)
  assert.equal(onboardingPage.includes('buildDesktopOnboardingUrl("verify-email")'), true)
})

test("desktop onboarding page uses Veslo auth copy", () => {
  assert.equal(onboardingPage.includes("Sign in to Veslo"), true)
  assert.equal(onboardingPage.includes("Openwork"), false)
})
