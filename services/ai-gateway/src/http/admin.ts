import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import express, { Router } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAutoAssignedCodexCredentialRotationService, type AutoAssignedCodexCredentialRotationService } from "../access/auto-assignment-rotation.js";
import type { AlertRecord, AlertRepository } from "../alerts/repository.js";
import type { AiAccessProvider, AiAccessRepository, UpsertUserAiAccessPolicyInput, UserAiAccessPolicyRecord } from "../access/repository.js";
import { MySqlAiAccessRepository } from "../access/mysql-repository.js";
import { MySqlAlertRepository } from "../alerts/mysql-repository.js";
import type { AuditRepository, AuditEventRecord, ListAuditEventsInput } from "../audit/repository.js";
import { MySqlAuditRepository } from "../audit/mysql-repository.js";
import { getPlatformCredentialOwnerUserId } from "../credentials/platform-owner.js";
import { MySqlCredentialRepository } from "../credentials/mysql-repository.js";
import { MySqlSecretStore } from "../credentials/mysql-secret-store.js";
import type { AdminCredentialRecord, CreatePlatformCredentialInput, CredentialRecord as GatewayCredentialRecord, CredentialRepository } from "../credentials/repository.js";
import type { SecretStore, StoredSecret } from "../credentials/secret-store.js";
import type { AiGatewayDb } from "../db/index.js";
import { createDb } from "../db/index.js";
import { credentialBindingTable, credentialHealthEventTable, credentialRecordTable, credentialUsageEventTable, sessionLeaseTable, userAiAccessPolicyTable, type CredentialState } from "../db/schema.js";
import { env } from "../env.js";
import type { AdminSessionRecord, LeaseProvider } from "../leases/repository.js";
import { CODEX_DEFAULT_MODEL, listCodexModelCatalog, resolveCodexModelPolicy } from "../providers/codex-model-catalog.js";
import { formatAiGatewayProviderLabel, isAiGatewayProvider } from "../providers/ids.js";
import { OpenAiCompatibleTransport } from "../providers/openai-compatible-transport.js";
import { ProviderTransportError, type OpenAiCompatibleProviderTransport } from "../providers/transport.js";
import { evaluateCodexCredentialEligibility } from "../usage/codex-eligibility.js";
import { MySqlUsageRepository } from "../usage/mysql-repository.js";
import { CachedCodexCredentialStatusProvider, UnavailableCodexCredentialStatusProvider, type CodexCredentialStatusProvider, type CodexUsageStatus } from "../usage/codex-status.js";
import type { AggregateUsageInput, UsageAggregateResponse, UsageCredentialAggregate, UsageGroupBy as RepositoryUsageGroupBy, UsageRepository } from "../usage/repository.js";

const OrganizationAdminCapabilities = ["organization", "users"] as const;
const PlatformAdminCapabilities = [
  ...OrganizationAdminCapabilities,
  "credentials",
  "sessions",
  "usage",
  "alerts",
  "audit",
  "debugLogs",
  "managedAiUserAccess",
] as const;
const OrganizationAdminAllowedPages = ["organization", "users"] as const;
const PlatformAdminAllowedPages = [
  ...OrganizationAdminAllowedPages,
  "credentials",
  "sessions",
  "usage",
  "alerts",
  "audit",
] as const;

export type AdminCapability = (typeof PlatformAdminCapabilities)[number];
export type AdminAllowedPage = (typeof PlatformAdminAllowedPages)[number];
export type AdminOrganizationRole = "organization_admin" | "owner" | "member";
export type CurrentAdminOrganizationRole = "organization_admin" | "member";

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
  role: CurrentAdminOrganizationRole;
};

export type AdminSessionSnapshot = {
  user: AdminSessionUser;
  platformAdmin: boolean;
  activeOrgId: string | null;
  organizations: AdminSessionOrganization[];
  capabilities?: AdminCapability[];
  allowedPages?: AdminAllowedPage[];
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
    role: CurrentAdminOrganizationRole;
  }>;
};

export type AdminOrganizationRecord = {
  id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  seatLimit: number | null;
  createdAt?: string;
  updatedAt?: string;
};

export type AdminOrganizationMemberRecord = {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: CurrentAdminOrganizationRole;
  status?: "active" | "disabled" | "removed";
  createdAt: string;
};

export type AdminOrganizationDomainRecord = {
  id: string;
  orgId: string;
  domain: string;
  enabled: boolean;
  selfSignupEnabled: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type AdminOrganizationInviteRecord = {
  id: string;
  orgId: string;
  email: string;
  role: CurrentAdminOrganizationRole;
  status: "pending" | "accepted" | "expired" | "revoked";
  invitedByUserId: string | null;
  acceptedByUserId: string | null;
  expiresAt: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type CredentialRecord = AdminCredentialRecord & {
  cachedTokens?: number;
  upstreamStatus?: CodexUsageStatus | null;
  eligibility?: AdminCredentialEligibility;
};

export type SessionRecord = AdminSessionRecord;

export type AuditRecord = AuditEventRecord;

export type UsageGroupBy = RepositoryUsageGroupBy;

export type AdminCredentialUsageRecord = UsageCredentialAggregate & {
  name: string;
  provider: string | null;
  state: CredentialState | null;
  activeLeases: number;
  cachedTokens: number;
  upstreamStatus: CodexUsageStatus | null;
  eligibility?: AdminCredentialEligibility;
};

export type UsageResponse = Omit<UsageAggregateResponse, "credentialUsage"> & {
  credentialUsage: AdminCredentialUsageRecord[];
};

export type AdminCredentialEligibility = {
  state: "eligible" | "exhausted" | "unavailable" | "unhealthy" | "draining" | "revoked";
  reason: string | null;
  resetAt: string | null;
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
  provider: AiAccessProvider;
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
  orgRole?: AdminOrganizationRole;
};

export type UpdateUserInput = {
  name?: string;
  platformAdmin?: boolean;
  orgId?: string | null;
  orgRole?: AdminOrganizationRole;
};

export type UpdateOrganizationInput = {
  name?: string;
  slug?: string;
  seatLimit?: number | null;
};

export type CreateOrganizationDomainInput = {
  domain: string;
  enabled: boolean;
  selfSignupEnabled: boolean;
};

export type UpdateOrganizationDomainInput = {
  enabled?: boolean;
  selfSignupEnabled?: boolean;
};

export type CreateOrganizationInviteInput = {
  email: string;
  role: AdminOrganizationRole;
  expiresAt?: string | null;
};

export type CreateOrganizationMemberInput = {
  email: string;
  role: AdminOrganizationRole;
};

export type UpdateOrganizationMemberInput = {
  role: AdminOrganizationRole;
};

export type CreateCredentialInput = {
  provider: LeaseProvider | null;
  name?: string | null;
  secret: string;
  baseUrl?: string | null;
};

export type ListCredentialsInput = {
  includeDeleted?: boolean;
};

export interface AdminService {
  startBrowserAuth(input: BrowserAuthStartInput): Promise<BrowserAuthStartPayload>;
  exchangeBrowserAuth(input: BrowserAuthExchangeInput): Promise<AuthPayload>;
  getSession(token: string): Promise<AdminSessionSnapshot>;
  listUsers(token: string): Promise<AdminUserRecord[]>;
  createUser(token: string, input: CreateUserInput): Promise<AdminUserRecord>;
  getEligibleCodexCredentialForAutoAssign(): Promise<EligibleCodexCredential | null>;
  updateUser(token: string, userId: string, input: UpdateUserInput): Promise<AdminUserRecord>;
  listOrganizations(token: string): Promise<{ organizations: AdminOrganizationRecord[] }>;
  getOrganization(token: string, orgId: string): Promise<{ organization: AdminOrganizationRecord }>;
  updateOrganization(token: string, orgId: string, input: UpdateOrganizationInput): Promise<{ organization: AdminOrganizationRecord }>;
  listOrganizationMembers(token: string, orgId: string): Promise<{ members: AdminOrganizationMemberRecord[] }>;
  createOrganizationMember(token: string, orgId: string, input: CreateOrganizationMemberInput): Promise<{ member: AdminOrganizationMemberRecord }>;
  updateOrganizationMember(token: string, orgId: string, memberId: string, input: UpdateOrganizationMemberInput): Promise<{ member: AdminOrganizationMemberRecord }>;
  deleteOrganizationMember(token: string, orgId: string, memberId: string): Promise<void>;
  listOrganizationDomains(token: string, orgId: string): Promise<{ domains: AdminOrganizationDomainRecord[] }>;
  createOrganizationDomain(token: string, orgId: string, input: CreateOrganizationDomainInput): Promise<{ domain: AdminOrganizationDomainRecord }>;
  updateOrganizationDomain(token: string, orgId: string, domainId: string, input: UpdateOrganizationDomainInput): Promise<{ domain: AdminOrganizationDomainRecord }>;
  deleteOrganizationDomain(token: string, orgId: string, domainId: string): Promise<void>;
  listOrganizationInvites(token: string, orgId: string): Promise<{ invites: AdminOrganizationInviteRecord[] }>;
  createOrganizationInvite(token: string, orgId: string, input: CreateOrganizationInviteInput): Promise<{ invite: AdminOrganizationInviteRecord }>;
  revokeOrganizationInvite(token: string, orgId: string, inviteId: string): Promise<{ invite: AdminOrganizationInviteRecord }>;
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
  listCredentials(_token: string, input?: ListCredentialsInput): Promise<{ credentials: CredentialRecord[] }>;
  listCredentialModels(_token: string, credentialId: string): Promise<{ credentialId: string; models: string[]; defaultModel?: string }>;
  createCredential(_token: string, input: CreateCredentialInput, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
  revokeCredential(_token: string, credentialId: string, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
  drainCredential(_token: string, credentialId: string, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
  rotateCredential(_token: string, credentialId: string, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
  deleteCredential(_token: string, credentialId: string, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
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
  listOrganizations(token: string): Promise<{ organizations: AdminOrganizationRecord[] }>;
  getOrganization(token: string, orgId: string): Promise<{ organization: AdminOrganizationRecord }>;
  updateOrganization(token: string, orgId: string, input: UpdateOrganizationInput): Promise<{ organization: AdminOrganizationRecord }>;
  listOrganizationMembers(token: string, orgId: string): Promise<{ members: AdminOrganizationMemberRecord[] }>;
  createOrganizationMember(token: string, orgId: string, input: CreateOrganizationMemberInput): Promise<{ member: AdminOrganizationMemberRecord }>;
  updateOrganizationMember(token: string, orgId: string, memberId: string, input: UpdateOrganizationMemberInput): Promise<{ member: AdminOrganizationMemberRecord }>;
  deleteOrganizationMember(token: string, orgId: string, memberId: string): Promise<void>;
  listOrganizationDomains(token: string, orgId: string): Promise<{ domains: AdminOrganizationDomainRecord[] }>;
  createOrganizationDomain(token: string, orgId: string, input: CreateOrganizationDomainInput): Promise<{ domain: AdminOrganizationDomainRecord }>;
  updateOrganizationDomain(token: string, orgId: string, domainId: string, input: UpdateOrganizationDomainInput): Promise<{ domain: AdminOrganizationDomainRecord }>;
  deleteOrganizationDomain(token: string, orgId: string, domainId: string): Promise<void>;
  listOrganizationInvites(token: string, orgId: string): Promise<{ invites: AdminOrganizationInviteRecord[] }>;
  createOrganizationInvite(token: string, orgId: string, input: CreateOrganizationInviteInput): Promise<{ invite: AdminOrganizationInviteRecord }>;
  revokeOrganizationInvite(token: string, orgId: string, inviteId: string): Promise<{ invite: AdminOrganizationInviteRecord }>;
  disableUser(token: string, userId: string): Promise<AdminUserRecord>;
  enableUser(token: string, userId: string): Promise<AdminUserRecord>;
  deleteUser(token: string, userId: string): Promise<void>;
};

const ADMIN_AUTH_COOKIE_NAME = "veslo.ai-gateway.admin.token";
const ADMIN_PENDING_AUTH_COOKIE_NAME = "veslo.ai-gateway.admin.browser-auth";
const ADMIN_AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const ADMIN_PENDING_AUTH_COOKIE_MAX_AGE_SECONDS = 10 * 60;
const ADMIN_AUTH_RANDOM_BYTES = 32;

type PendingAdminBrowserAuth = {
  sessionId: string;
  state: string;
  codeVerifier: string;
  returnTo: string;
  createdAt: string;
};

type AdminCredentialReadRepository = {
  listAdminCredentials(input?: ListCredentialsInput): Promise<CredentialRecord[]>;
};

type DeleteCredentialBlockReason =
  | "credential_not_found"
  | "credential_already_deleted"
  | "credential_still_healthy"
  | "credential_has_active_leases"
  | "credential_assigned_to_users";

type DeleteCredentialResult =
  | { deleted: true; secretRef: string; deletedAt: string }
  | { deleted: false; reason: DeleteCredentialBlockReason };

type AdminSessionReadRepository = {
  listAdminSessions(): Promise<SessionRecord[]>;
};

type AdminCredentialActionRepository = {
  revokeCredential(credentialId: string): Promise<boolean>;
  drainCredential(credentialId: string): Promise<boolean>;
  rotateCredential(credentialId: string): Promise<boolean>;
  deleteCredential(input: { credentialId: string; allowHealthyUnavailable?: boolean }): Promise<DeleteCredentialResult>;
};

type AdminCredentialWriteRepository = {
  createPlatformCredential(input: CreatePlatformCredentialInput): Promise<GatewayCredentialRecord>;
};

type CredentialSecretLookupRepository = {
  getCredentialRecordById(credentialId: string): Promise<Pick<GatewayCredentialRecord, "provider" | "secretRef"> | null>;
};

type AdminReadModelDependencies = {
  denClient?: DenAdminApi;
  credentialReadRepository?: AdminCredentialReadRepository;
  credentialActionRepository?: AdminCredentialActionRepository;
  credentialWriteRepository?: AdminCredentialWriteRepository;
  credentialSecretLookupRepository?: CredentialSecretLookupRepository;
  credentialRotationService?: AutoAssignedCodexCredentialRotationService;
  sessionReadRepository?: AdminSessionReadRepository;
  aiAccessRepository?: AiAccessRepository;
  alertRepository?: AlertRepository;
  usageRepository?: UsageRepository;
  codexStatusProvider?: CodexCredentialStatusProvider;
  auditRepository?: AuditRepository;
  secretStore?: SecretStore;
  openAiCompatibleTransport?: OpenAiCompatibleProviderTransport;
  now?: () => Date;
};

export class MySqlAdminCredentialReadRepository implements AdminCredentialReadRepository {
  constructor(private readonly db: AiGatewayDb) {}

  async listAdminCredentials(input: ListCredentialsInput = {}): Promise<CredentialRecord[]> {
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
          cachedTokens: sql<number>`coalesce(sum(${credentialUsageEventTable.cached_tokens}), 0)`,
          totalTokens: sql<number>`coalesce(sum(${credentialUsageEventTable.total_tokens}), 0)`,
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
    const cachedTokensByCredential = new Map(
      usageRows.map((row) => [row.credentialRecordId, Number(row.cachedTokens ?? 0)]),
    );

    return credentialRows
      .filter((row) => input.includeDeleted === true || !row.deleted_at)
      .map((row) => ({
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
        cachedTokens: cachedTokensByCredential.get(row.id) ?? 0,
        totalTokens: totalTokensByCredential.get(row.id) ?? 0,
        nextRotationAt: null,
        linkedAlertIds: [],
        ...(row.deleted_at ? { deletedAt: toIsoString(row.deleted_at) } : {}),
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

export class MySqlAdminCredentialActionRepository implements AdminCredentialActionRepository {
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
            isNull(credentialRecordTable.deleted_at),
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

  async deleteCredential(input: { credentialId: string; allowHealthyUnavailable?: boolean }): Promise<DeleteCredentialResult> {
    const credential = await this.getCredential(input.credentialId);
    if (!credential) {
      return { deleted: false, reason: "credential_not_found" };
    }

    if (credential.deleted_at) {
      return { deleted: false, reason: "credential_already_deleted" };
    }

    if (credential.state === "healthy" && input.allowHealthyUnavailable !== true) {
      return { deleted: false, reason: "credential_still_healthy" };
    }

    const activeLeases = await this.countActiveLeases(input.credentialId);
    if (activeLeases > 0 && credential.state !== "revoked") {
      return { deleted: false, reason: "credential_has_active_leases" };
    }

    const assignedUsers = await this.countAssignedUsers(input.credentialId);
    if (assignedUsers > 0 && credential.state !== "revoked") {
      return { deleted: false, reason: "credential_assigned_to_users" };
    }

    const deletedAt = new Date();
    const nextState: CredentialState = credential.state === "healthy" ? "revoked" : credential.state;
    await this.db
      .update(credentialRecordTable)
      .set({
        state: nextState,
        deleted_at: deletedAt,
        updated_at: deletedAt,
      })
      .where(eq(credentialRecordTable.id, input.credentialId));

    if (nextState !== credential.state) {
      await this.db.insert(credentialHealthEventTable).values({
        id: `health_${randomUUID()}`,
        credential_record_id: input.credentialId,
        from_state: credential.state,
        to_state: nextState,
        reason: "admin_delete",
        created_at: deletedAt,
      });
    }

    return {
      deleted: true,
      secretRef: credential.secret_ref,
      deletedAt: deletedAt.toISOString(),
    };
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

  private async countActiveLeases(credentialId: string): Promise<number> {
    const rows = await this.db
      .select({ activeLeases: sql<number>`count(*)` })
      .from(sessionLeaseTable)
      .innerJoin(credentialBindingTable, eq(sessionLeaseTable.active_binding_id, credentialBindingTable.id))
      .where(eq(credentialBindingTable.credential_record_id, credentialId));

    return Number(rows[0]?.activeLeases ?? 0);
  }

  private async countAssignedUsers(credentialId: string): Promise<number> {
    const rows = await this.db
      .select({ assignedUsers: sql<number>`count(*)` })
      .from(userAiAccessPolicyTable)
      .where(eq(userAiAccessPolicyTable.credential_id, credentialId));

    return Number(rows[0]?.assignedUsers ?? 0);
  }
}

function createDefaultAdminReadRepositories() {
  let repositories:
    | {
        credentialReadRepository: AdminCredentialReadRepository;
        credentialActionRepository: AdminCredentialActionRepository;
        credentialWriteRepository: AdminCredentialWriteRepository;
        credentialSecretLookupRepository: CredentialSecretLookupRepository;
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
    const credentialRepository = new MySqlCredentialRepository(handle.db);
    repositories = {
      credentialReadRepository: new MySqlAdminCredentialReadRepository(handle.db),
      credentialActionRepository: new MySqlAdminCredentialActionRepository(handle.db),
      credentialWriteRepository: credentialRepository,
      credentialSecretLookupRepository: credentialRepository,
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
  return formatAiGatewayProviderLabel(provider);
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
    cachedTokens: 0,
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

function selectCredentialUsageCredentials(
  credentials: CredentialRecord[],
  historicalByCredentialId: Map<string, UsageCredentialAggregate>,
  filters: AggregateUsageInput,
): CredentialRecord[] {
  if (filters.credentialId) {
    return credentials.filter((credential) => credential.id === filters.credentialId);
  }

  if (filters.userId || filters.orgId) {
    return credentials.filter((credential) => historicalByCredentialId.has(credential.id));
  }

  return credentials;
}

function readCachedTokens(entry: UsageCredentialAggregate | CredentialRecord | null | undefined): number {
  const cachedTokens = (entry as { cachedTokens?: unknown } | null | undefined)?.cachedTokens;
  return typeof cachedTokens === "number" && Number.isFinite(cachedTokens) ? cachedTokens : 0;
}

function normalizeCodexEligibilityReason(reason: string | null): string | null {
  if (!reason) {
    return null;
  }

  const match = reason.match(/^(.+?)\s+Codex limit is exhausted\.$/);
  if (match?.[1]) {
    return `${match[1]} limit exhausted`;
  }

  return reason;
}

function credentialStateEligibility(credential: CredentialRecord): AdminCredentialEligibility | null {
  if (credential.state === "draining") {
    return { state: "draining", reason: "Credential is draining.", resetAt: null };
  }

  if (credential.state === "revoked") {
    return { state: "revoked", reason: "Credential is revoked.", resetAt: null };
  }

  if (credential.state === "unhealthy" || credential.state === "degraded") {
    return { state: "unhealthy", reason: "Credential is not healthy.", resetAt: null };
  }

  return null;
}

function readCodexCredentialEligibility(
  credential: CredentialRecord,
  upstreamStatus: CodexUsageStatus | null,
  now: Date,
): AdminCredentialEligibility {
  const stateEligibility = credentialStateEligibility(credential);
  if (stateEligibility) {
    return stateEligibility;
  }

  if (!upstreamStatus) {
    return { state: "unavailable", reason: "No upstream status.", resetAt: null };
  }

  const eligibility = evaluateCodexCredentialEligibility(upstreamStatus, now);
  return {
    state: eligibility.state,
    reason: normalizeCodexEligibilityReason(eligibility.reason),
    resetAt: "resetAt" in eligibility ? eligibility.resetAt : null,
  };
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

  private adminHeaders(token: string, jsonBody = false): HeadersInit {
    return {
      ...(jsonBody ? { "content-type": "application/json" } : {}),
      accept: "application/json",
      authorization: `Bearer ${token}`,
    };
  }

  private async requestNoContent(pathname: string, token: string) {
    const response = await fetch(`${this.denApiBase}${pathname}`, {
      method: "DELETE",
      headers: this.adminHeaders(token),
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
      headers: this.adminHeaders(token),
    }) as Promise<AdminSessionSnapshot>;
  }

  async listUsers(token: string) {
    const payload = await this.requestJson("/v1/admin/users", {
      headers: this.adminHeaders(token),
    }) as { users: AdminUserRecord[] };
    return payload.users;
  }

  async createUser(token: string, input: CreateUserInput) {
    const payload = await this.requestJson("/v1/admin/users", {
      method: "POST",
      headers: this.adminHeaders(token, true),
      body: JSON.stringify(input),
    }) as { user: AdminUserRecord };
    return payload.user;
  }

  async updateUser(token: string, userId: string, input: UpdateUserInput) {
    const payload = await this.requestJson(`/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: this.adminHeaders(token, true),
      body: JSON.stringify(input),
    }) as { user: AdminUserRecord };
    return payload.user;
  }

  async listOrganizations(token: string) {
    return this.requestJson("/v1/admin/organizations", {
      headers: this.adminHeaders(token),
    }) as Promise<{ organizations: AdminOrganizationRecord[] }>;
  }

  async getOrganization(token: string, orgId: string) {
    return this.requestJson(`/v1/admin/organizations/${encodeURIComponent(orgId)}`, {
      headers: this.adminHeaders(token),
    }) as Promise<{ organization: AdminOrganizationRecord }>;
  }

  async updateOrganization(token: string, orgId: string, input: UpdateOrganizationInput) {
    return this.requestJson(`/v1/admin/organizations/${encodeURIComponent(orgId)}`, {
      method: "PATCH",
      headers: this.adminHeaders(token, true),
      body: JSON.stringify(input),
    }) as Promise<{ organization: AdminOrganizationRecord }>;
  }

  async listOrganizationMembers(token: string, orgId: string) {
    return this.requestJson(`/v1/admin/organizations/${encodeURIComponent(orgId)}/members`, {
      headers: this.adminHeaders(token),
    }) as Promise<{ members: AdminOrganizationMemberRecord[] }>;
  }

  async createOrganizationMember(token: string, orgId: string, input: CreateOrganizationMemberInput) {
    return this.requestJson(`/v1/admin/organizations/${encodeURIComponent(orgId)}/members`, {
      method: "POST",
      headers: this.adminHeaders(token, true),
      body: JSON.stringify(input),
    }) as Promise<{ member: AdminOrganizationMemberRecord }>;
  }

  async updateOrganizationMember(token: string, orgId: string, memberId: string, input: UpdateOrganizationMemberInput) {
    return this.requestJson(
      `/v1/admin/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}`,
      {
        method: "PATCH",
        headers: this.adminHeaders(token, true),
        body: JSON.stringify(input),
      },
    ) as Promise<{ member: AdminOrganizationMemberRecord }>;
  }

  async deleteOrganizationMember(token: string, orgId: string, memberId: string) {
    await this.requestNoContent(
      `/v1/admin/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}`,
      token,
    );
  }

  async listOrganizationDomains(token: string, orgId: string) {
    return this.requestJson(`/v1/admin/organizations/${encodeURIComponent(orgId)}/domains`, {
      headers: this.adminHeaders(token),
    }) as Promise<{ domains: AdminOrganizationDomainRecord[] }>;
  }

  async createOrganizationDomain(token: string, orgId: string, input: CreateOrganizationDomainInput) {
    return this.requestJson(`/v1/admin/organizations/${encodeURIComponent(orgId)}/domains`, {
      method: "POST",
      headers: this.adminHeaders(token, true),
      body: JSON.stringify(input),
    }) as Promise<{ domain: AdminOrganizationDomainRecord }>;
  }

  async updateOrganizationDomain(token: string, orgId: string, domainId: string, input: UpdateOrganizationDomainInput) {
    return this.requestJson(
      `/v1/admin/organizations/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}`,
      {
        method: "PATCH",
        headers: this.adminHeaders(token, true),
        body: JSON.stringify(input),
      },
    ) as Promise<{ domain: AdminOrganizationDomainRecord }>;
  }

  async deleteOrganizationDomain(token: string, orgId: string, domainId: string) {
    await this.requestNoContent(
      `/v1/admin/organizations/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}`,
      token,
    );
  }

  async listOrganizationInvites(token: string, orgId: string) {
    return this.requestJson(`/v1/admin/organizations/${encodeURIComponent(orgId)}/invites`, {
      headers: this.adminHeaders(token),
    }) as Promise<{ invites: AdminOrganizationInviteRecord[] }>;
  }

  async createOrganizationInvite(token: string, orgId: string, input: CreateOrganizationInviteInput) {
    return this.requestJson(`/v1/admin/organizations/${encodeURIComponent(orgId)}/invites`, {
      method: "POST",
      headers: this.adminHeaders(token, true),
      body: JSON.stringify(input),
    }) as Promise<{ invite: AdminOrganizationInviteRecord }>;
  }

  async revokeOrganizationInvite(token: string, orgId: string, inviteId: string) {
    return this.requestJson(
      `/v1/admin/organizations/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}/revoke`,
      {
        method: "POST",
        headers: this.adminHeaders(token),
      },
    ) as Promise<{ invite: AdminOrganizationInviteRecord }>;
  }

  async disableUser(token: string, userId: string) {
    const payload = await this.requestJson(`/v1/admin/users/${encodeURIComponent(userId)}/disable`, {
      method: "POST",
      headers: this.adminHeaders(token),
    }) as { user: AdminUserRecord };
    return payload.user;
  }

  async enableUser(token: string, userId: string) {
    const payload = await this.requestJson(`/v1/admin/users/${encodeURIComponent(userId)}/enable`, {
      method: "POST",
      headers: this.adminHeaders(token),
    }) as { user: AdminUserRecord };
    return payload.user;
  }

  async deleteUser(token: string, userId: string) {
    const response = await fetch(`${this.denApiBase}/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      headers: this.adminHeaders(token),
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
    deps.credentialSecretLookupRepository ?? getDefaultRepositories().credentialSecretLookupRepository;
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
  const openAiCompatibleTransport = deps.openAiCompatibleTransport ?? new OpenAiCompatibleTransport();
  const now = deps.now ?? (() => new Date());
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
          saveCredentialAuthJson: async (credentialId, authJson) => {
            const credential = await getCredentialSecretLookupRepository().getCredentialRecordById(credentialId);
            if (!credential) {
              return;
            }
            await getSecretStore().replace(credential.secretRef, {
              kind: "codex_auth_json",
              authJson,
            });
          },
        })
      : new UnavailableCodexCredentialStatusProvider());
  let credentialRotationService: AutoAssignedCodexCredentialRotationService | null =
    deps.credentialRotationService ?? null;

  function getCredentialRotationService() {
    if (!credentialRotationService) {
      credentialRotationService = createAutoAssignedCodexCredentialRotationService({
        aiAccess: getAiAccessRepository(),
        credentials: getCredentialWriteRepository() as unknown as CredentialRepository,
        codexStatusProvider,
        audit: getAuditRepository(),
        now,
      });
    }

    return credentialRotationService;
  }

  async function repairCodexAccessForRead(
    aiAccess: UserAiAccessPolicyRecord | null,
    availableCredentials: AdminCredentialOption[] | undefined,
  ): Promise<UserAiAccessPolicyRecord | null> {
    if (!aiAccess || aiAccess.provider !== "codex_oauth") {
      return aiAccess;
    }

    if (
      aiAccess.credentialId &&
      availableCredentials?.some((entry) =>
        entry.provider === "codex_oauth" && entry.id === aiAccess.credentialId
      )
    ) {
      return aiAccess;
    }

    try {
      return await getCredentialRotationService().repairCodexAccess({
        aiAccess,
        reason: "admin_ai_access_read",
      });
    } catch (error) {
      console.error("admin_codex_assignment_repair_failed", error);
      return aiAccess;
    }
  }

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

  async function listCredentialsWithAlerts(input: ListCredentialsInput = {}): Promise<CredentialRecord[]> {
    const [credentials, alerts] = await Promise.all([
      getCredentialReadRepository().listAdminCredentials(input),
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

  async function withCodexUpstreamStatus(
    credentials: CredentialRecord[],
    statusProvider: CodexCredentialStatusProvider,
  ): Promise<CredentialRecord[]> {
    return Promise.all(
      credentials.map(async (credential) => {
        if (credential.deletedAt) {
          return {
            ...credential,
            upstreamStatus: null,
            eligibility: {
              state: "revoked",
              reason: "Credential is deleted.",
              resetAt: null,
            },
          };
        }

        if (credential.provider !== "codex_oauth") {
          return credential;
        }

        const upstreamStatus = await statusProvider.getStatus({
          credentialId: credential.id,
          credentialName: credential.name,
        });

        return {
          ...credential,
          cachedTokens: readCachedTokens(credential),
          upstreamStatus,
          eligibility: readCodexCredentialEligibility(credential, upstreamStatus, now()),
        };
      }),
    );
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
      if (!evaluateCodexCredentialEligibility(status).eligible) {
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

  async function listAvailableAssignmentCredentials(): Promise<AdminCredentialOption[]> {
    const credentials = await getCredentialReadRepository().listAdminCredentials();
    const options: AdminCredentialOption[] = [];

    for (const credential of credentials) {
      if (credential.state !== "healthy") {
        continue;
      }

      if (credential.provider === "openai_compatible") {
        options.push({
          id: credential.id,
          name: credential.name,
          provider: "openai_compatible",
        });
        continue;
      }

      if (credential.provider !== "codex_oauth") {
        continue;
      }

      const status = await codexStatusProvider.getStatus({
        credentialId: credential.id,
        credentialName: credential.name,
      });
      if (!evaluateCodexCredentialEligibility(status, now()).eligible) {
        continue;
      }

      options.push({
        id: credential.id,
        name: credential.name,
        provider: "codex_oauth",
      });
    }

    return options;
  }

  async function assertAssignableCredential(provider: AiAccessProvider | null, credentialId: string | null): Promise<void> {
    if (provider !== "codex_oauth" && provider !== "openai_compatible") {
      return;
    }

    if (!credentialId) {
      throw new HttpError("invalid_ai_access_credential_id", 400);
    }

    const assignable = (await listAvailableAssignmentCredentials())
      .some((entry) => entry.id === credentialId && entry.provider === provider);
    if (!assignable && provider === "codex_oauth") {
      throw new HttpError("ineligible_ai_access_credential_id", 400);
    }
    if (!assignable) {
      throw new HttpError("invalid_ai_access_credential_id", 400);
    }
  }

  async function getCredentialOrThrow(credentialId: string, input: ListCredentialsInput = {}): Promise<CredentialRecord> {
    const credentials = await listCredentialsWithAlerts(input);
    const credential = credentials.find((entry) => entry.id === credentialId);
    if (!credential) {
      throw new HttpError("credential_not_found", 404);
    }
    return credential;
  }

  function canDeleteHealthyUnavailableCredential(credential: CredentialRecord): boolean {
    return credential.state === "healthy" &&
      credential.provider === "codex_oauth" &&
      credential.eligibility?.state === "unavailable";
  }

  function mapDeleteCredentialResult(result: DeleteCredentialResult): never | { secretRef: string; deletedAt: string } {
    if (result.deleted) {
      return result;
    }

    const status = result.reason === "credential_not_found" ? 404 : 409;
    throw new HttpError(result.reason, status);
  }

  function requireDenOrganizationProxy<T extends keyof DenAdminApi>(methodName: T): NonNullable<DenAdminApi[T]> {
    const method = denClient[methodName];
    if (typeof method !== "function") {
      throw new HttpError("organization_proxy_unavailable", 503);
    }
    return method.bind(denClient) as NonNullable<DenAdminApi[T]>;
  }

  async function withCredentialUsage(
    usage: UsageAggregateResponse,
    credentials: CredentialRecord[],
    statusProvider: CodexCredentialStatusProvider,
    filters: AggregateUsageInput,
  ): Promise<UsageResponse> {
    const historicalUsage = readCredentialUsage(usage);
    const historicalByCredentialId = new Map(historicalUsage.map((entry) => [entry.id, entry]));
    const credentialLabels = new Map(credentials.map((credential) => [credential.id, credential.name]));
    const usageCredentials = selectCredentialUsageCredentials(credentials, historicalByCredentialId, filters);
    let credentialUsage: AdminCredentialUsageRecord[];
    if (usageCredentials.length > 0) {
      credentialUsage = await Promise.all(
        usageCredentials.map(async (credential) => {
          const historical = historicalByCredentialId.get(credential.id);
          return {
            id: credential.id,
            label: credential.name,
            name: credential.name,
            provider: credential.provider,
            state: credential.state,
            activeLeases: credential.activeLeases,
            cachedTokens: historical ? historical.cachedTokens : 0,
            totalTokens: historical?.totalTokens ?? 0,
            totalRequests: historical?.totalRequests ?? 0,
            lastUsedAt: historical?.lastUsedAt ?? null,
            upstreamStatus:
              credential.provider === "codex_oauth"
                ? Object.hasOwn(credential, "upstreamStatus")
                  ? credential.upstreamStatus ?? null
                  : await statusProvider.getStatus({
                      credentialId: credential.id,
                      credentialName: credential.name,
                    })
                : null,
            eligibility: credential.provider === "codex_oauth" && credential.eligibility
              ? credential.eligibility
              : undefined,
          };
        }),
      );
    } else if (credentials.length === 0) {
      credentialUsage = historicalUsage.map((entry) => ({
        id: entry.id,
        label: entry.label,
        name: entry.label,
        provider: null,
        state: null,
        activeLeases: 0,
        cachedTokens: readCachedTokens(entry),
        totalTokens: entry.totalTokens,
        totalRequests: entry.totalRequests,
        lastUsedAt: entry.lastUsedAt,
        upstreamStatus: null,
      }));
    } else {
      credentialUsage = [];
    }

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
    listOrganizations(token) {
      return requireDenOrganizationProxy("listOrganizations")(token);
    },
    getOrganization(token, orgId) {
      return requireDenOrganizationProxy("getOrganization")(token, orgId);
    },
    updateOrganization(token, orgId, input) {
      return requireDenOrganizationProxy("updateOrganization")(token, orgId, input);
    },
    listOrganizationMembers(token, orgId) {
      return requireDenOrganizationProxy("listOrganizationMembers")(token, orgId);
    },
    createOrganizationMember(token, orgId, input) {
      return requireDenOrganizationProxy("createOrganizationMember")(token, orgId, input);
    },
    updateOrganizationMember(token, orgId, memberId, input) {
      return requireDenOrganizationProxy("updateOrganizationMember")(token, orgId, memberId, input);
    },
    deleteOrganizationMember(token, orgId, memberId) {
      return requireDenOrganizationProxy("deleteOrganizationMember")(token, orgId, memberId);
    },
    listOrganizationDomains(token, orgId) {
      return requireDenOrganizationProxy("listOrganizationDomains")(token, orgId);
    },
    createOrganizationDomain(token, orgId, input) {
      return requireDenOrganizationProxy("createOrganizationDomain")(token, orgId, input);
    },
    updateOrganizationDomain(token, orgId, domainId, input) {
      return requireDenOrganizationProxy("updateOrganizationDomain")(token, orgId, domainId, input);
    },
    deleteOrganizationDomain(token, orgId, domainId) {
      return requireDenOrganizationProxy("deleteOrganizationDomain")(token, orgId, domainId);
    },
    listOrganizationInvites(token, orgId) {
      return requireDenOrganizationProxy("listOrganizationInvites")(token, orgId);
    },
    createOrganizationInvite(token, orgId, input) {
      return requireDenOrganizationProxy("createOrganizationInvite")(token, orgId, input);
    },
    revokeOrganizationInvite(token, orgId, inviteId) {
      return requireDenOrganizationProxy("revokeOrganizationInvite")(token, orgId, inviteId);
    },
    async getUserAiAccess(_token, userId) {
      const availableCredentials = await listAvailableAssignmentCredentials();
      const aiAccess = await repairCodexAccessForRead(
        await getAiAccessRepository().getUserAiAccess(userId),
        availableCredentials,
      );

      return {
        aiAccess: toAdminUserAiAccessRecord(aiAccess),
        availableCredentials,
      };
    },
    async upsertUserAiAccess(_token, userId, input) {
      const validated = validateUserAiAccessInput({
        ...input,
        userId,
      });
      if (validated.enabled) {
        await assertAssignableCredential(validated.provider, validated.credentialId);
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
        availableCredentials: await listAvailableAssignmentCredentials(),
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
    async listCredentials(_token, input = {}) {
      return {
        credentials: await withCodexUpstreamStatus(await listCredentialsWithAlerts(input), codexStatusProvider),
      };
    },
    async listCredentialModels(_token, credentialId) {
      const credential = await getCredentialSecretLookupRepository().getCredentialRecordById(credentialId);
      if (!credential) {
        throw new HttpError("credential_not_found", 404);
      }

      if (credential.provider === "codex_oauth") {
        return {
          credentialId,
          models: listCodexModelCatalog(),
          defaultModel: CODEX_DEFAULT_MODEL,
        };
      }

      const secret = await getSecretStore().get(credential.secretRef).catch(() => null);
      if (!secret || secret.kind !== "openai_compatible_api_key") {
        throw new HttpError("invalid_custom_provider_config", 503);
      }

      if (!openAiCompatibleTransport.listModels) {
        throw new HttpError("model_discovery_unavailable", 503);
      }

      try {
        const result = await openAiCompatibleTransport.listModels({
          apiKey: secret.apiKey,
          baseUrl: secret.baseUrl,
        });
        return {
          credentialId,
          models: normalizeDiscoveredModels(result.models),
        };
      } catch (error) {
        throw mapOpenAiCompatibleModelDiscoveryError(error);
      }
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
    async deleteCredential(_token, credentialId, actorUserId) {
      const decoratedCredential = (await withCodexUpstreamStatus(
        [await getCredentialOrThrow(credentialId, { includeDeleted: true })],
        codexStatusProvider,
      ))[0]!;
      const result = mapDeleteCredentialResult(await getCredentialActionRepository().deleteCredential({
        credentialId,
        allowHealthyUnavailable: canDeleteHealthyUnavailableCredential(decoratedCredential),
      }));
      await getSecretStore().replace(result.secretRef, {
        kind: "deleted",
        deletedAt: result.deletedAt,
        reason: "admin_deleted",
      });
      await recordAuditEvent({
        actorUserId,
        action: "credential.delete",
        entityType: "credential",
        entityId: credentialId,
        result: "warning",
        summary: `Deleted credential ${credentialId}.`,
      });
      return { credential: await getCredentialOrThrow(credentialId, { includeDeleted: true }) };
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
      return withCredentialUsage(
        usage,
        await withCodexUpstreamStatus(credentials, codexStatusProvider),
        codexStatusProvider,
        input,
      );
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

  if (provider === "openai_compatible") {
    return {
      provider,
      name: name || `${formatProviderLabel(provider)} credential`,
      credentialType: "api_key",
      storedSecret: {
        kind: "openai_compatible_api_key",
        apiKey: secret,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(input.baseUrl),
      },
    };
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

function normalizeOpenAiCompatibleBaseUrl(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) {
    throw new HttpError("invalid_credential_base_url", 400);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError("invalid_credential_base_url", 400);
  }

  if (parsed.search || parsed.hash || parsed.username || parsed.password || raw.includes("?") || raw.includes("#")) {
    throw new HttpError("invalid_credential_base_url", 400);
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopback =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new HttpError("invalid_credential_base_url", 400);
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
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
  let defaultModel = typeof input.defaultModel === "string" ? input.defaultModel.trim() : "";
  let allowedModels = normalizeAllowedModels(input.allowedModels);
  if (enabled && provider === "codex_oauth") {
    const resolvedPolicy = resolveCodexModelPolicy({
      defaultModel,
      allowedModels,
    });
    defaultModel = resolvedPolicy.defaultModel;
    allowedModels = resolvedPolicy.allowedModels;
  }

  if (enabled && !provider) {
    throw new HttpError("invalid_ai_access_provider", 400);
  }

  if (enabled && (provider === "codex_oauth" || provider === "openai_compatible") && !credentialId) {
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
    assignmentOrigin: "admin_assigned",
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

function normalizeDiscoveredModels(value: unknown): string[] {
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

function mapOpenAiCompatibleModelDiscoveryError(error: unknown): HttpError {
  if (error instanceof ProviderTransportError) {
    if (error.code === "openai_compatible_request_failed") {
      return new HttpError("openai_compatible_model_discovery_failed", error.statusCode ?? 502);
    }
    return new HttpError("openai_compatible_model_discovery_upstream_error", error.statusCode ?? 502);
  }

  return new HttpError("openai_compatible_model_discovery_failed", 502);
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
    cachedTokens: 0,
    nextRotationAt: null,
    linkedAlertIds: [],
    ...(record.deletedAt instanceof Date ? { deletedAt: record.deletedAt.toISOString() } : {}),
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

function readCookie(req: express.Request, name: string): string | null {
  const header = req.header("cookie") ?? "";
  const pairs = header.split(";");
  for (const pair of pairs) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) continue;
    const cookieName = pair.slice(0, separatorIndex).trim();
    if (cookieName !== name) continue;
    const rawValue = pair.slice(separatorIndex + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return null;
}

function readAdminAuthToken(req: express.Request): string | null {
  return readBearerToken(req) ?? readCookie(req, ADMIN_AUTH_COOKIE_NAME);
}

function isHttpsRequest(req: express.Request): boolean {
  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return forwardedProto === "https" || req.secure;
}

function serializeAdminCookie(
  req: express.Request,
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (isHttpsRequest(req)) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function serializeAdminCookieClear(req: express.Request, name: string): string {
  return serializeAdminCookie(req, name, "", 0);
}

function encodePendingAdminBrowserAuth(value: PendingAdminBrowserAuth): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodePendingAdminBrowserAuth(value: string | null): PendingAdminBrowserAuth | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PendingAdminBrowserAuth>;
    if (
      typeof parsed.sessionId !== "string" ||
      typeof parsed.state !== "string" ||
      typeof parsed.codeVerifier !== "string" ||
      typeof parsed.returnTo !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      state: parsed.state,
      codeVerifier: parsed.codeVerifier,
      returnTo: parsed.returnTo,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

function randomBase64Url(byteLength = ADMIN_AUTH_RANDOM_BYTES): string {
  return randomBytes(byteLength).toString("base64url");
}

function createPkceS256Challenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function requestOrigin(req: express.Request): string {
  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol || (req.secure ? "https" : "http");
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.header("host") || "127.0.0.1";
  return `${protocol}://${host}`;
}

function safeAdminPathname(pathname: string): string {
  return pathname === "/admin" || pathname.startsWith("/admin/") ? pathname : "/admin";
}

function safeAdminReturnPath(req: express.Request): string {
  const parsed = new URL(req.originalUrl || req.url || "/admin", "http://admin.local");
  parsed.searchParams.delete("code");
  parsed.searchParams.delete("sessionId");
  parsed.searchParams.delete("transactionId");
  parsed.searchParams.delete("state");
  const pathname = safeAdminPathname(parsed.pathname);
  return `${pathname}${parsed.search}`;
}

function adminRedirectUri(req: express.Request): string {
  return `${requestOrigin(req)}${safeAdminPathname(req.path)}`;
}

function withAuthView(authorizeUrl: string): string {
  try {
    const parsed = new URL(authorizeUrl);
    if (!parsed.searchParams.get("view")) {
      parsed.searchParams.set("view", "auth");
    }
    return parsed.toString();
  } catch {
    return authorizeUrl;
  }
}

function readAdminAuthCallback(req: express.Request): { code: string; sessionId: string } | null {
  const code = typeof req.query.code === "string" ? req.query.code.trim() : "";
  const sessionId =
    typeof req.query.sessionId === "string" && req.query.sessionId.trim()
      ? req.query.sessionId.trim()
      : typeof req.query.transactionId === "string" && req.query.transactionId.trim()
        ? req.query.transactionId.trim()
        : "";
  return code ? { code, sessionId } : null;
}

function adminAssetRequest(pathname: string): boolean {
  return pathname === "/admin/app.js" || pathname === "/admin/app.css";
}

function errorStatus(error: unknown): number | null {
  return error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
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

function defaultAdminCapabilities(platformAdmin: boolean): AdminCapability[] {
  return [...(platformAdmin ? PlatformAdminCapabilities : OrganizationAdminCapabilities)];
}

function defaultAdminAllowedPages(platformAdmin: boolean): AdminAllowedPage[] {
  return [...(platformAdmin ? PlatformAdminAllowedPages : OrganizationAdminAllowedPages)];
}

function adminSessionCapabilities(session: AdminSessionSnapshot | undefined): AdminCapability[] {
  if (!session) {
    return [];
  }
  return Array.isArray(session.capabilities) && session.capabilities.length > 0
    ? session.capabilities
    : defaultAdminCapabilities(session.platformAdmin);
}

function adminSessionAllowedPages(session: AdminSessionSnapshot | undefined): AdminAllowedPage[] {
  if (!session) {
    return [];
  }
  return Array.isArray(session.allowedPages) && session.allowedPages.length > 0
    ? session.allowedPages
    : defaultAdminAllowedPages(session.platformAdmin);
}

function hasAdminCapability(session: AdminSessionSnapshot | undefined, capability: AdminCapability): boolean {
  return adminSessionCapabilities(session).includes(capability);
}

function requireAdminCapability(res: express.Response, capability: AdminCapability): boolean {
  const session = res.locals.adminSession as AdminSessionSnapshot | undefined;
  if (hasAdminCapability(session, capability)) {
    return true;
  }

  res.status(403).json({ error: "forbidden" });
  return false;
}

function pageFromAdminPath(pathname: string): AdminAllowedPage | "overview" {
  const path = pathname.replace(/\/+$/, "");
  if (!path || path === "/admin") {
    return "overview";
  }
  const page = path.split("/").pop() ?? "";
  return PlatformAdminAllowedPages.includes(page as AdminAllowedPage)
    ? page as AdminAllowedPage
    : "overview";
}

function firstAllowedAdminPage(session: AdminSessionSnapshot | undefined): AdminAllowedPage {
  return adminSessionAllowedPages(session)[0] ?? "organization";
}

function hasOwn(input: unknown, key: string): boolean {
  return typeof input === "object" && input !== null && Object.prototype.hasOwnProperty.call(input, key);
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseOrganizationRoleInput(value: unknown): CurrentAdminOrganizationRole | undefined {
  if (value === "organization_admin" || value === "owner") {
    return "organization_admin";
  }
  if (value === "member") {
    return "member";
  }
  return undefined;
}

function readOrganizationRoleInput(value: unknown, fallback: CurrentAdminOrganizationRole): CurrentAdminOrganizationRole {
  return parseOrganizationRoleInput(value) ?? fallback;
}

function readOrganizationUpdateInput(body: unknown): UpdateOrganizationInput {
  const input: UpdateOrganizationInput = {};
  if (hasOwn(body, "name")) {
    input.name = readTrimmedString((body as { name?: unknown }).name) ?? "";
  }
  if (hasOwn(body, "slug")) {
    input.slug = readTrimmedString((body as { slug?: unknown }).slug) ?? "";
  }
  if (hasOwn(body, "seatLimit")) {
    const value = (body as { seatLimit?: unknown }).seatLimit;
    if (value === null || value === undefined || value === "") {
      input.seatLimit = null;
    } else {
      const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new HttpError("invalid_seat_limit", 400);
      }
      input.seatLimit = parsed;
    }
  }
  return input;
}

function readDomainCreateInput(body: unknown): CreateOrganizationDomainInput {
  return {
    domain: readTrimmedString((body as { domain?: unknown } | null)?.domain) ?? "",
    enabled: (body as { enabled?: unknown } | null)?.enabled !== false,
    selfSignupEnabled: (body as { selfSignupEnabled?: unknown } | null)?.selfSignupEnabled === true,
  };
}

function readDomainUpdateInput(body: unknown): UpdateOrganizationDomainInput {
  const input: UpdateOrganizationDomainInput = {};
  if (hasOwn(body, "enabled")) {
    input.enabled = (body as { enabled?: unknown }).enabled === true;
  }
  if (hasOwn(body, "selfSignupEnabled")) {
    input.selfSignupEnabled = (body as { selfSignupEnabled?: unknown }).selfSignupEnabled === true;
  }
  return input;
}

function readInviteCreateInput(body: unknown): CreateOrganizationInviteInput {
  return {
    email: readTrimmedString((body as { email?: unknown } | null)?.email) ?? "",
    role: readOrganizationRoleInput((body as { role?: unknown; orgRole?: unknown } | null)?.role ?? (body as { orgRole?: unknown } | null)?.orgRole, "member"),
    expiresAt: hasOwn(body, "expiresAt")
      ? readTrimmedString((body as { expiresAt?: unknown }).expiresAt) ?? null
      : undefined,
  };
}

function readMemberCreateInput(body: unknown): CreateOrganizationMemberInput {
  return {
    email: readTrimmedString((body as { email?: unknown } | null)?.email) ?? "",
    role: readOrganizationRoleInput((body as { role?: unknown; orgRole?: unknown } | null)?.role ?? (body as { orgRole?: unknown } | null)?.orgRole, "member"),
  };
}

function readMemberUpdateInput(body: unknown): UpdateOrganizationMemberInput {
  const role = parseOrganizationRoleInput((body as { role?: unknown; orgRole?: unknown } | null)?.role ?? (body as { orgRole?: unknown } | null)?.orgRole);
  if (!role) {
    throw new HttpError("invalid_role", 400);
  }
  return { role };
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
      res.append(
        "Set-Cookie",
        serializeAdminCookie(req, ADMIN_AUTH_COOKIE_NAME, payload.token, ADMIN_AUTH_COOKIE_MAX_AGE_SECONDS),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "auth_exchange_failed" });
    }
  });

  router.post("/admin/api/auth/sign-out", (req, res) => {
    res.append("Set-Cookie", serializeAdminCookieClear(req, ADMIN_AUTH_COOKIE_NAME));
    res.status(204).end();
  });

  router.use("/admin/api", async (req, res, next) => {
    if (req.path.startsWith("/auth/browser/")) {
      next();
      return;
    }

    const token = readAdminAuthToken(req);
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

  router.get("/admin/api/organizations", async (req, res) => {
    if (!requireAdminCapability(res, "organization")) {
      return;
    }

    try {
      const payload = await adminService.listOrganizations(res.locals.adminToken as string);
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_list_failed" });
    }
  });

  router.get("/admin/api/organizations/:orgId", async (req, res) => {
    if (!requireAdminCapability(res, "organization")) {
      return;
    }

    try {
      const payload = await adminService.getOrganization(res.locals.adminToken as string, req.params.orgId);
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_lookup_failed" });
    }
  });

  router.patch("/admin/api/organizations/:orgId", async (req, res) => {
    if (!requireAdminCapability(res, "organization")) {
      return;
    }

    try {
      const payload = await adminService.updateOrganization(
        res.locals.adminToken as string,
        req.params.orgId,
        readOrganizationUpdateInput(req.body),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_update_failed" });
    }
  });

  router.get("/admin/api/organizations/:orgId/members", async (req, res) => {
    if (!requireAdminCapability(res, "organization")) {
      return;
    }

    try {
      const payload = await adminService.listOrganizationMembers(res.locals.adminToken as string, req.params.orgId);
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_member_list_failed" });
    }
  });

  router.post("/admin/api/organizations/:orgId/members", async (req, res) => {
    if (!requireAdminCapability(res, "organization")) {
      return;
    }

    try {
      const payload = await adminService.createOrganizationMember(
        res.locals.adminToken as string,
        req.params.orgId,
        readMemberCreateInput(req.body),
      );
      res.status(201).json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_member_create_failed" });
    }
  });

  router.patch("/admin/api/organizations/:orgId/members/:memberId", async (req, res) => {
    if (!requireAdminCapability(res, "organization")) {
      return;
    }

    try {
      const payload = await adminService.updateOrganizationMember(
        res.locals.adminToken as string,
        req.params.orgId,
        req.params.memberId,
        readMemberUpdateInput(req.body),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_member_update_failed" });
    }
  });

  router.delete("/admin/api/organizations/:orgId/members/:memberId", async (req, res) => {
    if (!requireAdminCapability(res, "organization")) {
      return;
    }

    try {
      await adminService.deleteOrganizationMember(
        res.locals.adminToken as string,
        req.params.orgId,
        req.params.memberId,
      );
      res.status(204).end();
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_member_delete_failed" });
    }
  });

  router.get("/admin/api/organizations/:orgId/domains", async (req, res) => {
    if (!requireAdminCapability(res, "organization")) {
      return;
    }

    try {
      const payload = await adminService.listOrganizationDomains(res.locals.adminToken as string, req.params.orgId);
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_domain_list_failed" });
    }
  });

  router.post("/admin/api/organizations/:orgId/domains", async (req, res) => {
    if (!requireAdminCapability(res, "organization")) {
      return;
    }

    try {
      const payload = await adminService.createOrganizationDomain(
        res.locals.adminToken as string,
        req.params.orgId,
        readDomainCreateInput(req.body),
      );
      res.status(201).json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_domain_create_failed" });
    }
  });

  router.patch("/admin/api/organizations/:orgId/domains/:domainId", async (req, res) => {
    if (!requireAdminCapability(res, "organization")) {
      return;
    }

    try {
      const payload = await adminService.updateOrganizationDomain(
        res.locals.adminToken as string,
        req.params.orgId,
        req.params.domainId,
        readDomainUpdateInput(req.body),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_domain_update_failed" });
    }
  });

  router.delete("/admin/api/organizations/:orgId/domains/:domainId", async (req, res) => {
    if (!requireAdminCapability(res, "organization")) {
      return;
    }

    try {
      await adminService.deleteOrganizationDomain(
        res.locals.adminToken as string,
        req.params.orgId,
        req.params.domainId,
      );
      res.status(204).end();
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_domain_delete_failed" });
    }
  });

  router.get("/admin/api/organizations/:orgId/invites", async (req, res) => {
    if (!requireAdminCapability(res, "organization")) {
      return;
    }

    try {
      const payload = await adminService.listOrganizationInvites(res.locals.adminToken as string, req.params.orgId);
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_invite_list_failed" });
    }
  });

  router.post("/admin/api/organizations/:orgId/invites", async (req, res) => {
    if (!requireAdminCapability(res, "organization")) {
      return;
    }

    try {
      const payload = await adminService.createOrganizationInvite(
        res.locals.adminToken as string,
        req.params.orgId,
        readInviteCreateInput(req.body),
      );
      res.status(201).json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_invite_create_failed" });
    }
  });

  router.post("/admin/api/organizations/:orgId/invites/:inviteId/revoke", async (req, res) => {
    if (!requireAdminCapability(res, "organization")) {
      return;
    }

    try {
      const payload = await adminService.revokeOrganizationInvite(
        res.locals.adminToken as string,
        req.params.orgId,
        req.params.inviteId,
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_invite_revoke_failed" });
    }
  });

  router.get("/admin/api/credentials", async (req, res) => {
    if (!requireAdminCapability(res, "credentials")) {
      return;
    }

    try {
      const includeDeleted = req.query.includeDeleted === "true" || req.query.includeDeleted === "1";
      const payload = await adminService.listCredentials(res.locals.adminToken as string, { includeDeleted });
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "credential_list_failed" });
    }
  });

  router.get("/admin/api/credentials/:credentialId/models", async (req, res) => {
    if (!requireAdminCapability(res, "credentials")) {
      return;
    }

    try {
      const payload = await adminService.listCredentialModels(
        res.locals.adminToken as string,
        req.params.credentialId,
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "credential_model_list_failed" });
    }
  });

  router.post("/admin/api/credentials", async (req, res) => {
    if (!requireAdminCapability(res, "credentials")) {
      return;
    }

    try {
      const payload = await adminService.createCredential(
        res.locals.adminToken as string,
        {
          provider: parseCredentialProvider(req.body?.provider),
          name: typeof req.body?.name === "string" ? req.body.name.trim() : "",
          secret: typeof req.body?.secret === "string" ? req.body.secret.trim() : "",
          baseUrl: typeof req.body?.baseUrl === "string" ? req.body.baseUrl.trim() : null,
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

  router.delete("/admin/api/credentials/:credentialId", async (req, res) => {
    if (!requireAdminCapability(res, "credentials")) {
      return;
    }

    try {
      const payload = await adminService.deleteCredential(
        res.locals.adminToken as string,
        req.params.credentialId,
        getAdminActorUserId(res),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "credential_delete_failed" });
    }
  });

  router.post("/admin/api/credentials/:credentialId/revoke", async (req, res) => {
    if (!requireAdminCapability(res, "credentials")) {
      return;
    }

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
    if (!requireAdminCapability(res, "credentials")) {
      return;
    }

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
    if (!requireAdminCapability(res, "credentials")) {
      return;
    }

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
    if (!requireAdminCapability(res, "sessions")) {
      return;
    }

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
    if (!requireAdminCapability(res, "usage")) {
      return;
    }

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
    if (!requireAdminCapability(res, "alerts")) {
      return;
    }

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
    if (!requireAdminCapability(res, "alerts")) {
      return;
    }

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
    if (!requireAdminCapability(res, "alerts")) {
      return;
    }

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
    if (!requireAdminCapability(res, "audit")) {
      return;
    }

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
        orgRole: readOrganizationRoleInput(req.body?.orgRole, "member"),
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
    const session = res.locals.adminSession as AdminSessionSnapshot | undefined;
    if (session?.platformAdmin !== true && (hasOwn(req.body, "name") || hasOwn(req.body, "platformAdmin"))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    try {
      const input: UpdateUserInput = {};
      if (hasOwn(req.body, "name")) {
        input.name = typeof req.body?.name === "string" ? req.body.name.trim() : undefined;
      }
      if (hasOwn(req.body, "platformAdmin")) {
        input.platformAdmin = typeof req.body?.platformAdmin === "boolean" ? req.body.platformAdmin : undefined;
      }
      if (hasOwn(req.body, "orgId")) {
        input.orgId = typeof req.body?.orgId === "string" && req.body.orgId.trim() ? req.body.orgId.trim() : null;
      }
      if (hasOwn(req.body, "orgRole")) {
        const role = parseOrganizationRoleInput(req.body?.orgRole);
        if (!role) {
          throw new HttpError("invalid_role", 400);
        }
        input.orgRole = role;
      }

      const user = await adminService.updateUser(res.locals.adminToken as string, req.params.userId, input);
      res.json({ user });
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "user_update_failed" });
    }
  });

  router.get("/admin/api/users/:userId/ai-access", async (req, res) => {
    if (!requireAdminCapability(res, "managedAiUserAccess")) {
      return;
    }

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
    if (!requireAdminCapability(res, "managedAiUserAccess")) {
      return;
    }

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

  const sendAdminShell = (_req: express.Request, res: express.Response) => {
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
      return;
    }
    res.type("html").send(adminShellHtml());
  };

  const redirectToAdminLogin = async (req: express.Request, res: express.Response) => {
    const state = randomBase64Url();
    const codeVerifier = randomBase64Url();
    const codeChallenge = createPkceS256Challenge(codeVerifier);
    const payload = await adminService.startBrowserAuth({
      intent: "signin",
      redirectUri: adminRedirectUri(req),
      state,
      codeChallenge,
    });
    const pending: PendingAdminBrowserAuth = {
      sessionId: payload.sessionId,
      state,
      codeVerifier,
      returnTo: safeAdminReturnPath(req),
      createdAt: new Date().toISOString(),
    };
    res.append(
      "Set-Cookie",
      serializeAdminCookie(
        req,
        ADMIN_PENDING_AUTH_COOKIE_NAME,
        encodePendingAdminBrowserAuth(pending),
        ADMIN_PENDING_AUTH_COOKIE_MAX_AGE_SECONDS,
      ),
    );
    res.redirect(302, withAuthView(payload.authorizeUrl));
  };

  const completeAdminBrowserAuthCallback = async (
    req: express.Request,
    res: express.Response,
    callback: { code: string; sessionId: string },
  ) => {
    const pending = decodePendingAdminBrowserAuth(readCookie(req, ADMIN_PENDING_AUTH_COOKIE_NAME));
    if (!pending || (callback.sessionId && pending.sessionId !== callback.sessionId)) {
      res.append("Set-Cookie", serializeAdminCookieClear(req, ADMIN_PENDING_AUTH_COOKIE_NAME));
      await redirectToAdminLogin(req, res);
      return;
    }

    try {
      const payload = await adminService.exchangeBrowserAuth({
        code: callback.code,
        sessionId: callback.sessionId || pending.sessionId,
        state: pending.state,
        codeVerifier: pending.codeVerifier,
      });
      res.append(
        "Set-Cookie",
        serializeAdminCookie(req, ADMIN_AUTH_COOKIE_NAME, payload.token, ADMIN_AUTH_COOKIE_MAX_AGE_SECONDS),
      );
      res.append("Set-Cookie", serializeAdminCookieClear(req, ADMIN_PENDING_AUTH_COOKIE_NAME));
      res.redirect(302, pending.returnTo || "/admin");
    } catch (error) {
      res.append("Set-Cookie", serializeAdminCookieClear(req, ADMIN_PENDING_AUTH_COOKIE_NAME));
      if (errorStatus(error) === 403) {
        res.status(403).type("text").send("You do not have admin access.");
        return;
      }
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).type("text").send("Unable to complete admin sign in.");
    }
  };

  const sendProtectedAdminShell = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const callback = readAdminAuthCallback(req);
      if (callback) {
        await completeAdminBrowserAuthCallback(req, res, callback);
        return;
      }

      const token = readAdminAuthToken(req);
      if (!token) {
        await redirectToAdminLogin(req, res);
        return;
      }

      try {
        res.locals.adminToken = token;
        const session = await adminService.getSession(token);
        res.locals.adminSession = session;
        const requestedPage = pageFromAdminPath(req.path);
        const allowedPages = adminSessionAllowedPages(session);
        if (
          (requestedPage === "overview" && !session.platformAdmin) ||
          (requestedPage !== "overview" && !allowedPages.includes(requestedPage))
        ) {
          res.redirect(302, `/admin/${firstAllowedAdminPage(session)}`);
          return;
        }
        sendAdminShell(req, res);
      } catch (error) {
        res.append("Set-Cookie", serializeAdminCookieClear(req, ADMIN_AUTH_COOKIE_NAME));
        const status = errorStatus(error);
        if (status === 401) {
          await redirectToAdminLogin(req, res);
          return;
        }
        if (status === 403) {
          res.status(403).type("text").send("You do not have admin access.");
          return;
        }
        throw error;
      }
    } catch (error) {
      next(error);
    }
  };

  router.get("/admin", sendProtectedAdminShell);
  router.get("/admin/", sendProtectedAdminShell);
  router.get("/admin/*", (req, res, next) => {
    if (req.path.startsWith("/admin/api/")) {
      next();
      return;
    }
    if (adminAssetRequest(req.path)) {
      next();
      return;
    }
    void sendProtectedAdminShell(req, res, next);
  });

  router.use("/admin", express.static(publicDir, { index: false }));

  return router;
}

function parseCredentialProvider(value: unknown): LeaseProvider | null {
  return isAiGatewayProvider(value) ? value : null;
}
