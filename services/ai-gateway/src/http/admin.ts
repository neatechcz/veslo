import { desc, eq, sql } from "drizzle-orm";
import express, { Router } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AuditRepository, AuditEventRecord, ListAuditEventsInput } from "../audit/repository.js";
import { MySqlAuditRepository } from "../audit/mysql-repository.js";
import type { AdminCredentialRecord } from "../credentials/repository.js";
import type { AiGatewayDb } from "../db/index.js";
import { createDb } from "../db/index.js";
import { credentialBindingTable, credentialRecordTable, credentialUsageEventTable, sessionLeaseTable } from "../db/schema.js";
import { env } from "../env.js";
import type { AdminSessionRecord, LeaseProvider } from "../leases/repository.js";
import { MySqlUsageRepository } from "../usage/mysql-repository.js";
import type { AggregateUsageInput, UsageAggregateResponse, UsageGroupBy as RepositoryUsageGroupBy, UsageRepository } from "../usage/repository.js";

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

export type CredentialRecord = AdminCredentialRecord;

export type SessionRecord = AdminSessionRecord;

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

export type AuditRecord = AuditEventRecord;

export type UsageGroupBy = RepositoryUsageGroupBy;

export type UsageResponse = UsageAggregateResponse;

export type AuthPayload = {
  token: string;
  denApiBase: string;
  session: AdminSessionSnapshot;
};

export type BrowserAuthStartPayload = {
  authorizeUrl: string;
  sessionId: string;
  expiresAt: string | null;
};

export type BrowserAuthStartInput = {
  intent: "signin" | "signup";
  redirectUri: string;
  state: string;
  codeChallenge: string;
};

export type BrowserAuthExchangeInput = {
  code: string;
  sessionId: string;
  state: string;
  codeVerifier: string;
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
  startBrowserAuth(input: BrowserAuthStartInput): Promise<BrowserAuthStartPayload>;
  exchangeBrowserAuth(input: BrowserAuthExchangeInput): Promise<AuthPayload>;
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

type DenAdminApi = {
  startBrowserAuth(input: BrowserAuthStartInput): Promise<BrowserAuthStartPayload>;
  exchangeBrowserAuth(input: BrowserAuthExchangeInput): Promise<{ token?: string }>;
  getSession(token: string): Promise<AdminSessionSnapshot>;
  listUsers(token: string): Promise<AdminUserRecord[]>;
  createUser(token: string, input: CreateUserInput): Promise<AdminUserRecord>;
  updateUser(token: string, userId: string, input: UpdateUserInput): Promise<AdminUserRecord>;
  disableUser(token: string, userId: string): Promise<AdminUserRecord>;
  enableUser(token: string, userId: string): Promise<AdminUserRecord>;
  deleteUser(token: string, userId: string): Promise<void>;
};

type AdminCredentialReadRepository = {
  listAdminCredentials(): Promise<CredentialRecord[]>;
};

type AdminSessionReadRepository = {
  listAdminSessions(): Promise<SessionRecord[]>;
};

type AdminReadModelDependencies = {
  denClient?: DenAdminApi;
  credentialReadRepository?: AdminCredentialReadRepository;
  sessionReadRepository?: AdminSessionReadRepository;
  usageRepository?: UsageRepository;
  auditRepository?: AuditRepository;
  now?: () => Date;
};

const DEFAULT_ALERTS: AlertRecord[] = [
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

class InMemoryAlertReadModel {
  private readonly alerts = DEFAULT_ALERTS.map((entry) => ({ ...entry }));

  listAlerts() {
    return this.alerts.map((entry) => ({ ...entry }));
  }
}

class MySqlAdminCredentialReadRepository implements AdminCredentialReadRepository {
  constructor(private readonly db: AiGatewayDb) {}

  async listAdminCredentials(): Promise<CredentialRecord[]> {
    const [credentialRows, activeLeaseRows, usageRows] = await Promise.all([
      this.db.select().from(credentialRecordTable).orderBy(desc(credentialRecordTable.updated_at)),
      this.db
        .select({
          credentialRecordId: credentialBindingTable.credential_record_id,
          activeLeases: sql<number>`count(*)`,
        })
        .from(sessionLeaseTable)
        .innerJoin(credentialBindingTable, eq(sessionLeaseTable.active_binding_id, credentialBindingTable.id))
        .groupBy(credentialBindingTable.credential_record_id),
      this.db
        .select({
          credentialRecordId: credentialUsageEventTable.credential_record_id,
          totalTokens: sql<number>`coalesce(sum(${credentialUsageEventTable.input_tokens} + ${credentialUsageEventTable.output_tokens}), 0)`,
        })
        .from(credentialUsageEventTable)
        .groupBy(credentialUsageEventTable.credential_record_id),
    ]);

    const activeLeasesByCredential = new Map(
      activeLeaseRows.map((row) => [row.credentialRecordId, Number(row.activeLeases ?? 0)]),
    );
    const totalTokensByCredential = new Map(
      usageRows.map((row) => [row.credentialRecordId, Number(row.totalTokens ?? 0)]),
    );

    return credentialRows.map((row) => ({
      id: row.id,
      name: `${formatProviderLabel(row.provider)} ${row.id}`,
      provider: row.provider,
      type: row.credential_type,
      state: row.state,
      scope: row.owner_user_id,
      activeLeases: activeLeasesByCredential.get(row.id) ?? 0,
      alertCount: 0,
      lastRefreshAt: toIsoString(row.updated_at),
      lastFailureAt: row.state === "healthy" ? null : toIsoString(row.updated_at),
      totalTokens: totalTokensByCredential.get(row.id) ?? 0,
      nextRotationAt: null,
      linkedAlertIds: [],
    }));
  }
}

class MySqlAdminSessionReadRepository implements AdminSessionReadRepository {
  constructor(private readonly db: AiGatewayDb) {}

  async listAdminSessions(): Promise<SessionRecord[]> {
    const rows = await this.db
      .select({
        id: sessionLeaseTable.id,
        sessionId: sessionLeaseTable.session_id,
        provider: sessionLeaseTable.provider,
        ownerUserId: sessionLeaseTable.owner_user_id,
        activeBindingId: sessionLeaseTable.active_binding_id,
        credentialRecordId: credentialBindingTable.credential_record_id,
        updatedAt: sessionLeaseTable.updated_at,
      })
      .from(sessionLeaseTable)
      .leftJoin(credentialBindingTable, eq(sessionLeaseTable.active_binding_id, credentialBindingTable.id))
      .orderBy(desc(sessionLeaseTable.updated_at));

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      provider: row.provider as LeaseProvider,
      userLabel: row.ownerUserId,
      orgLabel: "Personal",
      projectLabel: row.sessionId,
      workerLabel: "local-runtime",
      credentialId: row.credentialRecordId ?? row.activeBindingId,
      state: "healthy",
      retries: 0,
      lastSeenAt: toIsoString(row.updatedAt),
      lastFailoverAt: null,
    }));
  }
}

function createDefaultAdminReadRepositories() {
  let repositories:
    | {
        credentialReadRepository: AdminCredentialReadRepository;
        sessionReadRepository: AdminSessionReadRepository;
        usageRepository: UsageRepository;
        auditRepository: AuditRepository;
      }
    | null = null;

  return () => {
    if (repositories) {
      return repositories;
    }

    const handle = createDb(env.databaseUrl);
    repositories = {
      credentialReadRepository: new MySqlAdminCredentialReadRepository(handle.db),
      sessionReadRepository: new MySqlAdminSessionReadRepository(handle.db),
      usageRepository: new MySqlUsageRepository(handle.db),
      auditRepository: new MySqlAuditRepository(handle.db),
    };

    return repositories;
  };
}

function formatProviderLabel(provider: string) {
  if (provider === "openai") {
    return "OpenAI";
  }

  if (provider === "anthropic") {
    return "Anthropic";
  }

  return provider;
}

function toIsoString(value: Date | string | null) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    return value;
  }

  return new Date(0).toISOString();
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

  async startBrowserAuth(input: BrowserAuthStartInput) {
    const payload = await this.requestJson("/v1/desktop-auth/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        intent: input.intent,
        redirectUri: input.redirectUri,
        state: input.state,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: "S256",
      }),
    });
    return {
      authorizeUrl: typeof payload?.authorizeUrl === "string" ? payload.authorizeUrl : "",
      sessionId: typeof payload?.sessionId === "string" ? payload.sessionId : "",
      expiresAt: typeof payload?.expiresAt === "string" ? payload.expiresAt : null,
    } satisfies BrowserAuthStartPayload;
  }

  async exchangeBrowserAuth(input: BrowserAuthExchangeInput) {
    return this.requestJson("/v1/desktop-auth/exchange", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        code: input.code,
        sessionId: input.sessionId,
        state: input.state,
        codeVerifier: input.codeVerifier,
      }),
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

export function createDefaultAdminService(
  denApiBase: string,
  deps: AdminReadModelDependencies = {},
): AdminService {
  const denClient = deps.denClient ?? new DenAdminClient(denApiBase);
  const getDefaultRepositories = createDefaultAdminReadRepositories();
  const alerts = new InMemoryAlertReadModel();
  const now = deps.now ?? (() => new Date());
  const getCredentialReadRepository = () =>
    deps.credentialReadRepository ?? getDefaultRepositories().credentialReadRepository;
  const getSessionReadRepository = () =>
    deps.sessionReadRepository ?? getDefaultRepositories().sessionReadRepository;
  const getUsageRepository = () =>
    deps.usageRepository ?? getDefaultRepositories().usageRepository;
  const getAuditRepository = () =>
    deps.auditRepository ?? getDefaultRepositories().auditRepository;

  async function recordAuditEvent(input: {
    actorUserId?: string | null;
    entityType: string;
    entityId: string;
    action: string;
    result: "ok" | "warning" | "error";
    summary: string;
  }) {
    await getAuditRepository().recordEvent({
      actorUserId: input.actorUserId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      result: input.result,
      summary: input.summary,
    });
  }

  return {
    async startBrowserAuth(input) {
      return denClient.startBrowserAuth(input);
    },
    async exchangeBrowserAuth(input) {
      const payload = await denClient.exchangeBrowserAuth(input);
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
      await recordAuditEvent({
        actorUserId: "admin-ui",
        action: "user.create",
        entityType: "user",
        entityId: created.id,
        result: "ok",
        summary: `Created user ${created.email}.`,
      });
      return created;
    },
    async updateUser(token, userId, input) {
      const updated = await denClient.updateUser(token, userId, input);
      await recordAuditEvent({
        actorUserId: "admin-ui",
        action: "user.update",
        entityType: "user",
        entityId: updated.id,
        result: "ok",
        summary: `Updated user ${updated.email}.`,
      });
      return updated;
    },
    async disableUser(token, userId) {
      const updated = await denClient.disableUser(token, userId);
      await recordAuditEvent({
        actorUserId: "admin-ui",
        action: "user.disable",
        entityType: "user",
        entityId: updated.id,
        result: "warning",
        summary: `Disabled user ${updated.email}.`,
      });
      return updated;
    },
    async enableUser(token, userId) {
      const updated = await denClient.enableUser(token, userId);
      await recordAuditEvent({
        actorUserId: "admin-ui",
        action: "user.enable",
        entityType: "user",
        entityId: updated.id,
        result: "ok",
        summary: `Re-enabled user ${updated.email}.`,
      });
      return updated;
    },
    async deleteUser(token, userId) {
      await denClient.deleteUser(token, userId);
      await recordAuditEvent({
        actorUserId: "admin-ui",
        action: "user.delete",
        entityType: "user",
        entityId: userId,
        result: "warning",
        summary: `Deleted user ${userId}.`,
      });
    },
    async listCredentials() {
      return { credentials: await getCredentialReadRepository().listAdminCredentials() };
    },
    async listSessions() {
      return { sessions: await getSessionReadRepository().listAdminSessions() };
    },
    async getUsage(_token, input) {
      const usageRepository = getUsageRepository();
      if (!usageRepository.aggregateUsage) {
        throw new HttpError("usage_read_model_unavailable", 503);
      }
      return usageRepository.aggregateUsage(input);
    },
    async listAlerts() {
      return { alerts: alerts.listAlerts() };
    },
    async listAudit() {
      const auditRepository = getAuditRepository();
      const listInput: ListAuditEventsInput = { limit: 100 };
      return { events: auditRepository.listEvents ? await auditRepository.listEvents(listInput) : [] };
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

  router.post("/admin/api/auth/browser/start", async (req, res) => {
    const redirectUri = typeof req.body?.redirectUri === "string" ? req.body.redirectUri.trim() : "";
    const state = typeof req.body?.state === "string" ? req.body.state.trim() : "";
    const codeChallenge = typeof req.body?.codeChallenge === "string" ? req.body.codeChallenge.trim() : "";
    const intent = req.body?.intent === "signup" ? "signup" : "signin";

    if (!redirectUri || !state || !codeChallenge) {
      res.status(400).json({ error: "invalid_browser_auth_start" });
      return;
    }

    try {
      const payload = await adminService.startBrowserAuth({
        intent,
        redirectUri,
        state,
        codeChallenge,
      });
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "auth_proxy_failed" });
    }
  });

  router.post("/admin/api/auth/browser/exchange", async (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
    const state = typeof req.body?.state === "string" ? req.body.state.trim() : "";
    const codeVerifier = typeof req.body?.codeVerifier === "string" ? req.body.codeVerifier.trim() : "";

    if (!code || !sessionId || !state || !codeVerifier) {
      res.status(400).json({ error: "invalid_browser_auth_exchange" });
      return;
    }

    try {
      const payload = await adminService.exchangeBrowserAuth({
        code,
        sessionId,
        state,
        codeVerifier,
      });
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "auth_exchange_failed" });
    }
  });

  router.use("/admin/api", async (req, res, next) => {
    if (req.path.startsWith("/auth/browser/")) {
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
