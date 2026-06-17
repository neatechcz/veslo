# Credential Alert Email Monitor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Send email to every platform admin on the first occurrence of any active credential/account fault, then deduplicate and throttle repeats.

**Architecture:** Add a generic credential alert email monitor in AI Gateway that reads existing unresolved admin alerts and sends best-effort emails outside the inference request path. Add a DEN internal server-to-server endpoint so AI Gateway can resolve active platform admin recipients without storing a user admin token. Preserve the existing Codex capacity email behavior as a separate monitor.

**Tech Stack:** TypeScript, Node test runner, Express, Drizzle/MySQL repositories, Lettr email API, existing DEN admin runtime and AI Gateway admin/alert repositories.

---

### Task 0: Reconcile Production Alerting Baseline

**Files:**
- Verify: `services/ai-gateway/src/email/admin-alert-mailer.ts`
- Verify: `services/ai-gateway/src/alerts/codex-capacity-alerts.ts`
- Verify: `services/ai-gateway/src/alerts/codex-capacity-monitor.ts`
- Verify: `services/ai-gateway/src/http/providers/proxy-failure-alert.ts`
- Modify as needed: `services/ai-gateway/src/env.ts`
- Modify as needed: `services/ai-gateway/src/runtime/default-runtime.ts`
- Modify as needed: `services/ai-gateway/src/http/proxy.ts`
- Modify as needed: `services/ai-gateway/src/http/providers/openai.ts`
- Modify as needed: `services/ai-gateway/src/http/providers/anthropic.ts`
- Modify as needed: `services/ai-gateway/src/http/providers/openai-compatible.ts`
- Modify as needed: `services/ai-gateway/src/http/providers/codex-oauth.ts`

**Step 1: Check whether the local branch already has the production alert baseline**

Run:

```bash
test -f services/ai-gateway/src/email/admin-alert-mailer.ts
test -f services/ai-gateway/src/alerts/codex-capacity-alerts.ts
test -f services/ai-gateway/src/alerts/codex-capacity-monitor.ts
test -f services/ai-gateway/src/http/providers/proxy-failure-alert.ts
rg -n "alertRepository|recordProviderProxyFailureAlert|runCodexCapacityAlertEmailMonitor" services/ai-gateway/src
```

Expected:
- The files exist.
- `ProxyDependencies` includes `alertRepository`.
- Provider routes call `recordProviderProxyFailureAlert`.
- `index.ts` starts the existing Codex capacity alert email loop.

**Step 2: If the check fails, port the already-deployed baseline before continuing**

Use the production-owned-server implementation as the source of truth for the baseline behavior already running on `ai.veslo.work`. Port only the existing alerting baseline, not the new generic monitor from this plan.

Minimum baseline behavior:

```ts
// services/ai-gateway/src/alerts/repository.ts
export type RecordProviderFailureAlertInput = {
  credentialId: string;
  provider: string;
  sessionId: string;
  reason: string;
  occurredAt?: Date | null;
};

export interface AlertRepository {
  listAlerts(): Promise<AlertRecord[]>;
  recordProviderFailure?(input: RecordProviderFailureAlertInput): Promise<void>;
  acknowledgeAlert?(input: AlertActionInput): Promise<AlertRecord | null>;
  resolveAlert?(input: AlertActionInput): Promise<AlertRecord | null>;
}
```

```ts
// services/ai-gateway/src/http/providers/proxy-failure-alert.ts
export function classifyProviderProxyFailure(error: unknown): string | null {
  const detail = readErrorDetail(error);
  if (!detail) return null;
  if (/(und_err_connect_timeout|connect timeout|etimedout|timeout)/i.test(detail)) return "network_connect_timeout";
  if (/(enotfound|eai_again|dns)/i.test(detail)) return "network_dns_failure";
  if (/(econnreset|econnrefused|epipe|socket hang up)/i.test(detail)) return "network_connection_failed";
  if (/fetch failed/i.test(detail)) return "network_fetch_failed";
  return null;
}
```

**Step 3: Run baseline tests**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/admin-alerts.test.ts test/proxy.test.ts test/env.test.ts test/alert-mailer.test.ts test/codex-capacity-alert-monitor.test.ts test/codex-capacity-alerts.test.ts
```

Expected: all selected tests pass.

**Step 4: Commit baseline reconciliation only if files changed**

```bash
git add services/ai-gateway/src services/ai-gateway/test
git commit -m "chore: reconcile ai gateway alert email baseline"
```

---

### Task 1: Add DEN Internal Platform Admin Recipient Endpoint

**Files:**
- Modify: `services/den/src/env.ts`
- Modify: `services/den/src/http/admin-runtime.ts`
- Create: `services/den/src/http/internal-platform-admin-recipients.ts`
- Modify: `services/den/src/index.ts`
- Test: `services/den/test/internal-platform-admin-recipients.test.ts`
- Test: `services/den/test/debug-log-env.test.ts`
- Docs: `docs/dev/state-and-config-reference.md`

**Step 1: Write failing endpoint tests**

Create `services/den/test/internal-platform-admin-recipients.test.ts`:

```ts
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";

const { createInternalPlatformAdminRecipientsRouter } = await import("../src/http/internal-platform-admin-recipients.js");

async function startServer(options: Parameters<typeof createInternalPlatformAdminRecipientsRouter>[0]) {
  const app = express();
  app.use("/v1/internal", createInternalPlatformAdminRecipientsRouter(options));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

test("platform admin recipients route rejects missing and wrong bearer auth", async () => {
  const server = await startServer({
    token: "internal-token",
    listRecipients: async () => [{ userId: "user_admin", email: "admin@example.test", name: "Admin" }],
  });
  try {
    const missing = await fetch(`http://127.0.0.1:${server.port}/v1/internal/platform-admin-recipients`);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error, "platform_admin_recipients_unauthorized");

    const wrong = await fetch(`http://127.0.0.1:${server.port}/v1/internal/platform-admin-recipients`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(wrong.status, 403);
    assert.equal((await wrong.json()).error, "platform_admin_recipients_forbidden");
  } finally {
    await server.close();
  }
});

test("platform admin recipients route returns active platform admin emails", async () => {
  const server = await startServer({
    token: "internal-token",
    listRecipients: async () => [
      { userId: "user_admin", email: "ADMIN@example.test", name: "Admin" },
      { userId: "user_admin_2", email: "admin@example.test", name: "Duplicate" },
      { userId: "user_other", email: "other@example.test", name: "Other" },
    ],
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/internal/platform-admin-recipients`, {
      headers: { Authorization: "Bearer internal-token" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      recipients: [
        { userId: "user_admin", email: "admin@example.test", name: "Admin" },
        { userId: "user_other", email: "other@example.test", name: "Other" },
      ],
    });
  } finally {
    await server.close();
  }
});

test("platform admin recipients route reports missing configuration", async () => {
  const server = await startServer({
    token: null,
    listRecipients: async () => [],
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/internal/platform-admin-recipients`, {
      headers: { Authorization: "Bearer internal-token" },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "platform_admin_recipients_not_configured");
  } finally {
    await server.close();
  }
});
```

**Step 2: Run the endpoint test to verify it fails**

Run:

```bash
pnpm --dir services/den exec tsx --test test/internal-platform-admin-recipients.test.ts
```

Expected: FAIL because the route file does not exist.

**Step 3: Add DEN env parsing**

Modify `services/den/src/env.ts`:

```ts
const schema = z.object({
  // existing fields
  DEN_AI_GATEWAY_INTERNAL_TOKEN: z.string().optional(),
});

return {
  // existing fields
  aiGatewayInternalToken: parsed.DEN_AI_GATEWAY_INTERNAL_TOKEN?.trim() || null,
};
```

Add an env test next to the debug log env tests:

```ts
test("internal AI gateway token env parses optional service token", () => {
  const parsed = parseEnv({
    ...baseEnv,
    DEN_AI_GATEWAY_INTERNAL_TOKEN: " internal-token ",
  });

  assert.equal(parsed.aiGatewayInternalToken, "internal-token");
});
```

**Step 4: Export a narrow admin-recipient loader**

Modify `services/den/src/http/admin-runtime.ts`:

```ts
export type PlatformAdminRecipient = {
  userId: string;
  email: string;
  name: string | null;
};

export async function listActivePlatformAdminRecipients(): Promise<PlatformAdminRecipient[]> {
  const users = await loadAdminUsers();
  return users
    .filter((entry) => entry.platformAdmin && entry.disabled !== true && entry.email)
    .map((entry) => ({
      userId: entry.id,
      email: entry.email.trim().toLowerCase(),
      name: entry.name?.trim() || null,
    }));
}
```

Use this helper inside `ensureAdminRetentionAllowed` too, if that makes the duplication smaller without changing behavior.

**Step 5: Implement internal recipients route**

Create `services/den/src/http/internal-platform-admin-recipients.ts`:

```ts
import express from "express";
import type { PlatformAdminRecipient } from "./admin-runtime.js";

function readBearerToken(req: express.Request) {
  const header = req.header("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

function dedupeRecipients(recipients: PlatformAdminRecipient[]): PlatformAdminRecipient[] {
  const seen = new Set<string>();
  const result: PlatformAdminRecipient[] = [];
  for (const recipient of recipients) {
    const email = recipient.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    result.push({ ...recipient, email });
  }
  return result;
}

export function createInternalPlatformAdminRecipientsRouter(options: {
  token: string | null;
  listRecipients: () => Promise<PlatformAdminRecipient[]>;
}) {
  const router = express.Router();

  router.get("/platform-admin-recipients", async (req, res) => {
    if (!options.token) {
      res.status(503).json({ error: "platform_admin_recipients_not_configured" });
      return;
    }

    const bearerToken = readBearerToken(req);
    if (!bearerToken) {
      res.status(401).json({ error: "platform_admin_recipients_unauthorized" });
      return;
    }
    if (bearerToken !== options.token) {
      res.status(403).json({ error: "platform_admin_recipients_forbidden" });
      return;
    }

    const recipients = dedupeRecipients(await options.listRecipients());
    res.json({ recipients });
  });

  return router;
}
```

**Step 6: Mount the internal route**

Modify `services/den/src/index.ts`:

```ts
import { createInternalPlatformAdminRecipientsRouter } from "./http/internal-platform-admin-recipients.js";
import { listActivePlatformAdminRecipients } from "./http/admin-runtime.js";

app.use("/v1/internal", createInternalPlatformAdminRecipientsRouter({
  token: env.aiGatewayInternalToken,
  listRecipients: listActivePlatformAdminRecipients,
}));
```

Mount it next to the existing `/v1/internal` debug-log router.

**Step 7: Run DEN tests**

Run:

```bash
pnpm --dir services/den exec tsx --test test/internal-platform-admin-recipients.test.ts test/debug-log-env.test.ts test/admin-runtime-bootstrap.test.ts
```

Expected: all pass.

**Step 8: Commit**

```bash
git add services/den/src services/den/test docs/dev/state-and-config-reference.md
git commit -m "feat: expose platform admin alert recipients internally"
```

---

### Task 2: Add AI Gateway Email Env, Mailer, And Recipient Client

**Files:**
- Modify: `services/ai-gateway/src/env.ts`
- Create if missing: `services/ai-gateway/src/email/admin-alert-mailer.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`
- Test: `services/ai-gateway/test/env.test.ts`
- Test: `services/ai-gateway/test/alert-mailer.test.ts`

**Step 1: Write failing env and mailer tests**

Add/extend `services/ai-gateway/test/env.test.ts`:

```ts
test("parseEnv resolves alert email delivery settings", () => {
  const parsed = parseEnv({
    AI_GATEWAY_DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_ai_gateway",
    AI_GATEWAY_SECRET_KEY: "12345678901234567890123456789012",
    LETTR_API_KEY: " lettr-key ",
    AUTH_EMAIL_ADDRESS: " alerts@example.test ",
    AUTH_EMAIL_FROM_NAME: " Veslo ",
    AI_GATEWAY_ALERT_EMAIL_RECIPIENTS: " Admin@One.test, admin@two.test admin@one.test ",
    AI_GATEWAY_DEN_INTERNAL_TOKEN: " den-internal ",
    AI_GATEWAY_CREDENTIAL_ALERT_EMAIL_INTERVAL_MS: "60000",
  });

  assert.deepEqual(parsed.email, {
    lettrApiKey: "lettr-key",
    address: "alerts@example.test",
    fromName: "Veslo",
  });
  assert.deepEqual(parsed.alertEmail.recipients, ["admin@one.test", "admin@two.test"]);
  assert.equal(parsed.alertEmail.credentialAlertIntervalMs, 60000);
  assert.equal(parsed.denInternalToken, "den-internal");
});
```

Add/extend `services/ai-gateway/test/alert-mailer.test.ts`:

```ts
test("admin alert email uses Lettr send-email payload", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const previousEnv = { ...process.env };
  Object.assign(process.env, {
    LETTR_API_KEY: "lettr-key",
    AUTH_EMAIL_ADDRESS: "alerts@example.test",
    AUTH_EMAIL_FROM_NAME: "Veslo",
  });
  try {
    const { sendAdminAlertEmail } = await import("../src/email/admin-alert-mailer.js");
    await sendAdminAlertEmail({
      to: "admin@example.test",
      subject: "Credential alert",
      text: "Credential fault",
      html: "<p>Credential fault</p>",
    });
    assert.equal(requests[0]?.url, "https://app.lettr.com/api/emails");
    assert.equal((requests[0]?.init.headers as Record<string, string>).Authorization, "Bearer lettr-key");
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
});
```

**Step 2: Run tests to verify failure**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/env.test.ts test/alert-mailer.test.ts
```

Expected: FAIL until env fields and mailer exist.

**Step 3: Implement env fields**

Modify `services/ai-gateway/src/env.ts`:

```ts
const DEFAULT_CREDENTIAL_ALERT_EMAIL_INTERVAL_MS = 60 * 1000;

const envSchema = z.object({
  LETTR_API_KEY: z.string().optional(),
  AUTH_EMAIL_ADDRESS: z.string().optional(),
  AUTH_EMAIL_FROM_NAME: z.string().optional(),
  AI_GATEWAY_ALERT_EMAIL_RECIPIENTS: z.string().optional(),
  AI_GATEWAY_DEN_INTERNAL_TOKEN: z.string().optional(),
  AI_GATEWAY_CREDENTIAL_ALERT_EMAIL_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  // existing fields
});

return {
  // existing fields
  email: {
    lettrApiKey: parsed.LETTR_API_KEY?.trim() || undefined,
    address: parsed.AUTH_EMAIL_ADDRESS?.trim() || undefined,
    fromName: parsed.AUTH_EMAIL_FROM_NAME?.trim() || undefined,
  },
  alertEmail: {
    recipients: parseEmailList(parsed.AI_GATEWAY_ALERT_EMAIL_RECIPIENTS),
    credentialAlertIntervalMs:
      parsed.AI_GATEWAY_CREDENTIAL_ALERT_EMAIL_INTERVAL_MS ??
      DEFAULT_CREDENTIAL_ALERT_EMAIL_INTERVAL_MS,
  },
  denInternalToken: parsed.AI_GATEWAY_DEN_INTERNAL_TOKEN?.trim() || null,
};
```

**Step 4: Implement or retain the Lettr mailer**

Create `services/ai-gateway/src/email/admin-alert-mailer.ts` if missing:

```ts
import { parseEnv } from "../env.js";

const ADMIN_ALERT_EMAIL_TIMEOUT_MS = 30_000;

export type AdminAlertEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export async function sendAdminAlertEmail(input: AdminAlertEmailInput) {
  const emailEnv = parseEnv(process.env).email;
  if (!emailEnv.lettrApiKey) throw new Error("LETTR_API_KEY is required to send admin alert emails");
  if (!emailEnv.address) throw new Error("AUTH_EMAIL_ADDRESS is required to send admin alert emails");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ADMIN_ALERT_EMAIL_TIMEOUT_MS);
  unrefTimer(timeout);
  try {
    const response = await fetch("https://app.lettr.com/api/emails", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${emailEnv.lettrApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: emailEnv.address,
        from_name: emailEnv.fromName,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to send admin alert email: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Failed to send admin alert email: request timed out after ${ADMIN_ALERT_EMAIL_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function isAdminAlertEmailConfigured() {
  const emailEnv = parseEnv(process.env).email;
  return Boolean(emailEnv.lettrApiKey && emailEnv.address);
}

function unrefTimer(handle: unknown) {
  if (handle && typeof handle === "object" && typeof (handle as { unref?: unknown }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }
}
```

**Step 5: Add DEN internal recipient client**

Modify `services/ai-gateway/src/http/admin.ts` inside `DenAdminClient`:

```ts
async listPlatformAdminRecipients(token: string | null) {
  if (!token) {
    throw new HttpError("den_internal_token_missing", 503);
  }
  const payload = await this.requestJson("/v1/internal/platform-admin-recipients", {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  }) as { recipients?: Array<{ userId?: string; email?: string; name?: string | null }> };

  return (payload.recipients ?? [])
    .map((entry) => ({
      userId: typeof entry.userId === "string" ? entry.userId : "",
      email: typeof entry.email === "string" ? entry.email.trim().toLowerCase() : "",
      name: typeof entry.name === "string" ? entry.name : null,
    }))
    .filter((entry) => entry.email.includes("@"));
}
```

Add this method to the local `DenAdminApi` type.

**Step 6: Run tests**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/env.test.ts test/alert-mailer.test.ts
```

Expected: pass.

**Step 7: Commit**

```bash
git add services/ai-gateway/src services/ai-gateway/test
git commit -m "feat: add ai gateway admin alert mail settings"
```

---

### Task 3: Add Credential Alert Email Monitor

**Files:**
- Create: `services/ai-gateway/src/alerts/credential-alert-email-monitor.ts`
- Test: `services/ai-gateway/test/credential-alert-email-monitor.test.ts`

**Step 1: Write failing monitor tests**

Create `services/ai-gateway/test/credential-alert-email-monitor.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  runCredentialAlertEmailMonitor,
  shouldEmailCredentialAlert,
} from "../src/alerts/credential-alert-email-monitor.js";
import type { AlertRecord } from "../src/alerts/repository.js";
import type { AuditEventRecord, RecordAuditEventInput } from "../src/audit/repository.js";

function alert(overrides: Partial<AlertRecord> = {}): AlertRecord {
  return {
    id: "alert_health_1",
    title: "Credential health changed to unhealthy",
    severity: "high",
    source: "credential-health",
    status: "active",
    credentialId: "cred_1",
    affectedSessions: 0,
    firstSeenAt: "2026-06-17T10:00:00.000Z",
    lastSeenAt: "2026-06-17T10:00:00.000Z",
    owner: null,
    runbook: "Inspect credential.",
    reason: "invalid_grant",
    ...overrides,
  } as AlertRecord;
}

function auditEvent(input: RecordAuditEventInput, index: number): AuditEventRecord {
  return {
    id: `audit_${index}`,
    timestamp: "2026-06-17T10:01:00.000Z",
    actor: input.actorUserId ?? "system",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    result: input.result,
    summary: input.summary ?? "",
    changedFields: [],
  };
}

test("credential alert monitor emails every platform admin for an active credential alert", async () => {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const auditEvents: RecordAuditEventInput[] = [];

  const result = await runCredentialAlertEmailMonitor({
    listAlerts: async () => [alert()],
    listPlatformAdminRecipients: async () => [
      { userId: "admin_1", email: "admin-one@example.test", name: "Admin One" },
      { userId: "admin_2", email: "ADMIN-ONE@example.test", name: "Duplicate" },
      { userId: "admin_3", email: "admin-two@example.test", name: "Admin Two" },
    ],
    listFallbackRecipients: async () => ["fallback@example.test"],
    sendEmail: async (input) => sent.push(input),
    audit: {
      async listEvents() {
        return [];
      },
      async recordEvent(input) {
        auditEvents.push(input);
      },
    },
    now: () => new Date("2026-06-17T10:01:00.000Z"),
  });

  assert.deepEqual(result, { evaluatedAlerts: 1, emailsSent: 2, recipients: 2 });
  assert.deepEqual(sent.map((entry) => entry.to), ["admin-one@example.test", "admin-two@example.test"]);
  assert.match(sent[0]?.subject ?? "", /Credential health changed to unhealthy/);
  assert.match(sent[0]?.text ?? "", /cred_1/);
  assert.ok(auditEvents.some((entry) => entry.action === "credential_alert.email.sent"));
});

test("credential alert monitor skips resolved alerts", async () => {
  assert.equal(shouldEmailCredentialAlert(alert({ status: "resolved" })), false);
});

test("credential alert monitor dedupes alert recipient and throttles same credential reason", async () => {
  const firstAuditEvents: RecordAuditEventInput[] = [];
  await runCredentialAlertEmailMonitor({
    listAlerts: async () => [alert()],
    listPlatformAdminRecipients: async () => [{ userId: "admin_1", email: "admin@example.test", name: null }],
    listFallbackRecipients: async () => [],
    sendEmail: async () => undefined,
    audit: {
      async listEvents() {
        return [];
      },
      async recordEvent(input) {
        firstAuditEvents.push(input);
      },
    },
    now: () => new Date("2026-06-17T10:00:00.000Z"),
  });

  const sent: unknown[] = [];
  const result = await runCredentialAlertEmailMonitor({
    listAlerts: async () => [alert({ id: "alert_health_2", firstSeenAt: "2026-06-17T10:05:00.000Z" })],
    listPlatformAdminRecipients: async () => [{ userId: "admin_1", email: "admin@example.test", name: null }],
    listFallbackRecipients: async () => [],
    sendEmail: async (input) => sent.push(input),
    audit: {
      async listEvents() {
        return firstAuditEvents.map(auditEvent);
      },
      async recordEvent() {
        assert.fail("throttled alert should not write send audit");
      },
    },
    now: () => new Date("2026-06-17T10:05:00.000Z"),
  });

  assert.deepEqual(result, { evaluatedAlerts: 1, emailsSent: 0, recipients: 1 });
  assert.deepEqual(sent, []);
});

test("credential alert monitor falls back to configured recipients when platform lookup fails", async () => {
  const sent: Array<{ to: string }> = [];
  const result = await runCredentialAlertEmailMonitor({
    listAlerts: async () => [alert()],
    listPlatformAdminRecipients: async () => {
      throw new Error("den_down");
    },
    listFallbackRecipients: async () => ["fallback@example.test"],
    sendEmail: async (input) => sent.push(input),
    audit: {
      async listEvents() {
        return [];
      },
      async recordEvent() {
        return;
      },
    },
    now: () => new Date("2026-06-17T10:00:00.000Z"),
  });

  assert.deepEqual(result, { evaluatedAlerts: 1, emailsSent: 1, recipients: 1 });
  assert.deepEqual(sent.map((entry) => entry.to), ["fallback@example.test"]);
});

test("credential alert monitor retries failed sends", async () => {
  const auditEvents: RecordAuditEventInput[] = [];
  await assert.rejects(
    runCredentialAlertEmailMonitor({
      listAlerts: async () => [alert()],
      listPlatformAdminRecipients: async () => [{ userId: "admin_1", email: "admin@example.test", name: null }],
      listFallbackRecipients: async () => [],
      sendEmail: async () => {
        throw new Error("lettr_down");
      },
      audit: {
        async listEvents() {
          return [];
        },
        async recordEvent(input) {
          auditEvents.push(input);
        },
      },
      now: () => new Date("2026-06-17T10:00:00.000Z"),
    }),
    /lettr_down/,
  );

  const sent: unknown[] = [];
  await runCredentialAlertEmailMonitor({
    listAlerts: async () => [alert()],
    listPlatformAdminRecipients: async () => [{ userId: "admin_1", email: "admin@example.test", name: null }],
    listFallbackRecipients: async () => [],
    sendEmail: async (input) => sent.push(input),
    audit: {
      async listEvents() {
        return auditEvents.map(auditEvent);
      },
      async recordEvent() {
        return;
      },
    },
    now: () => new Date("2026-06-17T10:01:00.000Z"),
  });

  assert.equal(sent.length, 1);
});
```

**Step 2: Run monitor tests to verify failure**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/credential-alert-email-monitor.test.ts
```

Expected: FAIL because the monitor file does not exist.

**Step 3: Implement the monitor**

Create `services/ai-gateway/src/alerts/credential-alert-email-monitor.ts`:

```ts
import { createHash } from "node:crypto";

import type { AlertRecord } from "./repository.js";
import type { AuditEventRecord, AuditRepository } from "../audit/repository.js";

const EMAIL_SENT_ACTION = "credential_alert.email.sent";
const EMAIL_FAILED_ACTION = "credential_alert.email.failed";
const EMAIL_SENT_ENTITY_TYPE = "credential_alert_email";
const EMAIL_THROTTLE_ENTITY_TYPE = "credential_alert_email_throttle";
const EMAIL_DEDUPE_EVENT_LIMIT = 5000;
const DEFAULT_THROTTLE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CredentialAlertRecipient = {
  userId?: string | null;
  email: string;
  name?: string | null;
};

export type CredentialAlertEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export type CredentialAlertEmailMonitorDeps = {
  listAlerts: () => Promise<AlertRecord[]>;
  listPlatformAdminRecipients: () => Promise<CredentialAlertRecipient[]>;
  listFallbackRecipients: () => Promise<string[]>;
  sendEmail: (input: CredentialAlertEmailInput) => Promise<void>;
  audit: Pick<AuditRepository, "recordEvent" | "listEvents">;
  now?: () => Date;
  throttleWindowMs?: number;
  state?: { sentKeys: Set<string> };
};

export type CredentialAlertEmailMonitorResult = {
  evaluatedAlerts: number;
  emailsSent: number;
  recipients: number;
  skipped?: boolean;
};

export function createCredentialAlertEmailMonitorRunner(
  deps: CredentialAlertEmailMonitorDeps,
): () => Promise<CredentialAlertEmailMonitorResult> {
  let inFlight: Promise<CredentialAlertEmailMonitorResult> | null = null;
  const state = deps.state ?? { sentKeys: new Set<string>() };

  return () => {
    if (inFlight) {
      return Promise.resolve({ evaluatedAlerts: 0, emailsSent: 0, recipients: 0, skipped: true });
    }

    const run = runCredentialAlertEmailMonitor({ ...deps, state }).finally(() => {
      if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run;
  };
}

export async function runCredentialAlertEmailMonitor(deps: CredentialAlertEmailMonitorDeps) {
  const now = deps.now?.() ?? new Date();
  const alerts = (await deps.listAlerts()).filter(shouldEmailCredentialAlert);
  const recipients = await resolveRecipients(deps);

  if (alerts.length === 0 || recipients.length === 0) {
    return { evaluatedAlerts: alerts.length, emailsSent: 0, recipients: recipients.length };
  }

  const sentKeys = await listAlreadySentKeys(deps.audit, now, deps.throttleWindowMs ?? DEFAULT_THROTTLE_WINDOW_MS);
  for (const key of deps.state?.sentKeys ?? []) sentKeys.add(key);

  let emailsSent = 0;
  const failures: Error[] = [];

  for (const alert of alerts) {
    const email = buildCredentialAlertEmail(alert);
    for (const recipient of recipients) {
      const alertKey = buildAlertRecipientKey(alert.id, recipient.email);
      const throttleKey = buildThrottleKey(alert, recipient.email);
      if (sentKeys.has(alertKey) || sentKeys.has(throttleKey)) continue;

      try {
        await deps.sendEmail({ to: recipient.email, ...email });
        emailsSent += 1;
        sentKeys.add(alertKey);
        sentKeys.add(throttleKey);
        deps.state?.sentKeys.add(alertKey);
        deps.state?.sentKeys.add(throttleKey);
        await recordSent(deps.audit, alert, recipient.email, alertKey, throttleKey);
      } catch (error) {
        failures.push(toError(error));
        await recordFailedBestEffort(deps.audit, alert, recipient.email, alertKey, error);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to send ${failures.length} credential alert email${failures.length === 1 ? "" : "s"}: ${failures.map((error) => error.message).join("; ")}`);
  }

  return { evaluatedAlerts: alerts.length, emailsSent, recipients: recipients.length };
}

export function shouldEmailCredentialAlert(alert: AlertRecord): boolean {
  if (alert.status !== "active") return false;
  if (alert.source === "codex-capacity" || alert.source === "codex-capacity-visibility") return false;
  if (alert.credentialId) return true;
  return [
    "credential-health",
    "provider-auth",
    "provider-rate-limit",
    "gateway-operations",
    "provider-availability",
  ].includes(alert.source);
}

export function buildCredentialAlertEmail(alert: AlertRecord) {
  const severity = alert.severity.toUpperCase();
  const subject = `[${severity}] Veslo credential alert: ${alert.title}`;
  const reason = readAlertReason(alert);
  const lines = [
    alert.title,
    "",
    `Severity: ${alert.severity}`,
    `Source: ${alert.source}`,
    `Credential: ${alert.credentialId ?? "credential pool"}`,
    reason ? `Reason: ${reason}` : null,
    `First seen: ${alert.firstSeenAt}`,
    `Last seen: ${alert.lastSeenAt}`,
    "",
    alert.runbook,
  ].filter((line): line is string => typeof line === "string");

  const text = lines.join("\n");
  return {
    subject,
    text,
    html: text.split("\n").map((line) => line ? `<p>${escapeHtml(line)}</p>` : "<br>").join(""),
  };
}

async function resolveRecipients(deps: CredentialAlertEmailMonitorDeps): Promise<CredentialAlertRecipient[]> {
  try {
    const platform = uniqueRecipients(await deps.listPlatformAdminRecipients());
    if (platform.length > 0) return platform;
  } catch (error) {
    console.error("credential_alert_platform_admin_recipient_lookup_failed", error);
  }

  return uniqueRecipients((await deps.listFallbackRecipients()).map((email) => ({ email })));
}

async function listAlreadySentKeys(
  audit: Pick<AuditRepository, "listEvents">,
  now: Date,
  throttleWindowMs: number,
): Promise<Set<string>> {
  if (!audit.listEvents) return new Set();
  const minimumTimestampMs = now.getTime() - throttleWindowMs;
  const events = await audit.listEvents({ limit: EMAIL_DEDUPE_EVENT_LIMIT });
  return new Set(
    events
      .filter((event) => event.action === EMAIL_SENT_ACTION)
      .filter((event) => event.entityType === EMAIL_SENT_ENTITY_TYPE || event.entityType === EMAIL_THROTTLE_ENTITY_TYPE)
      .filter((event) => isRecentEvent(event, minimumTimestampMs))
      .map((event) => event.entityId),
  );
}

async function recordSent(
  audit: Pick<AuditRepository, "recordEvent">,
  alert: AlertRecord,
  recipient: string,
  alertKey: string,
  throttleKey: string,
) {
  await audit.recordEvent({
    actorUserId: "system",
    entityType: EMAIL_SENT_ENTITY_TYPE,
    entityId: alertKey,
    action: EMAIL_SENT_ACTION,
    result: "ok",
    summary: `Sent ${alert.title} credential alert email to ${recipient}.`,
  });
  await audit.recordEvent({
    actorUserId: "system",
    entityType: EMAIL_THROTTLE_ENTITY_TYPE,
    entityId: throttleKey,
    action: EMAIL_SENT_ACTION,
    result: "ok",
    summary: `Recorded ${alert.title} credential alert throttle for ${recipient}.`,
  });
}

async function recordFailedBestEffort(
  audit: Pick<AuditRepository, "recordEvent">,
  alert: AlertRecord,
  recipient: string,
  alertKey: string,
  error: unknown,
) {
  try {
    await audit.recordEvent({
      actorUserId: "system",
      entityType: EMAIL_SENT_ENTITY_TYPE,
      entityId: alertKey,
      action: EMAIL_FAILED_ACTION,
      result: "error",
      summary: `Failed to send ${alert.title} credential alert email to ${recipient}: ${toError(error).message}`,
    });
  } catch {
    return;
  }
}

function uniqueRecipients(input: CredentialAlertRecipient[]): CredentialAlertRecipient[] {
  const seen = new Set<string>();
  const recipients: CredentialAlertRecipient[] = [];
  for (const entry of input) {
    const email = entry.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    recipients.push({ ...entry, email });
  }
  return recipients;
}

function buildAlertRecipientKey(alertId: string, recipient: string) {
  return `alert:${alertId}:${hashRecipient(recipient)}`;
}

function buildThrottleKey(alert: AlertRecord, recipient: string) {
  const credentialKey = alert.credentialId ?? "credential-pool";
  return `credential:${credentialKey}:${hashText(normalizeReason(readAlertReason(alert) ?? alert.title))}:${hashRecipient(recipient)}`;
}

function readAlertReason(alert: AlertRecord): string | null {
  const reason = (alert as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

function normalizeReason(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function hashRecipient(value: string) {
  return hashText(value.trim().toLowerCase()).slice(0, 20);
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecentEvent(event: AuditEventRecord, minimumTimestampMs: number) {
  const timestampMs = Date.parse(event.timestamp);
  return Number.isFinite(timestampMs) && timestampMs >= minimumTimestampMs;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
```

**Step 4: Run monitor tests**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/credential-alert-email-monitor.test.ts
```

Expected: pass.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/alerts/credential-alert-email-monitor.ts services/ai-gateway/test/credential-alert-email-monitor.test.ts
git commit -m "feat: add credential alert email monitor"
```

---

### Task 4: Preserve Alert Reasons In Admin Alert Records

**Files:**
- Modify: `services/ai-gateway/src/alerts/repository.ts`
- Modify: `services/ai-gateway/src/alerts/mysql-repository.ts`
- Test: `services/ai-gateway/test/admin-alerts.test.ts`

**Step 1: Write failing alert reason test**

In `services/ai-gateway/test/admin-alerts.test.ts`, add:

```ts
test("buildAlertRecord preserves the health event reason for email throttling", () => {
  const alert = buildAlertRecord({
    eventId: "health_invalid_grant",
    credentialId: "cred_openai_1",
    reason: "invalid_grant",
    toState: "unhealthy",
    occurredAt: "2026-06-17T10:00:00.000Z",
    affectedSessions: 1,
  });

  assert.equal(alert.reason, "invalid_grant");
});
```

**Step 2: Run test to verify failure**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/admin-alerts.test.ts
```

Expected: FAIL because `AlertRecord` does not expose `reason`.

**Step 3: Add optional reason to AlertRecord**

Modify `services/ai-gateway/src/alerts/repository.ts`:

```ts
export type AlertRecord = {
  id: string;
  title: string;
  severity: "critical" | "high" | "medium";
  source: string;
  status: "active" | "acknowledged" | "resolved";
  credentialId: string | null;
  reason?: string | null;
  affectedSessions: number;
  firstSeenAt: string;
  lastSeenAt: string;
  owner: string | null;
  runbook: string;
};
```

Modify every branch in `buildAlertRecord` in `services/ai-gateway/src/alerts/mysql-repository.ts` to add:

```ts
reason: input.reason,
```

**Step 4: Run alert tests**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/admin-alerts.test.ts test/admin-actions.test.ts test/admin-ui.test.ts
```

Expected: pass.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/alerts services/ai-gateway/test
git commit -m "feat: expose credential alert reasons"
```

---

### Task 5: Integrate Credential Alert Monitor Into AI Gateway Admin Service

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/src/index.ts`
- Test: `services/ai-gateway/test/admin-alerts.test.ts`

**Step 1: Write failing service integration test**

Add to `services/ai-gateway/test/admin-alerts.test.ts`:

```ts
test("default admin service sends credential alert emails through the monitor", async () => {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const auditEvents: Record<string, string>[] = [];
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: {
      ...createDenClient(),
      async listPlatformAdminRecipients() {
        return [{ userId: "admin_1", email: "admin@example.test", name: "Admin" }];
      },
    },
    alertEmailRecipients: ["fallback@example.test"],
    sendAlertEmail: async (input: { to: string; subject: string; text: string }) => {
      sent.push(input);
    },
    alertRepository: {
      async listAlerts() {
        return [{
          id: "alert_health_1",
          title: "Credential health changed to unhealthy",
          severity: "high",
          source: "credential-health",
          status: "active",
          credentialId: "cred_1",
          reason: "invalid_grant",
          affectedSessions: 0,
          firstSeenAt: "2026-06-17T10:00:00.000Z",
          lastSeenAt: "2026-06-17T10:00:00.000Z",
          owner: null,
          runbook: "Rotate credential.",
        }];
      },
    },
    auditRepository: {
      async listEvents() {
        return [];
      },
      async recordEvent(input) {
        auditEvents.push({ action: input.action, entityType: input.entityType, entityId: input.entityId });
      },
    },
    now: () => new Date("2026-06-17T10:01:00.000Z"),
  } as never) as ReturnType<typeof createDefaultAdminService> & {
    runCredentialAlertEmailMonitor(): Promise<{ evaluatedAlerts: number; emailsSent: number; recipients: number }>;
  };

  const result = await service.runCredentialAlertEmailMonitor();
  assert.deepEqual(result, { evaluatedAlerts: 1, emailsSent: 1, recipients: 1 });
  assert.deepEqual(sent.map((entry) => entry.to), ["admin@example.test"]);
  assert.ok(auditEvents.some((entry) => entry.action === "credential_alert.email.sent"));
});
```

**Step 2: Run test to verify failure**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/admin-alerts.test.ts
```

Expected: FAIL because `runCredentialAlertEmailMonitor` does not exist.

**Step 3: Add AdminService dependency surface**

Modify `services/ai-gateway/src/http/admin.ts`:

```ts
import {
  createCredentialAlertEmailMonitorRunner,
  type CredentialAlertEmailInput,
  type CredentialAlertEmailMonitorResult,
} from "../alerts/credential-alert-email-monitor.js";
import { sendAdminAlertEmail } from "../email/admin-alert-mailer.js";
```

Add to `AdminService`:

```ts
runCredentialAlertEmailMonitor?(): Promise<CredentialAlertEmailMonitorResult>;
```

Add to `AdminReadModelDependencies`:

```ts
alertEmailRecipients?: string[];
sendAlertEmail?: (input: CredentialAlertEmailInput) => Promise<void>;
```

Add to `DenAdminApi`:

```ts
listPlatformAdminRecipients?(token: string | null): Promise<Array<{ userId: string; email: string; name: string | null }>>;
```

**Step 4: Wire runner creation**

Inside `createDefaultAdminService`:

```ts
const alertEmailRecipients = deps.alertEmailRecipients ?? env.alertEmail.recipients;
const sendAlertEmail = deps.sendAlertEmail ?? sendAdminAlertEmail;
let credentialAlertEmailRunner: (() => Promise<CredentialAlertEmailMonitorResult>) | null = null;

function getCredentialAlertEmailRunner() {
  if (!credentialAlertEmailRunner) {
    credentialAlertEmailRunner = createCredentialAlertEmailMonitorRunner({
      listAlerts: () => getAlertRepository().listAlerts(),
      listPlatformAdminRecipients: async () => {
        const listRecipients = denClient.listPlatformAdminRecipients;
        if (!listRecipients) return [];
        return listRecipients.call(denClient, env.denInternalToken);
      },
      listFallbackRecipients: async () => alertEmailRecipients,
      sendEmail: sendAlertEmail,
      audit: getAuditRepository(),
      now,
    });
  }
  return credentialAlertEmailRunner;
}
```

Return method:

```ts
async runCredentialAlertEmailMonitor() {
  return getCredentialAlertEmailRunner()();
}
```

**Step 5: Start background loop**

Modify `services/ai-gateway/src/index.ts`:

```ts
function startCredentialAlertEmailLoop(adminService: AdminService) {
  if (!adminService.runCredentialAlertEmailMonitor) return;
  if (!isAdminAlertEmailConfigured()) {
    console.warn("[ai-gateway] Credential alert emails disabled: Lettr email env is not configured");
    return;
  }

  const runMonitorBestEffort = () => {
    void adminService.runCredentialAlertEmailMonitor?.().catch((error) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`[ai-gateway] Credential alert email monitor failed: ${message}`);
    });
  };

  runMonitorBestEffort();
  const interval = setInterval(runMonitorBestEffort, env.alertEmail.credentialAlertIntervalMs);
  unrefTimer(interval);
}
```

Call it in `startServer()` after the existing capacity loop:

```ts
startCredentialAlertEmailLoop(adminService);
```

Do not require fallback recipients to be configured before starting. The monitor can still resolve DEN platform admins dynamically.

**Step 6: Run integration tests**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/admin-alerts.test.ts test/env.test.ts test/alert-mailer.test.ts test/credential-alert-email-monitor.test.ts
```

Expected: pass.

**Step 7: Commit**

```bash
git add services/ai-gateway/src services/ai-gateway/test
git commit -m "feat: run credential alert email monitor"
```

---

### Task 6: Ensure Provider And Credential Faults Produce Repository Alerts

**Files:**
- Modify: `services/ai-gateway/src/alerts/repository.ts`
- Modify: `services/ai-gateway/src/alerts/mysql-repository.ts`
- Modify: `services/ai-gateway/src/http/providers/openai.ts`
- Modify: `services/ai-gateway/src/http/providers/anthropic.ts`
- Modify: `services/ai-gateway/src/http/providers/openai-compatible.ts`
- Modify: `services/ai-gateway/src/http/providers/codex-oauth.ts`
- Test: `services/ai-gateway/test/proxy.test.ts`
- Test: `services/ai-gateway/test/codex-oauth-proxy.test.ts`
- Test: `services/ai-gateway/test/proxy-openai-compatible.test.ts`

**Step 1: Write failing tests for email-relevant alert production**

Extend existing proxy tests:

```ts
test("permanent provider credential failure marks the credential unhealthy for alert email pickup", async () => {
  // Use the existing proxy test harness.
  // Arrange transport to throw ProviderTransportError with code "invalid_api_key".
  // Assert credentials.markCredentialState is called with state "unhealthy" and reason including "invalid_api_key".
});
```

Extend Codex proxy test:

```ts
test("Codex auth upstream failure records a credential alert for email pickup", async () => {
  // Arrange codexOAuthTransport.chatCompletions to throw ProviderTransportError with statusCode 401.
  // Assert the alert repository receives provider "codex_oauth" and reason "authentication_error" or "codex_oauth_upstream_auth_failed".
});
```

Extend OpenAI-compatible test:

```ts
test("openai-compatible upstream fetch failure records credential alert for email pickup", async () => {
  // Existing route already returns openai_compatible_request_failed.
  // Assert alertRepository.recordProviderFailure is called with the assigned credential id.
});
```

**Step 2: Run tests to verify failure**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/proxy.test.ts test/codex-oauth-proxy.test.ts test/proxy-openai-compatible.test.ts
```

Expected: at least the new permanent/auth alert tests fail until provider routes record these failures.

**Step 3: Implement alert production rules**

Keep request validation and policy errors out of alerting.

For provider routes:

- On network/proxy failures, call `recordProviderProxyFailureAlert`.
- On permanent credential failures, mark the credential `unhealthy` through `credentials.markCredentialState` with the upstream code/reason.
- On assigned Codex/OpenAI-compatible auth failures, record a provider failure alert when there is no token broker path that can mark state.

Example helper shape:

```ts
async function markPermanentCredentialFailure(input: {
  credentials: ProxyDependencies["credentials"];
  bindingId: string;
  failureCode: string;
}) {
  const credential = await input.credentials.getCredentialRecordByBindingId?.(input.bindingId);
  if (!credential || !input.credentials.markCredentialState) return;
  await input.credentials.markCredentialState({
    credentialRecordId: credential.id,
    state: "unhealthy",
    reason: input.failureCode,
  });
}
```

For routes with assigned credential id but no binding lookup:

```ts
await deps.alertRepository?.recordProviderFailure?.({
  credentialId: assignedBinding.credentialRecordId,
  provider: "codex_oauth",
  sessionId,
  reason: "authentication_error",
});
```

**Step 4: Run proxy tests**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/proxy.test.ts test/codex-oauth-proxy.test.ts test/proxy-openai-compatible.test.ts
```

Expected: pass.

**Step 5: Commit**

```bash
git add services/ai-gateway/src services/ai-gateway/test
git commit -m "feat: surface provider credential faults as alerts"
```

---

### Task 7: Update Docs And Operator Configuration

**Files:**
- Modify: `docs/admin-managed-ai-access.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify as needed: `packaging/owned-server/compose.yml`
- Modify as needed: owned-server env documentation

**Step 1: Update docs**

Document:

- `DEN_AI_GATEWAY_INTERNAL_TOKEN` on DEN.
- `AI_GATEWAY_DEN_INTERNAL_TOKEN` on AI Gateway.
- `LETTR_API_KEY`, `AUTH_EMAIL_ADDRESS`, `AUTH_EMAIL_FROM_NAME`.
- `AI_GATEWAY_ALERT_EMAIL_RECIPIENTS` as fallback only.
- `AI_GATEWAY_CREDENTIAL_ALERT_EMAIL_INTERVAL_MS`, default 60 seconds.
- Credential/account faults that email admins.
- Errors intentionally not emailed.

**Step 2: Verify compose/env references**

Run:

```bash
rg -n "AI_GATEWAY_|DEN_AI_GATEWAY_INTERNAL_TOKEN|LETTR|AUTH_EMAIL|ALERT_EMAIL" packaging docs services
```

Expected: docs and packaging mention the new envs where operators need them.

**Step 3: Commit**

```bash
git add docs packaging
git commit -m "docs: document credential alert email configuration"
```

---

### Task 8: Full Verification

**Files:**
- Verify: all modified files.

**Step 1: Run focused DEN tests**

Run:

```bash
pnpm --dir services/den exec tsx --test test/internal-platform-admin-recipients.test.ts test/debug-log-env.test.ts test/admin-runtime-bootstrap.test.ts
```

Expected: pass.

**Step 2: Run focused AI Gateway tests**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/credential-alert-email-monitor.test.ts test/admin-alerts.test.ts test/env.test.ts test/alert-mailer.test.ts test/proxy.test.ts test/codex-oauth-proxy.test.ts test/proxy-openai-compatible.test.ts
```

Expected: pass.

**Step 3: Build AI Gateway and DEN**

Run:

```bash
pnpm --dir services/ai-gateway build
pnpm --dir services/den build
```

Expected: both builds exit 0.

**Step 4: Production-safe deployment verification**

After deploy:

1. Verify both DEN and AI Gateway containers have matching internal token env vars set.
2. From the AI Gateway container, call the DEN internal recipients endpoint with the configured token and verify a non-empty recipient list.
3. Insert or trigger a synthetic test credential health event on a test credential.
4. Run or wait for the credential alert email monitor.
5. Verify every platform admin receives the test email.
6. Verify the same test alert does not email again on the next monitor run.
7. Resolve the synthetic alert or delete the test credential if created solely for validation.

Do not use a real production inference credential for destructive validation.
