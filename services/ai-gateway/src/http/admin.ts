import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import express, { Router } from "express";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AlertRecord, AlertRepository } from "../alerts/repository.js";
import type { AiAccessProvider, AiAccessRepository, UpsertUserAiAccessPolicyInput, UserAiAccessPolicyRecord } from "../access/repository.js";
import { MySqlAiAccessRepository } from "../access/mysql-repository.js";
import { MySqlAlertRepository } from "../alerts/mysql-repository.js";
import type { AuditRepository, AuditEventRecord, ListAuditEventsInput } from "../audit/repository.js";
import { MySqlAuditRepository } from "../audit/mysql-repository.js";
import { getPlatformCredentialOwnerUserId } from "../credentials/platform-owner.js";
import { MySqlCredentialRepository } from "../credentials/mysql-repository.js";
import { MySqlSecretStore } from "../credentials/mysql-secret-store.js";
import type { AdminCredentialRecord, CreatePlatformCredentialInput, CredentialRecord as GatewayCredentialRecord } from "../credentials/repository.js";
import type { SecretStore, StoredSecret } from "../credentials/secret-store.js";
import type { AiGatewayDb } from "../db/index.js";
import { createDb } from "../db/index.js";
import { credentialBindingTable, credentialHealthEventTable, credentialRecordTable, credentialUsageEventTable, sessionLeaseTable, type CredentialState } from "../db/schema.js";
import { env } from "../env.js";
import type { AdminSessionRecord, LeaseProvider } from "../leases/repository.js";
import { isAiGatewayProvider } from "../providers/ids.js";
import { MySqlUsageRepository } from "../usage/mysql-repository.js";
import { CachedCodexCredentialStatusProvider, UnavailableCodexCredentialStatusProvider, type CodexCredentialStatusProvider, type CodexUsageStatus } from "../usage/codex-status.js";
import type { AggregateUsageInput, UsageAggregateResponse, UsageCredentialAggregate, UsageGroupBy as RepositoryUsageGroupBy, UsageRepository } from "../usage/repository.js";

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

export type AuditRecord = AuditEventRecord;

export type UsageGroupBy = RepositoryUsageGroupBy;

export type AdminCredentialUsageRecord = UsageCredentialAggregate & {
  name: string;
  provider: string | null;
  state: CredentialState | null;
  activeLeases: number;
  upstreamStatus: CodexUsageStatus | null;
};

export type UsageResponse = Omit<UsageAggregateResponse, "credentialUsage"> & {
  credentialUsage: AdminCredentialUsageRecord[];
};

export type AdminUserAiAccessRecord = {
  id: string;
  userId: string;
  enabled: boolean;
  provider: AiAccessProvider | null;
  credentialId: string | null;
  defaultModel: string | null;
  allowedModels: string[];
  updatedAt: string;
};

export type AdminCredentialOption = {
  id: string;
  name: string;
};

export type EligibleCodexCredential = {
  credentialId: string;
  name: string;
  activeLeases: number;
};

export type UpdateUserAiAccessInput = {
  enabled: boolean;
  provider: AiAccessProvider | null;
  credentialId: string | null;
  defaultModel: string | null;
  allowedModels: string[];
};

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

export type CreateCredentialInput = {
  provider: LeaseProvider | null;
  name?: string | null;
  secret: string;
};

const DEFAULT_CODEX_AUTO_ASSIGN_MODEL = "gpt-5.4";

export interface AdminService {
  startBrowserAuth(input: BrowserAuthStartInput): Promise<BrowserAuthStartPayload>;
  exchangeBrowserAuth(input: BrowserAuthExchangeInput): Promise<AuthPayload>;
  getSession(token: string): Promise<AdminSessionSnapshot>;
  listUsers(token: string): Promise<AdminUserRecord[]>;
  createUser(token: string, input: CreateUserInput): Promise<AdminUserRecord>;
  getEligibleCodexCredentialForAutoAssign(): Promise<EligibleCodexCredential | null>;
  updateUser(token: string, userId: string, input: UpdateUserInput): Promise<AdminUserRecord>;
  getUserAiAccess(
    token: string,
    userId: string,
  ): Promise<{ aiAccess: AdminUserAiAccessRecord | null; availableCredentials: AdminCredentialOption[] }>;
  upsertUserAiAccess(
    token: string,
    userId: string,
    input: UpdateUserAiAccessInput,
  ): Promise<{ aiAccess: AdminUserAiAccessRecord; availableCredentials: AdminCredentialOption[] }>;
  disableUser(token: string, userId: string): Promise<AdminUserRecord>;
  enableUser(token: string, userId: string): Promise<AdminUserRecord>;
  deleteUser(token: string, userId: string): Promise<void>;
  listCredentials(_token: string): Promise<{ credentials: CredentialRecord[] }>;
  createCredential(_token: string, input: CreateCredentialInput, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
  revokeCredential(_token: string, credentialId: string, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
  drainCredential(_token: string, credentialId: string, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
  rotateCredential(_token: string, credentialId: string, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
  listSessions(_token: string): Promise<{ sessions: SessionRecord[] }>;
  getUsage(_token: string, input: { groupBy: UsageGroupBy; credentialId: string | null; userId: string | null; orgId: string | null }): Promise<UsageResponse>;
  listAlerts(_token: string): Promise<{ alerts: AlertRecord[] }>;
  acknowledgeAlert(_token: string, alertId: string, actorUserId: string | null): Promise<{ alert: AlertRecord }>;
  resolveAlert(_token: string, alertId: string, actorUserId: string | null): Promise<{ alert: AlertRecord }>;
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

type AdminCredentialActionRepository = {
  revokeCredential(credentialId: string): Promise<boolean>;
  drainCredential(credentialId: string): Promise<boolean>;
  rotateCredential(credentialId: string): Promise<boolean>;
};

type AdminCredentialWriteRepository = {
  createPlatformCredential(input: CreatePlatformCredentialInput): Promise<GatewayCredentialRecord>;
};

type CredentialSecretLookupRepository = {
  getCredentialRecordById(credentialId: string): Promise<{ secretRef: string } | null>;
};

type AdminReadModelDependencies = {
  denClient?: DenAdminApi;
  credentialReadRepository?: AdminCredentialReadRepository;
  credentialActionRepository?: AdminCredentialActionRepository;
  credentialWriteRepository?: AdminCredentialWriteRepository;
  sessionReadRepository?: AdminSessionReadRepository;
  aiAccessRepository?: AiAccessRepository;
  alertRepository?: AlertRepository;
  usageRepository?: UsageRepository;
  codexStatusProvider?: CodexCredentialStatusProvider;
  auditRepository?: AuditRepository;
  secretStore?: SecretStore;
  now?: () => Date;
};

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
      name: row.name?.trim() || `${formatProviderLabel(row.provider)} ${row.id}`,
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

class MySqlAdminCredentialActionRepository implements AdminCredentialActionRepository {
  constructor(private readonly db: AiGatewayDb) {}

  async revokeCredential(credentialId: string): Promise<boolean> {
    return this.transitionCredentialState(credentialId, "revoked", "admin_revoke");
  }

  async drainCredential(credentialId: string): Promise<boolean> {
    return this.transitionCredentialState(credentialId, "draining", "admin_drain");
  }

  async rotateCredential(credentialId: string): Promise<boolean> {
    const credential = await this.getCredential(credentialId);
    if (!credential) {
      return false;
    }

    const targetBindings = await this.db
      .select({ id: credentialBindingTable.id })
      .from(credentialBindingTable)
      .where(eq(credentialBindingTable.credential_record_id, credentialId))
      .orderBy(credentialBindingTable.created_at);
    const targetBindingIds = targetBindings.map((binding) => binding.id);

    if (targetBindingIds.length > 0) {
      const replacements = await this.db
        .select({ id: credentialBindingTable.id })
        .from(credentialBindingTable)
        .innerJoin(credentialRecordTable, eq(credentialBindingTable.credential_record_id, credentialRecordTable.id))
        .where(
          and(
            eq(credentialBindingTable.owner_user_id, credential.owner_user_id),
            eq(credentialBindingTable.provider, credential.provider),
            ne(credentialBindingTable.credential_record_id, credentialId),
            eq(credentialRecordTable.state, "healthy"),
          ),
        )
        .orderBy(credentialBindingTable.created_at);

      if (replacements.length > 0) {
        const activeLeases = await this.db
          .select({ id: sessionLeaseTable.id })
          .from(sessionLeaseTable)
          .where(inArray(sessionLeaseTable.active_binding_id, targetBindingIds))
          .orderBy(sessionLeaseTable.session_id);

        await Promise.all(activeLeases.map((lease, index) =>
          this.db
            .update(sessionLeaseTable)
            .set({
              active_binding_id: replacements[index % replacements.length]!.id,
              updated_at: new Date(),
            })
            .where(eq(sessionLeaseTable.id, lease.id)),
        ));
      }
    }

    return this.transitionCredentialState(credentialId, "draining", "admin_rotate", credential);
  }

  private async transitionCredentialState(
    credentialId: string,
    nextState: CredentialState,
    reason: string,
    loadedCredential: typeof credentialRecordTable.$inferSelect | null = null,
  ): Promise<boolean> {
    const credential = loadedCredential ?? await this.getCredential(credentialId);
    if (!credential) {
      return false;
    }

    const previousState = credential.state;
    const now = new Date();

    await this.db
      .update(credentialRecordTable)
      .set({
        state: nextState,
        updated_at: now,
      })
      .where(eq(credentialRecordTable.id, credentialId));

    await this.db.insert(credentialHealthEventTable).values({
      id: `health_${randomUUID()}`,
      credential_record_id: credentialId,
      from_state: previousState,
      to_state: nextState,
      reason,
      created_at: now,
    });

    return true;
  }

  private async getCredential(credentialId: string) {
    const rows = await this.db
      .select()
      .from(credentialRecordTable)
      .where(eq(credentialRecordTable.id, credentialId))
      .limit(1);

    return rows[0] ?? null;
  }
}

function createDefaultAdminReadRepositories() {
  let repositories:
    | {
        credentialReadRepository: AdminCredentialReadRepository;
        credentialActionRepository: AdminCredentialActionRepository;
        credentialWriteRepository: AdminCredentialWriteRepository;
        sessionReadRepository: AdminSessionReadRepository;
        aiAccessRepository: AiAccessRepository;
        alertRepository: AlertRepository;
        usageRepository: UsageRepository;
        auditRepository: AuditRepository;
        secretStore: SecretStore;
      }
    | null = null;

  return () => {
    if (repositories) {
      return repositories;
    }

    const handle = createDb(env.databaseUrl);
    repositories = {
      credentialReadRepository: new MySqlAdminCredentialReadRepository(handle.db),
      credentialActionRepository: new MySqlAdminCredentialActionRepository(handle.db),
      credentialWriteRepository: new MySqlCredentialRepository(handle.db),
      sessionReadRepository: new MySqlAdminSessionReadRepository(handle.db),
      aiAccessRepository: new MySqlAiAccessRepository(handle.db),
      alertRepository: new MySqlAlertRepository(handle.db),
      usageRepository: new MySqlUsageRepository(handle.db),
      auditRepository: new MySqlAuditRepository(handle.db),
      secretStore: new MySqlSecretStore(handle.db, env.secretKey),
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

  if (provider === "codex_oauth") {
    return "Codex OAuth";
  }

  return provider;
}

function readCredentialUsage(usage: UsageAggregateResponse): UsageCredentialAggregate[] {
  if (Array.isArray(usage.credentialUsage) && usage.credentialUsage.length > 0) {
    return usage.credentialUsage;
  }

  const requestsByCredentialId = new Map(
    usage.groupBy === "credential"
      ? usage.series.map((entry) => [entry.key, entry.totalRequests] as const)
      : [],
  );

  return usage.topCredentials.map((entry) => ({
    id: entry.id,
    label: entry.label,
    totalTokens: entry.totalTokens,
    totalRequests: requestsByCredentialId.get(entry.id) ?? 0,
    lastUsedAt: null,
  }));
}

function mergeCredentialFilters(
  credentials: CredentialRecord[],
  existingFilters: UsageAggregateResponse["filters"]["credentials"],
) {
  const filters = new Map<string, string>();
  for (const credential of credentials) {
    filters.set(credential.id, credential.name);
  }
  for (const filter of existingFilters) {
    if (!filters.has(filter.id)) {
      filters.set(filter.id, filter.label);
    }
  }
  return Array.from(filters.entries()).map(([id, label]) => ({ id, label }));
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
  const getCredentialReadRepository = () =>
    deps.credentialReadRepository ?? getDefaultRepositories().credentialReadRepository;
  const getCredentialActionRepository = () =>
    deps.credentialActionRepository ?? getDefaultRepositories().credentialActionRepository;
  const getCredentialWriteRepository = () =>
    deps.credentialWriteRepository ?? getDefaultRepositories().credentialWriteRepository;
  const getCredentialSecretLookupRepository = () =>
    (deps.credentialWriteRepository ?? getDefaultRepositories().credentialWriteRepository) as unknown as CredentialSecretLookupRepository;
  const getSessionReadRepository = () =>
    deps.sessionReadRepository ?? getDefaultRepositories().sessionReadRepository;
  const getAiAccessRepository = () =>
    deps.aiAccessRepository ?? getDefaultRepositories().aiAccessRepository;
  const getAlertRepository = () =>
    deps.alertRepository ?? getDefaultRepositories().alertRepository;
  const getUsageRepository = () =>
    deps.usageRepository ?? getDefaultRepositories().usageRepository;
  const getAuditRepository = () =>
    deps.auditRepository ?? getDefaultRepositories().auditRepository;
  const getSecretStore = () =>
    deps.secretStore ?? getDefaultRepositories().secretStore;
  const codexStatusProvider =
    deps.codexStatusProvider ??
    (getCredentialSecretLookupRepository()
      ? new CachedCodexCredentialStatusProvider({
          loadCredentialAuthJson: async (credentialId) => {
            const credential = await getCredentialSecretLookupRepository().getCredentialRecordById(credentialId);
            if (!credential) {
              return null;
            }

            const secret = await getSecretStore().get(credential.secretRef).catch(() => null);
            return secret?.kind === "codex_auth_json" ? secret.authJson : null;
          },
        })
      : new UnavailableCodexCredentialStatusProvider());

  async function recordAuditEvent(input: {
    actorUserId?: string | null;
    entityType: string;
    entityId: string;
    action: string;
    result: "ok" | "warning" | "error";
    summary: string;
  }) {
    try {
      await getAuditRepository().recordEvent({
        actorUserId: input.actorUserId ?? null,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        result: input.result,
        summary: input.summary,
      });
    } catch (error) {
      console.error("admin audit event failed", {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        error,
      });
    }
  }

  async function listCredentialsWithAlerts(): Promise<CredentialRecord[]> {
    const [credentials, alerts] = await Promise.all([
      getCredentialReadRepository().listAdminCredentials(),
      getAlertRepository().listAlerts(),
    ]);

    const unresolvedAlertsByCredentialId = new Map<string, AlertRecord[]>();
    for (const alert of alerts) {
      if (!alert.credentialId || alert.status === "resolved") {
        continue;
      }

      const existing = unresolvedAlertsByCredentialId.get(alert.credentialId) ?? [];
      existing.push(alert);
      unresolvedAlertsByCredentialId.set(alert.credentialId, existing);
    }

    return credentials.map((credential) => {
      const linkedAlerts = unresolvedAlertsByCredentialId.get(credential.id) ?? [];
      return {
        ...credential,
        alertCount: linkedAlerts.length,
        linkedAlertIds: linkedAlerts.map((alert) => alert.id),
      };
    });
  }

  async function listEligibleCodexCredentials(): Promise<EligibleCodexCredential[]> {
    const credentials = await getCredentialReadRepository().listAdminCredentials();
    const candidates = credentials.filter((entry) => entry.provider === "codex_oauth" && entry.state === "healthy");
    const eligible: EligibleCodexCredential[] = [];

    for (const credential of candidates) {
      const status = await codexStatusProvider.getStatus({
        credentialId: credential.id,
        credentialName: credential.name,
      });
      if (!status.available) {
        continue;
      }
      eligible.push({
        credentialId: credential.id,
        name: credential.name,
        activeLeases: credential.activeLeases,
      });
    }

    return eligible.sort((left, right) => {
      const leaseDelta = left.activeLeases - right.activeLeases;
      if (leaseDelta !== 0) {
        return leaseDelta;
      }
      const nameDelta = left.name.localeCompare(right.name);
      if (nameDelta !== 0) {
        return nameDelta;
      }
      return left.credentialId.localeCompare(right.credentialId);
    });
  }

  async function getEligibleCodexCredentialForAutoAssign(): Promise<EligibleCodexCredential | null> {
    const [selected] = await listEligibleCodexCredentials();
    return selected ?? null;
  }

  async function assertEligibleCodexCredential(credentialId: string): Promise<void> {
    const eligibleCredentials = await listEligibleCodexCredentials();
    if (!eligibleCredentials.some((entry) => entry.credentialId === credentialId)) {
      throw new HttpError("ineligible_ai_access_credential_id", 400);
    }
  }

  async function listAvailableCodexCredentials(): Promise<AdminCredentialOption[]> {
    const credentials = await listEligibleCodexCredentials();
    return credentials.map((entry) => ({
      id: entry.credentialId,
      name: entry.name,
    }));
  }

  async function getCredentialOrThrow(credentialId: string): Promise<CredentialRecord> {
    const credentials = await listCredentialsWithAlerts();
    const credential = credentials.find((entry) => entry.id === credentialId);
    if (!credential) {
      throw new HttpError("credential_not_found", 404);
    }
    return credential;
  }

  async function withCredentialUsage(
    usage: UsageAggregateResponse,
    credentials: CredentialRecord[],
    statusProvider: CodexCredentialStatusProvider,
  ): Promise<UsageResponse> {
    const historicalUsage = readCredentialUsage(usage);
    const historicalByCredentialId = new Map(historicalUsage.map((entry) => [entry.id, entry]));
    const credentialLabels = new Map(credentials.map((credential) => [credential.id, credential.name]));
    const credentialUsage =
      credentials.length > 0
        ? await Promise.all(
            credentials.map(async (credential) => {
              const historical = historicalByCredentialId.get(credential.id);
              return {
                id: credential.id,
                label: credential.name,
                name: credential.name,
                provider: credential.provider,
                state: credential.state,
                activeLeases: credential.activeLeases,
                totalTokens: historical?.totalTokens ?? 0,
                totalRequests: historical?.totalRequests ?? 0,
                lastUsedAt: historical?.lastUsedAt ?? null,
                upstreamStatus:
                  credential.provider === "codex_oauth"
                    ? await statusProvider.getStatus({
                        credentialId: credential.id,
                        credentialName: credential.name,
                      })
                    : null,
              };
            }),
          )
        : historicalUsage.map((entry) => ({
            id: entry.id,
            label: entry.label,
            name: entry.label,
            provider: null,
            state: null,
            activeLeases: 0,
            totalTokens: entry.totalTokens,
            totalRequests: entry.totalRequests,
            lastUsedAt: entry.lastUsedAt,
            upstreamStatus: null,
          }));

    return {
      ...usage,
      filters: {
        ...usage.filters,
        credentials: mergeCredentialFilters(credentials, usage.filters.credentials),
      },
      series:
        usage.groupBy === "credential"
          ? usage.series.map((entry) => ({
              ...entry,
              label: credentialLabels.get(entry.key) ?? entry.label,
            }))
          : usage.series,
      topCredentials: usage.topCredentials.map((entry) => ({
        ...entry,
        label: credentialLabels.get(entry.id) ?? entry.label,
      })),
      credentialUsage,
    };
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
    getEligibleCodexCredentialForAutoAssign,
    async createUser(token, input) {
      const created = await denClient.createUser(token, input);
      const credential = await getEligibleCodexCredentialForAutoAssign();
      if (credential) {
        await getAiAccessRepository().upsertUserAiAccess({
          userId: created.id,
          enabled: true,
          provider: "codex_oauth",
          credentialId: credential.credentialId,
          defaultModel: DEFAULT_CODEX_AUTO_ASSIGN_MODEL,
          allowedModels: [DEFAULT_CODEX_AUTO_ASSIGN_MODEL],
        });
      }
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
    async getUserAiAccess(_token, userId) {
      return {
        aiAccess: toAdminUserAiAccessRecord(await getAiAccessRepository().getUserAiAccess(userId)),
        availableCredentials: await listAvailableCodexCredentials(),
      };
    },
    async upsertUserAiAccess(_token, userId, input) {
      const validated = validateUserAiAccessInput({
        ...input,
        userId,
      });
      if (validated.enabled && validated.provider === "codex_oauth" && validated.credentialId) {
        await assertEligibleCodexCredential(validated.credentialId);
      }
      const saved = await getAiAccessRepository().upsertUserAiAccess(validated);
      await recordAuditEvent({
        actorUserId: "admin-ui",
        action: "user.ai_access.update",
        entityType: "user",
        entityId: userId,
        result: "ok",
        summary: `Updated AI access for user ${userId}.`,
      });
      return {
        aiAccess: toAdminUserAiAccessRecord(saved)!,
        availableCredentials: await listAvailableCodexCredentials(),
      };
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
      return { credentials: await listCredentialsWithAlerts() };
    },
    async createCredential(_token, input, actorUserId) {
      const validated = validateCreateCredentialInput(input);
      const stored = await getSecretStore().put(validated.storedSecret);
      const created = await getCredentialWriteRepository().createPlatformCredential({
        ownerUserId: getPlatformCredentialOwnerUserId(validated.provider),
        name: validated.name,
        provider: validated.provider,
        credentialType: validated.credentialType,
        secretRef: stored.secretRef,
      });
      await recordAuditEvent({
        actorUserId,
        action: "credential.create",
        entityType: "credential",
        entityId: created.id,
        result: "ok",
        summary: `Created ${validated.provider} credential ${created.id}.`,
      });
      return { credential: toAdminCredentialRecord(created) };
    },
    async revokeCredential(_token, credentialId, actorUserId) {
      const updated = await getCredentialActionRepository().revokeCredential(credentialId);
      if (!updated) {
        throw new HttpError("credential_not_found", 404);
      }
      await recordAuditEvent({
        actorUserId,
        action: "credential.revoke",
        entityType: "credential",
        entityId: credentialId,
        result: "warning",
        summary: `Revoked credential ${credentialId}.`,
      });
      return { credential: await getCredentialOrThrow(credentialId) };
    },
    async drainCredential(_token, credentialId, actorUserId) {
      const updated = await getCredentialActionRepository().drainCredential(credentialId);
      if (!updated) {
        throw new HttpError("credential_not_found", 404);
      }
      await recordAuditEvent({
        actorUserId,
        action: "credential.drain",
        entityType: "credential",
        entityId: credentialId,
        result: "warning",
        summary: `Draining credential ${credentialId} for new assignments.`,
      });
      return { credential: await getCredentialOrThrow(credentialId) };
    },
    async rotateCredential(_token, credentialId, actorUserId) {
      const updated = await getCredentialActionRepository().rotateCredential(credentialId);
      if (!updated) {
        throw new HttpError("credential_not_found", 404);
      }
      await recordAuditEvent({
        actorUserId,
        action: "credential.rotate",
        entityType: "credential",
        entityId: credentialId,
        result: "ok",
        summary: `Rotated active sessions off credential ${credentialId}.`,
      });
      return { credential: await getCredentialOrThrow(credentialId) };
    },
    async listSessions() {
      return { sessions: await getSessionReadRepository().listAdminSessions() };
    },
    async getUsage(_token, input) {
      const usageRepository = getUsageRepository();
      if (!usageRepository.aggregateUsage) {
        throw new HttpError("usage_read_model_unavailable", 503);
      }
      const [usage, credentials] = await Promise.all([
        usageRepository.aggregateUsage(input),
        getCredentialReadRepository().listAdminCredentials(),
      ]);
      return withCredentialUsage(usage, credentials, codexStatusProvider);
    },
    async listAlerts() {
      return { alerts: await getAlertRepository().listAlerts() };
    },
    async acknowledgeAlert(_token, alertId, actorUserId) {
      const acknowledge = getAlertRepository().acknowledgeAlert;
      if (!acknowledge) {
        throw new HttpError("alert_actions_unavailable", 503);
      }
      const alert = await acknowledge.call(getAlertRepository(), {
        alertId,
        actorUserId,
      });
      if (!alert) {
        throw new HttpError("alert_not_found", 404);
      }
      return { alert };
    },
    async resolveAlert(_token, alertId, actorUserId) {
      const resolve = getAlertRepository().resolveAlert;
      if (!resolve) {
        throw new HttpError("alert_actions_unavailable", 503);
      }
      const alert = await resolve.call(getAlertRepository(), {
        alertId,
        actorUserId,
      });
      if (!alert) {
        throw new HttpError("alert_not_found", 404);
      }
      return { alert };
    },
    async listAudit() {
      const auditRepository = getAuditRepository();
      const listInput: ListAuditEventsInput = { limit: 100 };
      return { events: auditRepository.listEvents ? await auditRepository.listEvents(listInput) : [] };
    },
  };
}

function validateCreateCredentialInput(input: CreateCredentialInput): {
  provider: LeaseProvider;
  name: string;
  credentialType: "api_key" | "oauth";
  storedSecret: StoredSecret;
} {
  const provider = parseCredentialProvider(input.provider);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const secret = typeof input.secret === "string" ? input.secret.trim() : "";

  if (!provider) {
    throw new HttpError("invalid_provider", 400);
  }

  if (!secret) {
    throw new HttpError("invalid_credential_secret", 400);
  }

  return {
    provider,
    name: name || `${formatProviderLabel(provider)} credential`,
    credentialType: provider === "codex_oauth" ? "oauth" : "api_key",
    storedSecret: provider === "codex_oauth"
      ? {
          kind: "codex_auth_json",
          authJson: validateCodexAuthJson(secret),
        }
      : {
          kind: "api_key",
          apiKey: secret,
        },
  };
}

function validateUserAiAccessInput(
  input: UpdateUserAiAccessInput & { userId: string },
): UpsertUserAiAccessPolicyInput {
  const enabled = input.enabled === true;
  const provider = parseAiAccessProvider(input.provider);
  const credentialId =
    typeof input.credentialId === "string" && input.credentialId.trim()
      ? input.credentialId.trim()
      : null;
  const defaultModel = typeof input.defaultModel === "string" ? input.defaultModel.trim() : "";
  const allowedModels = normalizeAllowedModels(input.allowedModels);

  if (enabled && !provider) {
    throw new HttpError("invalid_ai_access_provider", 400);
  }

  if (enabled && provider === "codex_oauth" && !credentialId) {
    throw new HttpError("invalid_ai_access_credential_id", 400);
  }

  if (enabled && !defaultModel) {
    throw new HttpError("invalid_ai_access_default_model", 400);
  }

  if (allowedModels.length > 0 && defaultModel && !allowedModels.includes(defaultModel)) {
    throw new HttpError("invalid_ai_access_allowed_models", 400);
  }

  return {
    userId: input.userId,
    enabled,
    provider,
    credentialId,
    defaultModel: defaultModel || null,
    allowedModels,
  };
}

function parseAiAccessProvider(value: unknown): AiAccessProvider | null {
  return isAiGatewayProvider(value) ? value : null;
}

function normalizeAllowedModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    unique.add(trimmed);
  }

  return Array.from(unique);
}

function validateCodexAuthJson(secret: string): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new HttpError("invalid_credential_secret", 400);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError("invalid_credential_secret", 400);
  }

  const authMode = typeof (parsed as { auth_mode?: unknown }).auth_mode === "string"
    ? (parsed as { auth_mode: string }).auth_mode.trim()
    : "";
  const tokens = (parsed as { tokens?: unknown }).tokens;
  const tokenRecord = tokens && typeof tokens === "object" && !Array.isArray(tokens)
    ? (tokens as Record<string, unknown>)
    : null;
  const requiredTokenFields = ["id_token", "access_token", "refresh_token", "account_id"];
  const hasRequiredTokens = tokenRecord
    ? requiredTokenFields.every((key) => typeof tokenRecord[key] === "string" && tokenRecord[key]?.trim())
    : false;

  if (!authMode || !hasRequiredTokens) {
    throw new HttpError("invalid_credential_secret", 400);
  }

  return secret;
}

function toAdminCredentialRecord(record: GatewayCredentialRecord): CredentialRecord {
  return {
    id: record.id,
    name: record.name?.trim() || `${formatProviderLabel(record.provider)} ${record.id}`,
    provider: record.provider,
    type: record.credentialType,
    state: record.state,
    scope: record.ownerUserId,
    activeLeases: 0,
    alertCount: 0,
    lastRefreshAt: record.updatedAt.toISOString(),
    lastFailureAt: record.lastFailureAt instanceof Date ? record.lastFailureAt.toISOString() : null,
    totalTokens: 0,
    nextRotationAt: null,
    linkedAlertIds: [],
  };
}

function toAdminUserAiAccessRecord(record: UserAiAccessPolicyRecord | null): AdminUserAiAccessRecord | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    userId: record.userId,
    enabled: record.enabled,
    provider: record.provider,
    credentialId: record.credentialId,
    defaultModel: record.defaultModel,
    allowedModels: record.allowedModels,
    updatedAt: record.updatedAt.toISOString(),
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

function getAdminActorUserId(res: express.Response) {
  const session = res.locals.adminSession as AdminSessionSnapshot | undefined;
  return session?.user.email ?? session?.user.id ?? null;
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
    try {
      const payload = await adminService.listCredentials(res.locals.adminToken as string);
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "credential_list_failed" });
    }
  });

  router.post("/admin/api/credentials", async (req, res) => {
    try {
      const payload = await adminService.createCredential(
        res.locals.adminToken as string,
        {
          provider: parseCredentialProvider(req.body?.provider),
          name: typeof req.body?.name === "string" ? req.body.name.trim() : "",
          secret: typeof req.body?.secret === "string" ? req.body.secret.trim() : "",
        },
        getAdminActorUserId(res),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "credential_create_failed" });
    }
  });

  router.post("/admin/api/credentials/:credentialId/revoke", async (req, res) => {
    try {
      const payload = await adminService.revokeCredential(
        res.locals.adminToken as string,
        req.params.credentialId,
        getAdminActorUserId(res),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "credential_revoke_failed" });
    }
  });

  router.post("/admin/api/credentials/:credentialId/drain", async (req, res) => {
    try {
      const payload = await adminService.drainCredential(
        res.locals.adminToken as string,
        req.params.credentialId,
        getAdminActorUserId(res),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "credential_drain_failed" });
    }
  });

  router.post("/admin/api/credentials/:credentialId/rotate", async (req, res) => {
    try {
      const payload = await adminService.rotateCredential(
        res.locals.adminToken as string,
        req.params.credentialId,
        getAdminActorUserId(res),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "credential_rotate_failed" });
    }
  });

  router.get("/admin/api/sessions", async (req, res) => {
    try {
      const payload = await adminService.listSessions(res.locals.adminToken as string);
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "session_list_failed" });
    }
  });

  router.get("/admin/api/usage", async (req, res) => {
    try {
      const payload = await adminService.getUsage(res.locals.adminToken as string, {
        groupBy: normalizeGroupBy(req.query.groupBy),
        credentialId: typeof req.query.credentialId === "string" && req.query.credentialId.trim() ? req.query.credentialId.trim() : null,
        userId: typeof req.query.userId === "string" && req.query.userId.trim() ? req.query.userId.trim() : null,
        orgId: typeof req.query.orgId === "string" && req.query.orgId.trim() ? req.query.orgId.trim() : null,
      });
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "usage_lookup_failed" });
    }
  });

  router.get("/admin/api/alerts", async (req, res) => {
    try {
      const payload = await adminService.listAlerts(res.locals.adminToken as string);
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "alert_list_failed" });
    }
  });

  router.post("/admin/api/alerts/:alertId/acknowledge", async (req, res) => {
    try {
      const payload = await adminService.acknowledgeAlert(
        res.locals.adminToken as string,
        req.params.alertId,
        getAdminActorUserId(res),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "alert_acknowledge_failed" });
    }
  });

  router.post("/admin/api/alerts/:alertId/resolve", async (req, res) => {
    try {
      const payload = await adminService.resolveAlert(
        res.locals.adminToken as string,
        req.params.alertId,
        getAdminActorUserId(res),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "alert_resolve_failed" });
    }
  });

  router.get("/admin/api/audit", async (req, res) => {
    try {
      const payload = await adminService.listAudit(res.locals.adminToken as string);
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "audit_list_failed" });
    }
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

  router.get("/admin/api/users/:userId/ai-access", async (req, res) => {
    try {
      const payload = await adminService.getUserAiAccess(res.locals.adminToken as string, req.params.userId);
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "user_ai_access_lookup_failed" });
    }
  });

  router.put("/admin/api/users/:userId/ai-access", async (req, res) => {
    try {
      const payload = await adminService.upsertUserAiAccess(res.locals.adminToken as string, req.params.userId, {
        enabled: req.body?.enabled === true,
        provider: parseAiAccessProvider(req.body?.provider),
        credentialId: typeof req.body?.credentialId === "string" ? req.body.credentialId : null,
        defaultModel: typeof req.body?.defaultModel === "string" ? req.body.defaultModel.trim() : null,
        allowedModels: normalizeAllowedModels(req.body?.allowedModels),
      });
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "user_ai_access_update_failed" });
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

function parseCredentialProvider(value: unknown): LeaseProvider | null {
  return isAiGatewayProvider(value) ? value : null;
}
