import assert from "node:assert/strict";
import test from "node:test";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(overrides: Record<string, string | undefined> = {}) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    ...ORIGINAL_ENV,
    LETTR_API_KEY: "lettr_test_key",
    AUTH_EMAIL_ADDRESS: "alerts@example.test",
    AUTH_EMAIL_FROM_NAME: "Veslo Ops",
    ...overrides,
  });
}

async function importMailer() {
  return import(`../src/email/admin-alert-mailer.js?case=${Date.now()}-${Math.random()}`);
}

test.afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});

test("admin alert email uses Lettr send-email payload", async () => {
  resetEnv();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 202, statusText: "Accepted" });
  }) as typeof fetch;

  try {
    const { sendAdminAlertEmail } = await importMailer();
    await sendAdminAlertEmail({
      to: "admin@example.test",
      subject: "[URGENT] Codex 5h limit capacity at 95%",
      html: "<p>Capacity warning</p>",
      text: "Capacity warning",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://app.lettr.com/api/emails");
  assert.deepEqual(requests[0]?.init.headers, {
    Authorization: "Bearer lettr_test_key",
    "Content-Type": "application/json",
  });
  const body = JSON.parse(String(requests[0]?.init.body));
  assert.deepEqual(body, {
    from: "alerts@example.test",
    from_name: "Veslo Ops",
    to: ["admin@example.test"],
    subject: "[URGENT] Codex 5h limit capacity at 95%",
    html: "<p>Capacity warning</p>",
    text: "Capacity warning",
  });
});

test("admin alert email reports disabled configuration", async () => {
  resetEnv({
    LETTR_API_KEY: "",
  });

  const { isAdminAlertEmailConfigured, sendAdminAlertEmail } = await importMailer();

  assert.equal(isAdminAlertEmailConfigured(), false);
  await assert.rejects(
    sendAdminAlertEmail({
      to: "admin@example.test",
      subject: "Subject",
      html: "<p>Body</p>",
      text: "Body",
    }),
    /LETTR_API_KEY is required/,
  );
});
