import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8")
const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
if (!script) throw new Error("onboarding script not found")

class FakeElement {
  value = ""
  textContent = ""
  disabled = false
  autocomplete = ""
  href = "#"
  readonly listeners = new Map<string, Array<(event: { preventDefault(): void }) => unknown>>()
  readonly classes = new Set(["hidden"])
  readonly classList = {
    add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
    toggle: (name: string, force?: boolean) => {
      const shouldAdd = force ?? !this.classes.has(name)
      if (shouldAdd) this.classes.add(name)
      else this.classes.delete(name)
      return shouldAdd
    },
  }

  addEventListener(name: string, listener: (event: { preventDefault(): void }) => unknown) {
    const listeners = this.listeners.get(name) ?? []
    listeners.push(listener)
    this.listeners.set(name, listeners)
  }

  focus() {}

  async dispatch(name: string) {
    for (const listener of this.listeners.get(name) ?? []) {
      await listener({ preventDefault() {} })
    }
  }
}

function createBrowserHarness(input: {
  initialUrl: string
  respond: (path: string, init: RequestInit) => Promise<unknown> | unknown
  storedResetEmail?: string
}) {
  const elements = new Map<string, FakeElement>()
  const element = (id: string) => {
    const existing = elements.get(id)
    if (existing) return existing
    const created = new FakeElement()
    elements.set(id, created)
    return created
  }
  let currentUrl = new URL(input.initialUrl)
  const assigned: string[] = []
  const fetchCalls: Array<{ path: string; init: RequestInit }> = []
  const storage = new Map<string, string>()
  if (input.storedResetEmail) {
    storage.set("veslo.resetPasswordEmail", JSON.stringify({
      email: input.storedResetEmail,
      expiresAt: Date.now() + 60_000,
    }))
  }

  const windowObject = {
    get location() {
      return {
        href: currentUrl.toString(),
        search: currentUrl.search,
        assign: (value: string) => assigned.push(value),
      }
    },
    history: {
      replaceState: (_state: unknown, _title: string, value: string) => {
        currentUrl = new URL(value, currentUrl)
      },
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  }
  const fetch = async (path: string, init: RequestInit = {}) => {
    fetchCalls.push({ path, init })
    return input.respond(path, init)
  }

  vm.runInNewContext(script, {
    window: windowObject,
    document: { getElementById: element },
    fetch,
    URL,
    URLSearchParams,
    Headers,
    Object,
    JSON,
    Date,
    Number,
    String,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
  })

  return { element, fetchCalls, assigned }
}

function assertVerificationCallback(body: unknown, expected: {
  transactionId: string
  state: string
  intent: string
}) {
  assert.ok(body && typeof body === "object")
  const callbackURL = new URL(String((body as Record<string, unknown>).callbackURL))
  assert.equal(callbackURL.searchParams.get("desktopOnboarding"), "1")
  assert.equal(callbackURL.searchParams.get("tid"), expected.transactionId)
  assert.equal(callbackURL.searchParams.get("state"), expected.state)
  assert.equal(callbackURL.searchParams.get("intent"), expected.intent)
  assert.equal(callbackURL.searchParams.get("view"), "verify-email")
}

test("token-bearing signup in explicit opt-out proceeds through the secure desktop handoff", async () => {
  const harness = createBrowserHarness({
    initialUrl: "http://den.test/?desktopOnboarding=1&tid=transaction-opt-out&state=state-opt-out-123&intent=signup",
    respond: (path) => {
      if (path === "/api/auth/sign-up/email") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: "development-opt-out-token" }),
        }
      }
      if (path === "/v2/desktop-auth/authorize") {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify({
            redirectUrl: "veslo://auth-complete?code=opt-out-code&state=state-opt-out-123&transactionId=transaction-opt-out",
          }),
        }
      }
      throw new Error(`unexpected fetch: ${path}`)
    },
  })

  harness.element("auth-name").value = "Development User"
  harness.element("auth-email").value = "development@example.com"
  harness.element("auth-password").value = "development-password"
  await harness.element("auth-form").dispatch("submit")

  assert.deepEqual(harness.fetchCalls.map((call) => call.path), [
    "/api/auth/sign-up/email",
    "/v2/desktop-auth/authorize",
  ])
  const authorizeCall = harness.fetchCalls[1]
  assert.equal((authorizeCall?.init.headers as Record<string, string>).Authorization, "Bearer development-opt-out-token")
  assert.deepEqual(JSON.parse(String(authorizeCall?.init.body)), {
    transactionId: "transaction-opt-out",
    state: "state-opt-out-123",
  })
  assert.equal(harness.element("verify-required-card").classes.has("hidden"), true)
  assert.deepEqual(harness.assigned, [
    "veslo://auth-complete?code=opt-out-code&state=state-opt-out-123&transactionId=transaction-opt-out",
  ])
})

test("normal sign-in supplies a verification callback that preserves desktop context", async () => {
  const transactionId = "transaction-sign-in-callback"
  const state = "state-sign-in-callback-123"
  const harness = createBrowserHarness({
    initialUrl: `http://den.test/?desktopOnboarding=1&tid=${transactionId}&state=${state}&intent=signin`,
    respond: (path) => {
      assert.equal(path, "/api/auth/sign-in/email")
      return {
        ok: false,
        status: 403,
        json: async () => ({ code: "EMAIL_NOT_VERIFIED" }),
      }
    },
  })
  harness.element("auth-email").value = "pending-signin@example.com"
  harness.element("auth-password").value = "pending-password"

  await harness.element("auth-form").dispatch("submit")

  assert.equal(harness.fetchCalls.length, 1)
  assertVerificationCallback(JSON.parse(String(harness.fetchCalls[0]?.init.body)), {
    transactionId,
    state,
    intent: "signin",
  })
})

test("post-reset auto-sign-in supplies a verification callback that preserves desktop context", async () => {
  const transactionId = "transaction-reset-callback"
  const state = "state-reset-callback-123"
  const harness = createBrowserHarness({
    initialUrl: `http://den.test/?desktopOnboarding=1&tid=${transactionId}&state=${state}&intent=signin&view=reset-password&token=secret-reset-token`,
    storedResetEmail: "pending-reset@example.com",
    respond: (path) => {
      if (path === "/api/auth/reset-password") {
        return { ok: true, status: 200 }
      }
      if (path === "/api/auth/sign-in/email") {
        return {
          ok: false,
          status: 403,
          json: async () => ({ code: "EMAIL_NOT_VERIFIED" }),
        }
      }
      throw new Error(`unexpected fetch: ${path}`)
    },
  })
  harness.element("reset-password-new-password").value = "new-reset-password"

  await harness.element("reset-password-form").dispatch("submit")

  assert.deepEqual(harness.fetchCalls.map((call) => call.path), [
    "/api/auth/reset-password",
    "/api/auth/sign-in/email",
  ])
  assertVerificationCallback(JSON.parse(String(harness.fetchCalls[1]?.init.body)), {
    transactionId,
    state,
    intent: "signin",
  })
})
