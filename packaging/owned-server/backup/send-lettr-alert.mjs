#!/usr/bin/env node

import { fileURLToPath } from "node:url";

const LETTR_ENDPOINT = "https://app.lettr.com/api/emails";

export function parseRecipients(value) {
  if (!value) return [];
  return Array.from(
    new Set(
      String(value)
        .split(/[,\s]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

export function buildLettrPayload(input) {
  const apiKey = String(input.lettrApiKey ?? "").trim();
  if (!apiKey) throw new Error("LETTR_API_KEY is required to send backup failure alerts");

  const from = String(input.from ?? "").trim();
  if (!from) throw new Error("AUTH_EMAIL_ADDRESS is required to send backup failure alerts");

  const fromName = String(input.fromName ?? "").trim();
  if (!fromName) throw new Error("AUTH_EMAIL_FROM_NAME is required to send backup failure alerts");

  const backupRecipients = parseRecipients(input.backupRecipients);
  const recipients = backupRecipients.length ? backupRecipients : parseRecipients(input.aiGatewayRecipients);
  if (!recipients.length) {
    throw new Error("BACKUP_ALERT_EMAIL_RECIPIENTS must contain at least one admin email");
  }

  return {
    apiKey,
    body: {
      from,
      from_name: fromName,
      to: recipients,
      subject: String(input.subject ?? "Veslo backup failed"),
      text: String(input.text ?? ""),
      html: String(input.html ?? input.text ?? ""),
    },
  };
}

export async function sendLettrAlert(input, fetchImpl = globalThis.fetch) {
  const { apiKey, body } = buildLettrPayload(input);
  const response = await fetchImpl(LETTR_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Failed to send backup failure alert: ${response.status} ${response.statusText}`);
  }
}

async function main() {
  const text = await readStdin();

  await sendLettrAlert({
    lettrApiKey: process.env.LETTR_API_KEY,
    from: process.env.AUTH_EMAIL_ADDRESS,
    fromName: process.env.AUTH_EMAIL_FROM_NAME,
    backupRecipients: process.env.BACKUP_ALERT_EMAIL_RECIPIENTS,
    aiGatewayRecipients: process.env.AI_GATEWAY_ALERT_EMAIL_RECIPIENTS,
    subject: process.env.BACKUP_ALERT_SUBJECT ?? "Veslo backup failed",
    text,
    html: `<pre>${escapeHtml(text)}</pre>`,
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      body += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(body));
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
