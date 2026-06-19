#!/usr/bin/env node

import { fileURLToPath } from "node:url";

const LETTR_ENDPOINT = "https://app.lettr.com/api/emails";
const DEFAULT_BODY_MAX_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const ENV_ASSIGNMENT_PATTERN = /\b([A-Z_][A-Z0-9_]*)(\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi;
const SECRET_KEY_PARTS = ["PASSWORD", "TOKEN", "SECRET", "API_KEY", "KEY", "CREDENTIAL", "DATABASE_URL"];

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
  const timeoutMs = positiveInteger(input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, "BACKUP_ALERT_REQUEST_TIMEOUT_MS");
  const controller = new AbortController();
  let timeout;

  const fetchPromise = Promise.resolve().then(() =>
    fetchImpl(LETTR_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );

  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Failed to send backup failure alert: request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();
  });

  let response;
  try {
    response = await Promise.race([fetchPromise, timeoutPromise]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Failed to send backup failure alert: request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    fetchPromise.catch(() => {});
  }

  if (!response.ok) {
    throw new Error(`Failed to send backup failure alert: ${response.status} ${response.statusText}`);
  }
}

export async function readStdin(stream = process.stdin, options = {}) {
  const maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_BODY_MAX_BYTES, "BACKUP_ALERT_BODY_MAX_BYTES");
  let body = "";
  let bytes = 0;

  stream.setEncoding?.("utf8");

  for await (const chunk of stream) {
    const text = String(chunk);
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) {
      throw new Error(`BACKUP_ALERT_BODY_MAX_BYTES exceeded (${maxBytes} bytes)`);
    }
    body += text;
  }

  return body;
}

export function buildCliAlertInput({ env = process.env, text = "" } = {}) {
  const redactedText = redactSecrets(text);
  return {
    lettrApiKey: env.LETTR_API_KEY,
    from: env.AUTH_EMAIL_ADDRESS,
    fromName: env.AUTH_EMAIL_FROM_NAME,
    backupRecipients: env.BACKUP_ALERT_EMAIL_RECIPIENTS,
    aiGatewayRecipients: env.AI_GATEWAY_ALERT_EMAIL_RECIPIENTS,
    subject: env.BACKUP_ALERT_SUBJECT ?? "Veslo backup failed",
    text: redactedText,
    html: `<pre>${escapeHtml(redactedText)}</pre>`,
    timeoutMs: positiveInteger(env.BACKUP_ALERT_REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS, "BACKUP_ALERT_REQUEST_TIMEOUT_MS"),
  };
}

export function redactSecrets(value) {
  return String(value).replace(ENV_ASSIGNMENT_PATTERN, (match, key, separator) => {
    if (!shouldRedactEnvAssignment(key)) return match;
    return `${key}${separator}[REDACTED]`;
  });
}

async function main() {
  const text = await readStdin(process.stdin, {
    maxBytes: positiveInteger(process.env.BACKUP_ALERT_BODY_MAX_BYTES ?? DEFAULT_BODY_MAX_BYTES, "BACKUP_ALERT_BODY_MAX_BYTES"),
  });

  await sendLettrAlert(buildCliAlertInput({ env: process.env, text }));
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function shouldRedactEnvAssignment(key) {
  const normalizedKey = String(key).toUpperCase();
  return SECRET_KEY_PARTS.some((part) => normalizedKey.includes(part));
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
