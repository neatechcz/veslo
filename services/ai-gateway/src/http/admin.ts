import express, { Router } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AdminSessionUser = {
  id: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
};

export type AdminSessionOrganization = {
  id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  role: "owner" | "member";
};

export type AdminSessionSnapshot = {
  user: AdminSessionUser;
  platformAdmin: boolean;
  activeOrgId: string | null;
  organizations: AdminSessionOrganization[];
};

export type AdminUserRecord = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  platformAdmin: boolean;
  disabled: boolean;
  memberships: Array<{
    membershipId: string;
    orgId: string;
    orgName: string;
    orgSlug: string;
    role: "owner" | "member";
  }>;
};

export type CredentialRecord = {
  id: string;
  name: string;
  provider: string;
  type: "api_key" | "oauth";
  state: "healthy" | "degraded" | "draining" | "unhealthy" | "revoked";
  scope: string;
  activeLeases: number;
  alertCount: number;
  lastRefreshAt: string;
  lastFailureAt: string | null;
  totalTokens: number;
  nextRotationAt: string | null;
  linkedAlertIds: string[];
};

export type SessionRecord = {
  id: string;
  userLabel: string;
  orgLabel: string;
  projectLabel: string;
  workerLabel: string;
  credentialId: string;
  state: "healthy" | "degraded" | "rebound";
  retries: number;
  lastSeenAt: string;
  lastFailoverAt: string | null;
};

export type AlertRecord = {
  id: string;
  title: string;
  severity: "critical" | "high" | "medium";
  source: string;
  status: "active" | "acknowledged" | "resolved";
  credentialId: string | null;
  affectedSessions: number;
  firstSeenAt: string;
  lastSeenAt: string;
  owner: string | null;
  runbook: string;
};

export type AuditRecord = {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  result: "ok" | "warning";
  summary: string;
  changedFields: string[];
};

export type UsageSummary = {
  totalTokens: number;
  totalRequests: number;
};

export type UsageGroupBy = "total" | "credential" | "user" | "org";

export type UsageResponse = {
  summary: UsageSummary;
  groupBy: UsageGroupBy;
  filters: {
    credentials: Array<{ id: string; label: string }>;
    users: Array<{ id: string; label: string }>;
    orgs: Array<{ id: string; label: string }>;
  };
  series: Array<{ key: string; label: string; totalTokens: number; totalRequests: number }>;
  topCredentials: Array<{ id: string; label: string; totalTokens: number }>;
  topUsers: Array<{ id: string; label: string; totalTokens: number }>;
  topOrgs: Array<{ id: string; label: string; totalTokens: number }>;
};

export type AuthPayload = {
  token: string;
  denApiBase: string;
  session: AdminSessionSnapshot;
};

export type CreateUserInput = {
  email: string;
  name: string;
  platformAdmin: boolean;
  orgId?: string | null;
  orgRole?: "owner" | "member";
};

export type UpdateUserInput = {
  name?: string;
  platformAdmin?: boolean;
};

export interface AdminService {
  signIn(input: { email: string; password: string }): Promise<AuthPayload>;
  getSession(token: string): Promise<AdminSessionSnapshot>;
  listUsers(token: string): Promise<AdminUserRecord[]>;
  createUser(token: string, input: CreateUserInput): Promise<AdminUserRecord>;
  updateUser(token: string, userId: string, input: UpdateUserInput): Promise<AdminUserRecord>;
  disableUser(token: string, userId: string): Promise<AdminUserRecord>;
  enableUser(token: string, userId: string): Promise<AdminUserRecord>;
  deleteUser(token: string, userId: string): Promise<void>;
  listCredentials(_token: string): Promise<{ credentials: CredentialRecord[] }>;
  listSessions(_token: string): Promise<{ sessions: SessionRecord[] }>;
  getUsage(_token: string, input: { groupBy: UsageGroupBy; credentialId: string | null; userId: string | null; orgId: string | null }): Promise<UsageResponse>;
  listAlerts(_token: string): Promise<{ alerts: AlertRecord[] }>;
  listAudit(_token: string): Promise<{ events: AuditRecord[] }>;
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type UsageEvent = {
  id: string;
  credentialId: string;
  credentialLabel: string;
  userId: string;
  userLabel: string;
  orgId: string;
  orgLabel: string;
  totalTokens: number;
  totalRequests: number;
};

class InMemoryAdminReadModel {
  private readonly credentials: CredentialRecord[] = [
    {
      id: "cred_openai_shared_a",
      name: "OpenAI Shared Pool A",
      provider: "openai",
      type: "oauth",
      state: "healthy",
      scope: "shared_pool",
      activeLeases: 14,
      alertCount: 1,
      lastRefreshAt: "2026-03-31T12:40:00.000Z",
      lastFailureAt: null,
      totalTokens: 184220,
      nextRotationAt: "2026-04-07T06:00:00.000Z",
      linkedAlertIds: ["alert_invalid_grant_pool_a"],
    },
    {
      id: "cred_openai_ent_nova",
      name: "OpenAI Nova Enterprise",
      provider: "openai",
      type: "oauth",
      state: "degraded",
      scope: "enterprise_override",
      activeLeases: 6,
      alertCount: 2,
      lastRefreshAt: "2026-03-31T12:10:00.000Z",
      lastFailureAt: "2026-03-31T14:05:00.000Z",
      totalTokens: 98240,
      nextRotationAt: "2026-04-01T06:30:00.000Z",
      linkedAlertIds: ["alert_nova_failover", "alert_nova_invalid_grant"],
    },
    {
      id: "cred_anthropic_shared_b",
      name: "Anthropic Shared Pool B",
      provider: "anthropic",
      type: "api_key",
      state: "healthy",
      scope: "shared_pool",
      activeLeases: 9,
      alertCount: 0,
      lastRefreshAt: "2026-03-31T11:55:00.000Z",
      lastFailureAt: null,
      totalTokens: 74210,
      nextRotationAt: null,
      linkedAlertIds: [],
    },
  ];

  private readonly sessions: SessionRecord[] = [
    {
      id: "sess_proj_alpha",
      userLabel: "Vaclav Soukup",
      orgLabel: "Vaclav Soukup",
      projectLabel: "Pricing migration",
      workerLabel: "local-runtime-a",
      credentialId: "cred_openai_shared_a",
      state: "healthy",
      retries: 0,
      lastSeenAt: "2026-03-31T14:20:00.000Z",
      lastFailoverAt: null,
    },
    {
      id: "sess_nova_triage",
      userLabel: "Ops Console",
      orgLabel: "Nova Labs",
      projectLabel: "Credential outage triage",
      workerLabel: "local-runtime-b",
      credentialId: "cred_openai_ent_nova",
      state: "rebound",
      retries: 2,
      lastSeenAt: "2026-03-31T14:24:00.000Z",
      lastFailoverAt: "2026-03-31T14:09:00.000Z",
    },
    {
      id: "sess_anthropic_ops",
      userLabel: "Team Router",
      orgLabel: "Personal",
      projectLabel: "Summaries",
      workerLabel: "local-runtime-c",
      credentialId: "cred_anthropic_shared_b",
      state: "degraded",
      retries: 1,
      lastSeenAt: "2026-03-31T14:18:00.000Z",
      lastFailoverAt: null,
    },
  ];

  private readonly alerts: AlertRecord[] = [
    {
      id: "alert_invalid_grant_pool_a",
      title: "Refresh token retries increasing",
      severity: "medium",
      source: "token-broker",
      status: "active",
      credentialId: "cred_openai_shared_a",
      affectedSessions: 3,
      firstSeenAt: "2026-03-31T12:45:00.000Z",
      lastSeenAt: "2026-03-31T14:15:00.000Z",
      owner: "platform",
      runbook: "Inspect token refresh failures and verify fallback threshold.",
    },
    {
      id: "alert_nova_failover",
      title: "Nova enterprise failover storm",
      severity: "critical",
      source: "lease-broker",
      status: "active",
      credentialId: "cred_openai_ent_nova",
      affectedSessions: 6,
      firstSeenAt: "2026-03-31T13:58:00.000Z",
      lastSeenAt: "2026-03-31T14:22:00.000Z",
      owner: "on-call",
      runbook: "Drain unhealthy credential and inspect replacement binding saturation.",
    },
    {
      id: "alert_nova_invalid_grant",
      title: "invalid_grant returned by upstream OAuth",
      severity: "high",
      source: "provider-auth",
      status: "acknowledged",
      credentialId: "cred_openai_ent_nova",
      affectedSessions: 4,
      firstSeenAt: "2026-03-31T13:52:00.000Z",
      lastSeenAt: "2026-03-31T14:04:00.000Z",
      owner: "vaclav.soukup@neatec.cz",
      runbook: "Rotate the underlying grant and monitor session rebound counts.",
    },
  ];

  private readonly usageEvents: UsageEvent[] = [
    {
      id: "usage_1",
      credentialId: "cred_openai_shared_a",
      credentialLabel: "OpenAI Shared Pool A",
      userId: "user_vaclav",
      userLabel: "Vaclav Soukup",
      orgId: "org_personal",
      orgLabel: "Vaclav Soukup",
      totalTokens: 82440,
      totalRequests: 28,
    },
    {
      id: "usage_2",
      credentialId: "cred_openai_ent_nova",
      credentialLabel: "OpenAI Nova Enterprise",
      userId: "user_ops",
      userLabel: "Ops Console",
      orgId: "org_nova",
      orgLabel: "Nova Labs",
      totalTokens: 58210,
      totalRequests: 17,
    },
    {
      id: "usage_3",
      credentialId: "cred_openai_ent_nova",
      credentialLabel: "OpenAI Nova Enterprise",
      userId: "user_vaclav",
      userLabel: "Vaclav Soukup",
      orgId: "org_personal",
      orgLabel: "Vaclav Soukup",
      totalTokens: 40030,
      totalRequests: 9,
    },
    {
      id: "usage_4",
      credentialId: "cred_anthropic_shared_b",
      credentialLabel: "Anthropic Shared Pool B",
      userId: "user_router",
      userLabel: "Team Router",
      orgId: "org_personal",
      orgLabel: "Vaclav Soukup",
      totalTokens: 74210,
      totalRequests: 31,
    },
  ];

  private readonly auditEvents: AuditRecord[] = [
    {
      id: "audit_credential_rotation",
      timestamp: "2026-03-31T14:03:00.000Z",
      actor: "vaclav.soukup@neatec.cz",
      action: "credential.rotate",
      entityType: "credential",
      entityId: "cred_openai_ent_nova",
      result: "ok",
      summary: "Rotated the Nova enterprise OAuth credential after repeated invalid_grant responses.",
      changedFields: ["nextRotationAt", "lastRefreshAt"],
    },
    {
      id: "audit_alert_ack",
      timestamp: "2026-03-31T14:06:00.000Z",
      actor: "vaclav.soukup@neatec.cz",
      action: "alert.acknowledge",
      entityType: "alert",
      entityId: "alert_nova_invalid_grant",
      result: "ok",
      summary: "Acknowledged the upstream OAuth invalid_grant alert.",
      changedFields: ["status", "owner"],
    },
  ];

  listCredentials() {
    return this.credentials.map((entry) => ({ ...entry }));
  }

  listSessions() {
    return this.sessions.map((entry) => ({ ...entry }));
  }

  listAlerts() {
    return this.alerts.map((entry) => ({ ...entry }));
  }

  listAudit() {
    return this.auditEvents.map((entry) => ({ ...entry }));
  }

  pushAudit(entry: AuditRecord) {
    this.auditEvents.unshift(entry);
    this.auditEvents.splice(80);
  }

  getUsage(input: { groupBy: UsageGroupBy; credentialId: string | null; userId: string | null; orgId: string | null }): UsageResponse {
    const filtered = this.usageEvents.filter((event) => {
      if (input.credentialId && event.credentialId !== input.credentialId) {
        return false;
      }
      if (input.userId && event.userId !== input.userId) {
        return false;
      }
      if (input.orgId && event.orgId !== input.orgId) {
        return false;
      }
      return true;
    });

    const summary = filtered.reduce<UsageSummary>(
      (acc, event) => ({
        totalTokens: acc.totalTokens + event.totalTokens,
        totalRequests: acc.totalRequests + event.totalRequests,
      }),
      { totalTokens: 0, totalRequests: 0 },
    );

    const groupBy = input.groupBy;
    const buckets = new Map<string, { label: string; totalTokens: number; totalRequests: number }>();
    const bucketFor = (event: UsageEvent) => {
      if (groupBy === "credential") {
        return { key: event.credentialId, label: event.credentialLabel };
      }
      if (groupBy === "user") {
        return { key: event.userId, label: event.userLabel };
      }
      if (groupBy === "org") {
        return { key: event.orgId, label: event.orgLabel };
      }
      return { key: "total", label: "Total usage" };
    };

    for (const event of filtered) {
      const bucket = bucketFor(event);
      const existing = buckets.get(bucket.key) ?? { label: bucket.label, totalTokens: 0, totalRequests: 0 };
      existing.totalTokens += event.totalTokens;
      existing.totalRequests += event.totalRequests;
      buckets.set(bucket.key, existing);
    }

    const series = Array.from(buckets.entries()).map(([key, value]) => ({
      key,
      label: value.label,
      totalTokens: value.totalTokens,
      totalRequests: value.totalRequests,
    }));

    const topCredentials = aggregateTop(filtered, (entry) => ({ id: entry.credentialId, label: entry.credentialLabel }));
    const topUsers = aggregateTop(filtered, (entry) => ({ id: entry.userId, label: entry.userLabel }));
    const topOrgs = aggregateTop(filtered, (entry) => ({ id: entry.orgId, label: entry.orgLabel }));

    return {
      summary,
      groupBy,
      filters: {
        credentials: uniqueLabels(filtered.map((entry) => ({ id: entry.credentialId, label: entry.credentialLabel }))),
        users: uniqueLabels(filtered.map((entry) => ({ id: entry.userId, label: entry.userLabel }))),
        orgs: uniqueLabels(filtered.map((entry) => ({ id: entry.orgId, label: entry.orgLabel }))),
      },
      series,
      topCredentials,
      topUsers,
      topOrgs,
    };
  }
}

function uniqueLabels(entries: Array<{ id: string; label: string }>) {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    if (!seen.has(entry.id)) {
      seen.set(entry.id, entry.label);
    }
  }
  return Array.from(seen.entries()).map(([id, label]) => ({ id, label }));
}

function aggregateTop(
  events: UsageEvent[],
  pick: (entry: UsageEvent) => { id: string; label: string },
) {
  const buckets = new Map<string, { label: string; totalTokens: number }>();
  for (const event of events) {
    const bucket = pick(event);
    const existing = buckets.get(bucket.id) ?? { label: bucket.label, totalTokens: 0 };
    existing.totalTokens += event.totalTokens;
    buckets.set(bucket.id, existing);
  }
  return Array.from(buckets.entries())
    .map(([id, value]) => ({ id, label: value.label, totalTokens: value.totalTokens }))
    .sort((left, right) => right.totalTokens - left.totalTokens);
}

class DenAdminClient {
  constructor(private readonly denApiBase: string) {}

  private async requestJson(pathname: string, init: RequestInit = {}) {
    const response = await fetch(`${this.denApiBase}${pathname}`, init);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        typeof payload?.error === "string"
          ? payload.error
          : typeof payload?.message === "string"
            ? payload.message
            : "request_failed";
      throw new HttpError(message, response.status);
    }
    return payload;
  }

  async signIn(input: { email: string; password: string }) {
    return this.requestJson("/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(input),
    });
  }

  async getSession(token: string) {
    return this.requestJson("/v1/admin/session", {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    }) as Promise<AdminSessionSnapshot>;
  }

  async listUsers(token: string) {
    const payload = await this.requestJson("/v1/admin/users", {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    }) as { users: AdminUserRecord[] };
    return payload.users;
  }

  async createUser(token: string, input: CreateUserInput) {
    const payload = await this.requestJson("/v1/admin/users", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
    }) as { user: AdminUserRecord };
    return payload.user;
  }

  async updateUser(token: string, userId: string, input: UpdateUserInput) {
    const payload = await this.requestJson(`/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
    }) as { user: AdminUserRecord };
    return payload.user;
  }

  async disableUser(token: string, userId: string) {
    const payload = await this.requestJson(`/v1/admin/users/${encodeURIComponent(userId)}/disable`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    }) as { user: AdminUserRecord };
    return payload.user;
  }

  async enableUser(token: string, userId: string) {
    const payload = await this.requestJson(`/v1/admin/users/${encodeURIComponent(userId)}/enable`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    }) as { user: AdminUserRecord };
    return payload.user;
  }

  async deleteUser(token: string, userId: string) {
    const response = await fetch(`${this.denApiBase}/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 204) {
      return;
    }

    const payload = await response.json().catch(() => null);
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : typeof payload?.message === "string"
          ? payload.message
          : "request_failed";
    throw new HttpError(message, response.status);
  }
}

export function createDefaultAdminService(denApiBase: string): AdminService {
  const denClient = new DenAdminClient(denApiBase);
  const readModels = new InMemoryAdminReadModel();

  return {
    async signIn(input) {
      const payload = await denClient.signIn(input);
      const token = typeof payload?.token === "string" ? payload.token : null;
      if (!token) {
        throw new HttpError("missing_token", 502);
      }
      const session = await denClient.getSession(token);
      return {
        token,
        denApiBase,
        session,
      };
    },
    getSession(token) {
      return denClient.getSession(token);
    },
    listUsers(token) {
      return denClient.listUsers(token);
    },
    async createUser(token, input) {
      const created = await denClient.createUser(token, input);
      readModels.pushAudit({
        id: `audit_${Date.now()}`,
        timestamp: new Date().toISOString(),
        actor: "admin-ui",
        action: "user.create",
        entityType: "user",
        entityId: created.id,
        result: "ok",
        summary: `Created user ${created.email}.`,
        changedFields: ["name", "platformAdmin"],
      });
      return created;
    },
    async updateUser(token, userId, input) {
      const updated = await denClient.updateUser(token, userId, input);
      readModels.pushAudit({
        id: `audit_${Date.now()}`,
        timestamp: new Date().toISOString(),
        actor: "admin-ui",
        action: "user.update",
        entityType: "user",
        entityId: updated.id,
        result: "ok",
        summary: `Updated user ${updated.email}.`,
        changedFields: Object.keys(input).sort(),
      });
      return updated;
    },
    async disableUser(token, userId) {
      const updated = await denClient.disableUser(token, userId);
      readModels.pushAudit({
        id: `audit_${Date.now()}`,
        timestamp: new Date().toISOString(),
        actor: "admin-ui",
        action: "user.disable",
        entityType: "user",
        entityId: updated.id,
        result: "warning",
        summary: `Disabled user ${updated.email}.`,
        changedFields: ["disabled"],
      });
      return updated;
    },
    async enableUser(token, userId) {
      const updated = await denClient.enableUser(token, userId);
      readModels.pushAudit({
        id: `audit_${Date.now()}`,
        timestamp: new Date().toISOString(),
        actor: "admin-ui",
        action: "user.enable",
        entityType: "user",
        entityId: updated.id,
        result: "ok",
        summary: `Re-enabled user ${updated.email}.`,
        changedFields: ["disabled"],
      });
      return updated;
    },
    async deleteUser(token, userId) {
      await denClient.deleteUser(token, userId);
      readModels.pushAudit({
        id: `audit_${Date.now()}`,
        timestamp: new Date().toISOString(),
        actor: "admin-ui",
        action: "user.delete",
        entityType: "user",
        entityId: userId,
        result: "warning",
        summary: `Deleted user ${userId}.`,
        changedFields: ["deleted"],
      });
    },
    async listCredentials() {
      return { credentials: readModels.listCredentials() };
    },
    async listSessions() {
      return { sessions: readModels.listSessions() };
    },
    async getUsage(_token, input) {
      return readModels.getUsage(input);
    },
    async listAlerts() {
      return { alerts: readModels.listAlerts() };
    },
    async listAudit() {
      return { events: readModels.listAudit() };
    },
  };
}

function readBearerToken(req: express.Request) {
  const header = req.header("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = header.slice("bearer ".length).trim();
  return token || null;
}

function adminShellHtml() {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AI Gateway Admin</title>
    <link rel="stylesheet" href="/admin/app.css" />
  </head>
  <body>
    <div id="app">
      <header>
        <h1>AI Gateway Admin</h1>
        <p>Loading control plane...</p>
      </header>
      <nav aria-label="Primary">
        <a href="/admin/credentials">Credentials</a>
        <a href="/admin/sessions">Sessions</a>
        <a href="/admin/usage">Usage</a>
        <a href="/admin/alerts">Alerts</a>
        <a href="/admin/users">Users</a>
        <a href="/admin/audit">Audit</a>
      </nav>
    </div>
    <script type="module" src="/admin/app.js"></script>
  </body>
</html>`;
}

function normalizeGroupBy(value: unknown): UsageGroupBy {
  return value === "credential" || value === "user" || value === "org" ? value : "total";
}

function mapHttpError(error: unknown, res: express.Response) {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return true;
  }

  if (error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number") {
    const message = typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "request_failed";
    res.status((error as { status: number }).status).json({ error: message });
    return true;
  }
  return false;
}

export function createAdminRouter(adminService: AdminService) {
  const router = Router();
  const currentFile = fileURLToPath(import.meta.url);
  const publicDir = path.resolve(path.dirname(currentFile), "../../public-admin");
  const indexPath = path.join(publicDir, "index.html");

  router.post("/admin/api/auth/sign-in", async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!email || !password) {
      res.status(400).json({ error: "invalid_credentials" });
      return;
    }

    try {
      const payload = await adminService.signIn({ email, password });
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "auth_proxy_failed" });
    }
  });

  router.use("/admin/api", async (req, res, next) => {
    if (req.path === "/auth/sign-in") {
      next();
      return;
    }

    const token = readBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    try {
      const session = await adminService.getSession(token);
      res.locals.adminToken = token;
      res.locals.adminSession = session;
      next();
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "session_lookup_failed" });
    }
  });

  router.get("/admin/api/session", async (req, res) => {
    res.json(res.locals.adminSession);
  });

  router.get("/admin/api/credentials", async (req, res) => {
    const payload = await adminService.listCredentials(res.locals.adminToken as string);
    res.json(payload);
  });

  router.get("/admin/api/sessions", async (req, res) => {
    const payload = await adminService.listSessions(res.locals.adminToken as string);
    res.json(payload);
  });

  router.get("/admin/api/usage", async (req, res) => {
    const payload = await adminService.getUsage(res.locals.adminToken as string, {
      groupBy: normalizeGroupBy(req.query.groupBy),
      credentialId: typeof req.query.credentialId === "string" && req.query.credentialId.trim() ? req.query.credentialId.trim() : null,
      userId: typeof req.query.userId === "string" && req.query.userId.trim() ? req.query.userId.trim() : null,
      orgId: typeof req.query.orgId === "string" && req.query.orgId.trim() ? req.query.orgId.trim() : null,
    });
    res.json(payload);
  });

  router.get("/admin/api/alerts", async (req, res) => {
    const payload = await adminService.listAlerts(res.locals.adminToken as string);
    res.json(payload);
  });

  router.get("/admin/api/audit", async (req, res) => {
    const payload = await adminService.listAudit(res.locals.adminToken as string);
    res.json(payload);
  });

  router.get("/admin/api/users", async (req, res) => {
    try {
      const users = await adminService.listUsers(res.locals.adminToken as string);
      res.json({ users });
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "user_list_failed" });
    }
  });

  router.post("/admin/api/users", async (req, res) => {
    try {
      const user = await adminService.createUser(res.locals.adminToken as string, {
        email: typeof req.body?.email === "string" ? req.body.email.trim() : "",
        name: typeof req.body?.name === "string" ? req.body.name.trim() : "",
        platformAdmin: req.body?.platformAdmin === true,
        orgId: typeof req.body?.orgId === "string" ? req.body.orgId.trim() : null,
        orgRole: req.body?.orgRole === "owner" ? "owner" : "member",
      });
      res.status(201).json({ user });
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "user_create_failed" });
    }
  });

  router.patch("/admin/api/users/:userId", async (req, res) => {
    try {
      const user = await adminService.updateUser(res.locals.adminToken as string, req.params.userId, {
        name: typeof req.body?.name === "string" ? req.body.name.trim() : undefined,
        platformAdmin: typeof req.body?.platformAdmin === "boolean" ? req.body.platformAdmin : undefined,
      });
      res.json({ user });
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "user_update_failed" });
    }
  });

  router.post("/admin/api/users/:userId/disable", async (req, res) => {
    try {
      const user = await adminService.disableUser(res.locals.adminToken as string, req.params.userId);
      res.json({ user });
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "user_disable_failed" });
    }
  });

  router.post("/admin/api/users/:userId/enable", async (req, res) => {
    try {
      const user = await adminService.enableUser(res.locals.adminToken as string, req.params.userId);
      res.json({ user });
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "user_enable_failed" });
    }
  });

  router.delete("/admin/api/users/:userId", async (req, res) => {
    try {
      await adminService.deleteUser(res.locals.adminToken as string, req.params.userId);
      res.status(204).end();
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "user_delete_failed" });
    }
  });

  router.use("/admin", express.static(publicDir, { index: false }));

  const sendAdminShell = (_req: express.Request, res: express.Response) => {
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
      return;
    }
    res.type("html").send(adminShellHtml());
  };

  router.get("/admin", sendAdminShell);
  router.get("/admin/*", (req, res, next) => {
    if (req.path.startsWith("/admin/api/")) {
      next();
      return;
    }
    sendAdminShell(req, res);
  });

  return router;
}
