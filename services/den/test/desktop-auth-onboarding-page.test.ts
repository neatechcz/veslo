import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath } from "node:url"

const currentFile = fileURLToPath(import.meta.url)
const serviceRoot = path.resolve(path.dirname(currentFile), "..")
const onboardingPage = readFileSync(path.join(serviceRoot, "public", "index.html"), "utf8")

type FakeEventListener = (event: { preventDefault(): void }) => unknown | Promise<unknown>

function createOnboardingRuntime(fetchImplementation: typeof fetch) {
  const listeners = new Map<string, Map<string, FakeEventListener>>()
  const elements = new Map<string, {
    classList: {
      add(name: string): void
      remove(name: string): void
      toggle(name: string, force?: boolean): void
      contains(name: string): boolean
    }
    value: string
    textContent: string
    autocomplete: string
    disabled: boolean
    required: boolean
    href: string
    focus(): void
    addEventListener(type: string, listener: FakeEventListener): void
  }>()

  for (const [, id] of onboardingPage.matchAll(/id="([^"]+)"/g)) {
    const classNames = new Set<string>()
    elements.set(id, {
      classList: {
        add: (name) => classNames.add(name),
        remove: (name) => classNames.delete(name),
        toggle: (name, force) => {
          if (force === undefined ? !classNames.has(name) : force) classNames.add(name)
          else classNames.delete(name)
        },
        contains: (name) => classNames.has(name),
      },
      value: "",
      textContent: "",
      autocomplete: "",
      disabled: false,
      required: false,
      href: "#",
      focus() {},
      addEventListener(type, listener) {
        const elementListeners = listeners.get(id) ?? new Map<string, FakeEventListener>()
        elementListeners.set(type, listener)
        listeners.set(id, elementListeners)
      },
    })
  }

  const storedValues = new Map<string, string>()
  const locationUrl = new URL("https://auth.example.test/?desktopOnboarding=1&intent=signup&tid=tx-1&state=state-1")
  const window = {
    location: {
      search: locationUrl.search,
      href: locationUrl.toString(),
      assign() {},
    },
    history: { replaceState() {} },
    localStorage: {
      getItem: (key: string) => storedValues.get(key) ?? null,
      setItem: (key: string, value: string) => storedValues.set(key, value),
      removeItem: (key: string) => storedValues.delete(key),
    },
  }
  const document = {
    getElementById(id: string) {
      const element = elements.get(id)
      assert.ok(element, `missing fake element ${id}`)
      return element
    },
  }
  const script = onboardingPage.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script, "onboarding page must contain its runtime script")
  vm.runInNewContext(script, {
    console,
    document,
    fetch: fetchImplementation,
    Response,
    URL,
    URLSearchParams,
    window,
  })

  return {
    element(id: string) {
      const element = elements.get(id)
      assert.ok(element)
      return element
    },
    async submit(id: string) {
      const listener = listeners.get(id)?.get("submit")
      assert.ok(listener, `missing submit listener for ${id}`)
      await listener({ preventDefault() {} })
    },
    storedValues,
  }
}

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
  assert.equal(onboardingPage.includes("verifyRequiredPassword.value = \"\""), true)
  assert.equal(onboardingPage.includes("emailVerified"), true)
  assert.equal(onboardingPage.includes('buildDesktopOnboardingUrl("verify-email")'), true)
})

test("verification gate has recovery actions but no pre-verification Veslo handoff", () => {
  assert.equal(onboardingPage.includes('id="continue-to-veslo"'), false)
  assert.equal(onboardingPage.includes("Continue to Veslo"), false)
  assert.equal(onboardingPage.includes("You can still continue to Veslo right now."), false)
  assert.match(onboardingPage, /Verify your email before continuing to Veslo\./)
  assert.match(onboardingPage, /Retry sending verification email/)
})

test("signup delivery failure enters in-memory credential recovery and clears it after resend", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const runtime = createOnboardingRuntime(async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    requests.push({ url, body })

    if (requests.length === 1) {
      return new Response(JSON.stringify({
        code: "VERIFICATION_EMAIL_DELIVERY_FAILED",
        message: "We could not send the verification email. Please try again.",
      }), {
        status: 502,
        headers: { "content-type": "application/json" },
      })
    }

    return new Response(JSON.stringify({
      code: "EMAIL_NOT_VERIFIED",
      message: "Email not verified",
    }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })
  })
  const email = "created-after-mail-failure@example.test"
  const password = "correct-horse-battery-staple"
  runtime.element("auth-email").value = email
  runtime.element("auth-password").value = password
  runtime.element("auth-name").value = "Mail Recovery"

  await runtime.submit("auth-form")

  assert.equal(runtime.element("verify-required-card").classList.contains("hidden"), false)
  assert.equal(runtime.element("onboard-form").classList.contains("hidden"), true)
  assert.equal(runtime.element("auth-password").value, "")
  assert.equal(runtime.element("verify-required-password").value, "")
  assert.equal(
    [...runtime.storedValues.values()].some((value) => value.includes(email) || value.includes(password)),
    false,
    "recovery credentials must not be persisted",
  )

  await runtime.submit("verify-required-form")

  assert.deepEqual(requests.map(({ url }) => url), [
    "/api/auth/sign-up/email",
    "/api/auth/sign-in/email",
  ])
  assert.deepEqual(requests[1]?.body, {
    email,
    password,
    callbackURL: "https://auth.example.test/?desktopOnboarding=1&intent=signup&tid=tx-1&state=state-1&view=verify-email",
  })
  assert.equal(runtime.element("verify-required-password").value, "")

  await runtime.submit("verify-required-form")
  assert.equal(requests.length, 2, "accepted resend must clear the in-memory recovery password")
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
  assert.equal(
    submitHandler.includes('verificationInfo = submittedMode === "sign-up"'),
    true,
    "the submitted mode must select request-specific follow-up copy",
  )
  assert.equal(
    /(?:const endpoint =|if \(|verificationInfo =) mode === "sign-up"/.test(submitHandler),
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
