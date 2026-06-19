import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

async function importHelper() {
  return import(`./send-lettr-alert.mjs?case=${Date.now()}-${Math.random()}`);
}

test("parseRecipients deduplicates comma and whitespace separated recipients", async () => {
  const { parseRecipients } = await importHelper();
  assert.deepEqual(parseRecipients("Admin@Example.test, ops@example.test admin@example.test"), [
    "admin@example.test",
    "ops@example.test",
  ]);
});

test("buildLettrPayload uses backup recipients before AI Gateway fallback", async () => {
  const { buildLettrPayload } = await importHelper();
  assert.deepEqual(
    buildLettrPayload({
      lettrApiKey: "secret",
      from: "auth@example.test",
      fromName: "Veslo Ops",
      backupRecipients: "backup@example.test",
      aiGatewayRecipients: "gateway@example.test",
      subject: "Backup failed",
      text: "Plain text",
      html: "<p>HTML</p>",
    }),
    {
      apiKey: "secret",
      body: {
        from: "auth@example.test",
        from_name: "Veslo Ops",
        to: ["backup@example.test"],
        subject: "Backup failed",
        text: "Plain text",
        html: "<p>HTML</p>",
      },
    },
  );
});

test("buildLettrPayload rejects missing recipients", async () => {
  const { buildLettrPayload } = await importHelper();
  assert.throws(
    () =>
      buildLettrPayload({
        lettrApiKey: "secret",
        from: "auth@example.test",
        fromName: "Veslo Ops",
        backupRecipients: "",
        aiGatewayRecipients: "",
        subject: "Backup failed",
        text: "Plain text",
        html: "<p>HTML</p>",
      }),
    /BACKUP_ALERT_EMAIL_RECIPIENTS/,
  );
});

function validInput(overrides = {}) {
  return {
    lettrApiKey: "secret",
    from: "auth@example.test",
    fromName: "Veslo Ops",
    backupRecipients: "backup@example.test",
    aiGatewayRecipients: "",
    subject: "Backup failed",
    text: "Plain text",
    html: "<p>HTML</p>",
    ...overrides,
  };
}

test("sendLettrAlert posts Lettr endpoint headers and serialized body", async () => {
  const { sendLettrAlert } = await importHelper();
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 202, statusText: "Accepted" });
  };

  await sendLettrAlert(validInput(), fetchImpl);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://app.lettr.com/api/emails");
  assert.deepEqual(requests[0].init.headers, {
    Authorization: "Bearer secret",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    from: "auth@example.test",
    from_name: "Veslo Ops",
    to: ["backup@example.test"],
    subject: "Backup failed",
    text: "Plain text",
    html: "<p>HTML</p>",
  });
});

test("sendLettrAlert rejects non-OK responses without leaking response bodies", async () => {
  const { sendLettrAlert } = await importHelper();
  const fetchImpl = async () => new Response("LETTR_API_KEY=super-secret", { status: 503, statusText: "Unavailable" });

  await assert.rejects(sendLettrAlert(validInput(), fetchImpl), (error) => {
    assert.match(error.message, /Failed to send backup failure alert: 503 Unavailable/);
    assert.doesNotMatch(error.message, /super-secret/);
    return true;
  });
});

test("sendLettrAlert aborts timed out requests", async () => {
  const { sendLettrAlert } = await importHelper();
  const fetchImpl = async (_url, init = {}) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => {
          reject(init.signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });

  await assert.rejects(withTestTimeout(sendLettrAlert(validInput({ timeoutMs: 10 }), fetchImpl)), /timed out after 10ms/);
});

test("readStdin rejects bodies over the configured byte limit without leaking body content", async () => {
  const { readStdin } = await importHelper();
  const stream = Readable.from(["safe prefix\n", "PASSWORD=super-secret"]);

  await assert.rejects(readStdin(stream, { maxBytes: 12 }), (error) => {
    assert.match(error.message, /BACKUP_ALERT_BODY_MAX_BYTES/);
    assert.doesNotMatch(error.message, /super-secret/);
    return true;
  });
});

test("buildCliAlertInput redacts secrets before building text and HTML bodies", async () => {
  const { buildCliAlertInput, buildLettrPayload } = await importHelper();
  const input = buildCliAlertInput({
    env: {
      LETTR_API_KEY: "lettr-key",
      AUTH_EMAIL_ADDRESS: "auth@example.test",
      AUTH_EMAIL_FROM_NAME: "Veslo Ops",
      BACKUP_ALERT_EMAIL_RECIPIENTS: "backup@example.test",
      AI_GATEWAY_ALERT_EMAIL_RECIPIENTS: "gateway@example.test",
      BACKUP_ALERT_SUBJECT: "Backup failed",
    },
    text: [
      "LETTR_API_KEY=lettr-secret",
      "GITHUB_TOKEN=github-secret",
      "DB_SECRET=db-secret",
      "PASSWORD=password-secret",
      "plain <tag>",
    ].join("\n"),
  });

  assert.equal(
    input.text,
    [
      "LETTR_API_KEY=[REDACTED]",
      "GITHUB_TOKEN=[REDACTED]",
      "DB_SECRET=[REDACTED]",
      "PASSWORD=[REDACTED]",
      "plain <tag>",
    ].join("\n"),
  );
  assert.equal(
    input.html,
    [
      "<pre>LETTR_API_KEY=[REDACTED]",
      "GITHUB_TOKEN=[REDACTED]",
      "DB_SECRET=[REDACTED]",
      "PASSWORD=[REDACTED]",
      "plain &lt;tag&gt;</pre>",
    ].join("\n"),
  );
  assert.deepEqual(buildLettrPayload(input).body.to, ["backup@example.test"]);
});

test("redactSecrets covers owned-server secret assignment shapes", async () => {
  const { buildCliAlertInput, redactSecrets } = await importHelper();
  const text = [
    "DB_PASSWORD=den-secret",
    "MYSQL_ROOT_PASSWORD=root-secret",
    "DATABASE_URL=mysql://user:pass@host/db",
    "AI_GATEWAY_DATABASE_URL=mysql://gateway:secret@ai-gateway-db:3306/veslo_ai_gateway",
    "OPENAI_API_KEY=sk-secret",
    "CUSTOM_API_KEY=custom-secret",
    "OTHER_KEY=key-secret",
    "SERVICE_CREDENTIAL=credential-secret",
    "Harmless prose mentions password, token, secret, and api key without assignments.",
  ].join("\n");

  const expected = [
    "DB_PASSWORD=[REDACTED]",
    "MYSQL_ROOT_PASSWORD=[REDACTED]",
    "DATABASE_URL=[REDACTED]",
    "AI_GATEWAY_DATABASE_URL=[REDACTED]",
    "OPENAI_API_KEY=[REDACTED]",
    "CUSTOM_API_KEY=[REDACTED]",
    "OTHER_KEY=[REDACTED]",
    "SERVICE_CREDENTIAL=[REDACTED]",
    "Harmless prose mentions password, token, secret, and api key without assignments.",
  ].join("\n");

  assert.equal(redactSecrets(text), expected);

  const input = buildCliAlertInput({
    env: {
      LETTR_API_KEY: "lettr-key",
      AUTH_EMAIL_ADDRESS: "auth@example.test",
      AUTH_EMAIL_FROM_NAME: "Veslo Ops",
      BACKUP_ALERT_EMAIL_RECIPIENTS: "backup@example.test",
    },
    text,
  });
  assert.equal(input.text, expected);
  assert.doesNotMatch(input.html, /den-secret|root-secret|pass@host|sk-secret|credential-secret/);
});

function withTestTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error("test fetch was not aborted")), 100);
      timeout.unref?.();
    }),
  ]);
}
