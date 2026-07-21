import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const sourcePath = resolve(process.cwd(), "services/den/public/index.html");
assert.equal(existsSync(sourcePath), true, "hosted desktop onboarding page must exist");

const source = readFileSync(sourcePath, "utf8");

assert.equal(
  source.includes("veslo.desktopAuthContext"),
  true,
  "hosted desktop onboarding must persist desktop auth context in browser storage",
);
assert.equal(
  source.includes("localStorage.getItem"),
  true,
  "hosted desktop onboarding must read local storage for cross-tab desktop auth context restoration",
);
assert.equal(
  source.includes("localStorage.setItem") && source.includes("localStorage.removeItem"),
  true,
  "hosted desktop onboarding must write and clear local storage desktop auth context",
);
assert.equal(
  source.includes("expiresAt"),
  true,
  "hosted desktop onboarding must persist a desktop auth context expiry",
);
assert.equal(
  source.includes("onboardingTransactionId") && source.includes("onboardingState"),
  true,
  "hosted desktop onboarding must track transaction id and state",
);
assert.equal(
  source.includes("clearDesktopAuthContext"),
  true,
  "hosted desktop onboarding must clear restored desktop auth context after completion",
);
assert.equal(
  source.includes("transaction_not_ready") && source.includes("recoverDesktopAuthTransaction"),
  true,
  "hosted desktop onboarding must recover already-used desktop auth transactions instead of showing transaction_not_ready",
);
assert.equal(
  source.includes("/v2/desktop-auth/status?transactionId="),
  true,
  "hosted desktop onboarding must check desktop auth transaction status during recovery",
);
assert.equal(
  source.includes('status === "authorized"') && source.includes('status === "exchanged"'),
  true,
  "hosted desktop onboarding must treat already-authorized/exchanged transactions as successful states",
);

class FakeClassList {
  constructor(initialClasses = []) {
    this.values = new Set(initialClasses);
  }

  add(...names) {
    for (const name of names) this.values.add(name);
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
  }

  toggle(name, force) {
    if (force === undefined) {
      if (this.values.has(name)) {
        this.values.delete(name);
        return false;
      }
      this.values.add(name);
      return true;
    }
    if (force) this.values.add(name);
    else this.values.delete(name);
    return force;
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor(id, classes = []) {
    this.id = id;
    this.classList = new FakeClassList(classes);
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.href = "#";
    this.autocomplete = "";
    this.focused = false;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) {
      await listener(event);
    }
  }

  focus() {
    this.focused = true;
  }
}

function extractElements(html) {
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const tag = match[0];
    const classMatch = tag.match(/\bclass="([^"]*)"/);
    const classes = classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [];
    elements.set(match[1], new FakeElement(match[1], classes));
  }
  return elements;
}

function jsonResponse(status, payload) {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() {
      return payload;
    },
    async text() {
      return text;
    },
  };
}

function createOnboardingBrowser({
  intent = "signin",
  view = "",
  token = "",
  resetEmail = "",
  fetchImpl,
}) {
  const scriptMatch = source.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "hosted onboarding page must include an executable inline script");

  const elements = extractElements(source);
  const storage = new Map();
  if (resetEmail) {
    storage.set("veslo.resetPasswordEmail", JSON.stringify({
      email: resetEmail,
      expiresAt: Date.now() + 60_000,
    }));
  }
  const assignedLocations = [];
  const queryParams = new URLSearchParams({
    desktopOnboarding: "1",
    tid: "transaction-1",
    state: "state-1",
    intent,
  });
  if (view) queryParams.set("view", view);
  if (token) queryParams.set("token", token);
  const query = `?${queryParams.toString()}`;
  const location = {
    search: query,
    href: `https://den.example.test/${query}`,
    assign(value) {
      assignedLocations.push(value);
    },
  };
  const window = {
    location,
    history: {
      replaceState(_state, _title, value) {
        location.href = String(value);
        location.search = new URL(location.href).search;
      },
    },
    localStorage: {
      getItem(key) {
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
  };
  const document = {
    getElementById(id) {
      return elements.get(id) || null;
    },
  };

  vm.runInNewContext(scriptMatch[1], {
    console,
    document,
    encodeURIComponent,
    fetch: fetchImpl,
    URL,
    URLSearchParams,
    window,
  });

  return {
    assignedLocations,
    location,
    element(id) {
      const element = elements.get(id);
      assert.ok(element, `expected onboarding element ${id}`);
      return element;
    },
    async submitAuth(email = "person@example.test") {
      elements.get("auth-email").value = email;
      elements.get("auth-password").value = "secure-password";
      elements.get("auth-name").value = "Example Person";
      await elements.get("auth-form").dispatch("submit", { preventDefault() {} });
    },
    async submitResetPassword() {
      elements.get("reset-password-new-password").value = "new-secure-password";
      await elements.get("reset-password-form").dispatch("submit", { preventDefault() {} });
    },
  };
}

{
  const requests = [];
  const browser = createOnboardingBrowser({
    intent: "signup",
    async fetchImpl(url) {
      requests.push(url);
      if (url === "/api/auth/sign-up/email") return jsonResponse(200, { token: null });
      if (url === "/v1/me") {
        return jsonResponse(200, {
          user: { email: "new@example.test", emailVerified: false },
        });
      }
      throw new Error(`unexpected signup request: ${url}`);
    },
  });

  await browser.submitAuth("new@example.test");
  assert.deepEqual(
    requests,
    ["/api/auth/sign-up/email"],
    "signup with a null token must enter verification recovery without calling /v1/me or handoff",
  );
  assert.equal(browser.element("verify-required-card").classList.contains("hidden"), false);

  await browser.element("verify-required-back").dispatch("click");
  const verificationCallbackBrowser = createOnboardingBrowser({
    intent: "signup",
    view: "verify-email",
    async fetchImpl(url) {
      throw new Error(`unexpected verification callback request: ${url}`);
    },
  });
  await verificationCallbackBrowser.element("verify-email-return").dispatch("click");

  const readReturnedAuthState = (activeBrowser) => {
    const params = new URLSearchParams(activeBrowser.location.search);
    return {
      title: activeBrowser.element("onboard-title").textContent,
      nameFieldHidden: activeBrowser.element("name-field").classList.contains("hidden"),
      passwordAutocomplete: activeBrowser.element("auth-password").autocomplete,
      action: activeBrowser.element("auth-submit").textContent,
      transactionId: params.get("tid"),
      state: params.get("state"),
    };
  };
  const expectedSignInState = {
    title: "Sign in to Veslo",
    nameFieldHidden: true,
    passwordAutocomplete: "current-password",
    action: "Sign in",
    transactionId: "transaction-1",
    state: "state-1",
  };
  assert.deepEqual(
    {
      verificationRequiredBack: readReturnedAuthState(browser),
      verificationCallbackReturn: readReturnedAuthState(verificationCallbackBrowser),
    },
    {
      verificationRequiredBack: expectedSignInState,
      verificationCallbackReturn: expectedSignInState,
    },
    "both verification return controls must render sign-in while preserving desktop auth context",
  );
}

{
  const requests = [];
  const browser = createOnboardingBrowser({
    view: "reset-password",
    token: "reset-token",
    resetEmail: "reset@example.test",
    async fetchImpl(url) {
      requests.push(url);
      if (url === "/api/auth/reset-password") return jsonResponse(200, { ok: true });
      if (url === "/api/auth/sign-in/email") {
        return jsonResponse(403, {
          code: "EMAIL_NOT_VERIFIED",
          message: "Email not verified",
        });
      }
      throw new Error(`unexpected reset sign-in request: ${url}`);
    },
  });

  await browser.submitResetPassword();
  assert.deepEqual(requests, ["/api/auth/reset-password", "/api/auth/sign-in/email"]);
  assert.equal(
    browser.element("verify-required-card").classList.contains("hidden"),
    false,
    "automatic sign-in after password reset must share verification recovery",
  );
  assert.match(browser.element("verify-required-status").textContent, /new verification email/i);
}

{
  const requests = [];
  let resendAttempts = 0;
  const browser = createOnboardingBrowser({
    async fetchImpl(url) {
      requests.push(url);
      if (url === "/api/auth/sign-in/email") {
        return jsonResponse(403, {
          code: "EMAIL_NOT_VERIFIED",
          message: "Email not verified",
        });
      }
      if (url === "/api/auth/send-verification-email") {
        resendAttempts += 1;
        return resendAttempts === 1
          ? jsonResponse(503, { message: "provider details must stay private" })
          : jsonResponse(200, { ok: true });
      }
      throw new Error(`unexpected unverified sign-in request: ${url}`);
    },
  });

  await browser.submitAuth("waiting@example.test");
  assert.equal(browser.element("verify-required-card").classList.contains("hidden"), false);
  assert.match(browser.element("verify-required-status").textContent, /new verification email/i);
  await browser.element("resend-verification").dispatch("click");
  assert.equal(browser.element("verify-required-card").classList.contains("hidden"), false);
  assert.match(browser.element("verify-required-error").textContent, /could not resend/i);
  assert.equal(browser.element("resend-verification").disabled, false);
  await browser.element("resend-verification").dispatch("click");
  assert.equal(browser.element("verify-required-card").classList.contains("hidden"), false);
  assert.match(browser.element("verify-required-status").textContent, /verification email sent/i);
  assert.deepEqual(requests, [
    "/api/auth/sign-in/email",
    "/api/auth/send-verification-email",
    "/api/auth/send-verification-email",
  ]);
}

{
  const browser = createOnboardingBrowser({
    intent: "signup",
    async fetchImpl(url) {
      assert.equal(url, "/api/auth/sign-up/email");
      return jsonResponse(502, {
        code: "VERIFICATION_EMAIL_DELIVERY_FAILED",
        message: "verification_email_delivery_failed",
      });
    },
  });

  await browser.submitAuth("delivery@example.test");
  assert.equal(browser.element("verify-required-card").classList.contains("hidden"), false);
  assert.match(browser.element("verify-required-error").textContent, /could not send/i);
  assert.equal(browser.element("resend-verification").disabled, false);
}

{
  const requests = [];
  const browser = createOnboardingBrowser({
    async fetchImpl(url) {
      requests.push(url);
      if (url === "/api/auth/sign-in/email") return jsonResponse(200, { token: "   " });
      throw new Error(`unexpected empty-token sign-in request: ${url}`);
    },
  });

  await browser.submitAuth("waiting@example.test");
  assert.deepEqual(
    requests,
    ["/api/auth/sign-in/email"],
    "a blank sign-in token must remain in verification recovery without handoff",
  );
  assert.equal(browser.element("verify-required-card").classList.contains("hidden"), false);
}

{
  const requests = [];
  const browser = createOnboardingBrowser({
    async fetchImpl(url) {
      requests.push(url);
      if (url === "/api/auth/sign-in/email") return jsonResponse(200, { token: "verified-token" });
      if (url === "/v2/desktop-auth/authorize") {
        return jsonResponse(200, { redirectUrl: "veslo://auth-complete?code=verified-code" });
      }
      if (url === "/v1/me") {
        return jsonResponse(200, {
          user: { email: "verified@example.test", emailVerified: true },
        });
      }
      throw new Error(`unexpected verified sign-in request: ${url}`);
    },
  });

  await browser.submitAuth("verified@example.test");
  assert.deepEqual(
    requests,
    ["/api/auth/sign-in/email", "/v2/desktop-auth/authorize"],
    "only a successful verified sign-in token may invoke desktop handoff",
  );
  assert.deepEqual(browser.assignedLocations, ["veslo://auth-complete?code=verified-code"]);
}

console.log(JSON.stringify({ ok: true, sourceChecks: 9, browserScenarios: 7 }));
