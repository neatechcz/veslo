import assert from "node:assert/strict";
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
