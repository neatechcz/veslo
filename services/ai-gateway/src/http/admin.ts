import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import express, { Router } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAutoAssignedCodexCredentialRotationService, type AutoAssignedCodexCredentialRotationService } from "../access/auto-assignment-rotation.js";
import type { AlertRecord, AlertRepository } from "../alerts/repository.js";
import { buildCodexCapacityAlerts } from "../alerts/codex-capacity-alerts.js";
import {
  createCodexCapacityAlertMonitorRunner,
  type CodexCapacityAlertMonitorResult,
} from "../alerts/codex-capacity-monitor.js";
import {
  createCredentialAlertEmailMonitorRunner,
  type CredentialAlertEmailMonitorResult,
} from "../alerts/credential-alert-email-monitor.js";
import { AiAccessAuditPersistenceError } from "../access/mysql-repository.js";
import type { AiAccessMutation, AiAccessProvider, AiAccessRepository, UpsertUserAiAccessPolicyInput, UserAiAccessPolicyRecord } from "../access/repository.js";
import { mergeOrganizationAuditEvents } from "../audit/organization-audit.js";
import type { AuditRepository, AuditEventRecord, ListAuditEventsInput } from "../audit/repository.js";
import { getPlatformCredentialOwnerUserId } from "../credentials/platform-owner.js";
import type { AdminCredentialRecord, CreatePlatformCredentialInput, CredentialRecord as GatewayCredentialRecord, CredentialRepository } from "../credentials/repository.js";
import type { SecretStore, StoredSecret } from "../credentials/secret-store.js";
import type { AiGatewayDb } from "../db/index.js";
import { credentialBindingTable, credentialHealthEventTable, credentialRecordTable, credentialUsageEventTable, sessionLeaseTable, userAiAccessPolicyTable, type CredentialState } from "../db/schema.js";
import { sendAdminAlertEmail, type AdminAlertEmailInput } from "../email/admin-alert-mailer.js";
import { env } from "../env.js";
import type { AdminSessionRecord, LeaseProvider } from "../leases/repository.js";
import { PlatformModelPolicyAuditPersistenceError } from "../model-policy/mysql-repository.js";
import {
  filterUnsupportedCodexModels,
  normalizeDiscoveredModels,
  type PlatformModelCapabilityVerifier,
} from "../model-policy/capability-verifier.js";
import type {
  PlatformModelPolicyRecord,
  PlatformModelPolicyMutation,
  PlatformModelPolicyRepository,
  PlatformModelRef,
} from "../model-policy/repository.js";
import { CODEX_DEFAULT_MODEL, listCodexModelCatalog } from "../providers/codex-model-catalog.js";
import { formatAiGatewayProviderLabel, isAiGatewayProvider } from "../providers/ids.js";
import { OpenAiCompatibleTransport } from "../providers/openai-compatible-transport.js";
import { ProviderTransportError, type OpenAiCompatibleProviderTransport } from "../providers/transport.js";
import { evaluateCodexCredentialEligibility } from "../usage/codex-eligibility.js";
import { buildCodexCapacityOverview, type CodexCapacityCredential, type CodexCapacityOverview } from "../usage/codex-capacity.js";
import { CachedCodexCredentialStatusProvider, UnavailableCodexCredentialStatusProvider, type CodexCredentialStatusProvider, type CodexUsageStatus } from "../usage/codex-status.js";
import type { AggregateUsageInput, UsageAggregateResponse, UsageCredentialAggregate, UsageGroupBy as RepositoryUsageGroupBy, UsageRepository } from "../usage/repository.js";

export const OrganizationAdminCapabilities = ["organization", "users"] as const;
export const PlatformAdminCapabilities = [
  ...OrganizationAdminCapabilities,
  "credentials",
  "usage",
  "alerts",
  "audit",
  "debugLogs",
  "managedAiUserAccess",
] as const;
export const OrganizationAdminAllowedPages = ["organization", "users"] as const;
export const PlatformAdminAllowedPages = [
  ...OrganizationAdminAllowedPages,
  "credentials",
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
  status: "active" | "disabled" | "removed";
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
  capacity: CodexCapacityOverview;
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

export type OrganizationInviteActionPayload = {
  invite: AdminOrganizationInviteRecord;
  inviteToken?: string;
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

export type ReconnectCredentialInput = {
  secret: string;
};

export type RenameCredentialInput = {
  name: string;
};

export type CreateCodexAuthUploadSessionInput = {
  origin: string;
};

export type CodexAuthUploadInput = {
  authJson: string;
};

export type CodexAuthUploadSessionResponse = {
  upload: {
    token: string;
    credentialId: string | null;
    credentialName: string;
    uploadUrl: string;
    expiresAt: string;
  };
  command: string;
};

export type CodexAuthUploadResponse = {
  ok: true;
  credentialId: string;
  credentialName: string;
  accountId: string;
};

export type ListCredentialsInput = {
  includeDeleted?: boolean;
};

export type AdminPlatformModelPolicy = {
  enabledModels: PlatformModelRef[];
  activeModel: PlatformModelRef;
  updatedAt: string;
};

export type ReplacePlatformModelPolicyInput = {
  enabledModels: PlatformModelRef[];
  activeModel: PlatformModelRef;
};

export type AdminDenProxyResponse = {
  status: number;
  body: unknown;
};

const ORGANIZATION_AUDIT_SOURCE_LIMIT = 100;

function readOrganizationAuditLimit(value: unknown): number {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = typeof candidate === "string" && /^\d+$/.test(candidate)
    ? Number(candidate)
    : ORGANIZATION_AUDIT_SOURCE_LIMIT;
  return Math.min(ORGANIZATION_AUDIT_SOURCE_LIMIT, Math.max(1, parsed));
}

function readDenOrganizationAuditEvents(body: unknown): AuditEventRecord[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { events?: unknown }).events)) {
    throw new HttpError("organization_audit_den_response_invalid", 502);
  }

  return (body as { events: unknown[] }).events.map((value) => {
    if (!value || typeof value !== "object") {
      throw new HttpError("organization_audit_den_response_invalid", 502);
    }
    const event = value as Record<string, unknown>;
    const result = event.result;
    if (
      !["id", "timestamp", "actor", "action", "entityType", "entityId", "summary"].every(
        (field) => typeof event[field] === "string",
      )
      || (result !== "ok" && result !== "warning" && result !== "error")
      || !Array.isArray(event.changedFields)
      || !event.changedFields.every((field) => typeof field === "string")
    ) {
      throw new HttpError("organization_audit_den_response_invalid", 502);
    }
    return {
      id: event.id as string,
      timestamp: event.timestamp as string,
      actor: event.actor as string,
      action: event.action as string,
      entityType: event.entityType as string,
      entityId: event.entityId as string,
      result,
      summary: event.summary as string,
      changedFields: event.changedFields as string[],
      ...(typeof event.organizationId === "string" || event.organizationId === null
        ? { organizationId: event.organizationId }
        : {}),
    };
  });
}

export type AdminOrganizationBillingInput = Record<string, unknown>;

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
  getOrganizationBilling?(token: string, orgId: string): Promise<AdminDenProxyResponse>;
  createOrganizationBillingCheckout?(token: string, orgId: string, input: AdminOrganizationBillingInput): Promise<AdminDenProxyResponse>;
  createOrganizationBillingPortal?(token: string, orgId: string, input: AdminOrganizationBillingInput): Promise<AdminDenProxyResponse>;
  updateOrganizationBillingPlan?(token: string, orgId: string, input: AdminOrganizationBillingInput): Promise<AdminDenProxyResponse>;
  cancelOrganizationBilling?(token: string, orgId: string, input: AdminOrganizationBillingInput): Promise<AdminDenProxyResponse>;
  updatePlatformOrganizationBilling?(token: string, orgId: string, input: AdminOrganizationBillingInput): Promise<AdminDenProxyResponse>;
  listOrganizationMembers(token: string, orgId: string): Promise<{ members: AdminOrganizationMemberRecord[] }>;
  createOrganizationMember(token: string, orgId: string, input: CreateOrganizationMemberInput): Promise<{ member: AdminOrganizationMemberRecord }>;
  updateOrganizationMember(token: string, orgId: string, memberId: string, input: UpdateOrganizationMemberInput): Promise<{ member: AdminOrganizationMemberRecord }>;
  deleteOrganizationMember(token: string, orgId: string, memberId: string): Promise<void>;
  listOrganizationDomains(token: string, orgId: string): Promise<{ domains: AdminOrganizationDomainRecord[] }>;
  createOrganizationDomain(token: string, orgId: string, input: CreateOrganizationDomainInput): Promise<{ domain: AdminOrganizationDomainRecord }>;
  updateOrganizationDomain(token: string, orgId: string, domainId: string, input: UpdateOrganizationDomainInput): Promise<{ domain: AdminOrganizationDomainRecord }>;
  deleteOrganizationDomain(token: string, orgId: string, domainId: string): Promise<void>;
  listOrganizationInvites(token: string, orgId: string): Promise<{ invites: AdminOrganizationInviteRecord[] }>;
  createOrganizationInvite(token: string, orgId: string, input: CreateOrganizationInviteInput): Promise<OrganizationInviteActionPayload>;
  resendOrganizationInvite(token: string, orgId: string, inviteId: string): Promise<OrganizationInviteActionPayload>;
  revokeOrganizationInvite(token: string, orgId: string, inviteId: string): Promise<{ invite: AdminOrganizationInviteRecord }>;
  getUserAiAccess(
    token: string,
    userId: string,
  ): Promise<{ aiAccess: AdminUserAiAccessRecord | null; availableCredentials: AdminCredentialOption[] }>;
  upsertUserAiAccess(
    token: string,
    userId: string,
    input: UpdateUserAiAccessInput,
    organizationId: string | null | undefined,
    actorUserId: string,
  ): Promise<{ aiAccess: AdminUserAiAccessRecord; availableCredentials: AdminCredentialOption[] }>;
  disableUser(token: string, userId: string): Promise<AdminUserRecord>;
  enableUser(token: string, userId: string): Promise<AdminUserRecord>;
  deleteUser(token: string, userId: string): Promise<void>;
  listCredentials(_token: string, input?: ListCredentialsInput): Promise<{ credentials: CredentialRecord[] }>;
  listCredentialModels(_token: string, credentialId: string): Promise<{ credentialId: string; models: string[]; defaultModel?: string }>;
  getPlatformModelPolicy(token: string): Promise<{ policy: AdminPlatformModelPolicy | null }>;
  replacePlatformModelPolicy(token: string, input: ReplacePlatformModelPolicyInput, actorUserId: string): Promise<{ policy: AdminPlatformModelPolicy }>;
  createCredential(_token: string, input: CreateCredentialInput, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
  renameCredential(_token: string, credentialId: string, input: RenameCredentialInput, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
  createCodexAuthUploadSession(_token: string, credentialId: string, input: CreateCodexAuthUploadSessionInput, actorUserId: string | null): Promise<CodexAuthUploadSessionResponse>;
  createCodexAuthCredentialUploadSession(_token: string, input: CreateCodexAuthUploadSessionInput, actorUserId: string | null): Promise<CodexAuthUploadSessionResponse>;
  uploadCodexAuth(token: string, input: CodexAuthUploadInput): Promise<CodexAuthUploadResponse>;
  revokeCredential(_token: string, credentialId: string, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
  drainCredential(_token: string, credentialId: string, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
  rotateCredential(_token: string, credentialId: string, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
  reconnectCredential(_token: string, credentialId: string, input: ReconnectCredentialInput, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
  deleteCredential(_token: string, credentialId: string, actorUserId: string | null): Promise<{ credential: CredentialRecord }>;
  listSessions(_token: string): Promise<{ sessions: SessionRecord[] }>;
  getUsage(_token: string, input: { groupBy: UsageGroupBy; credentialId: string | null; userId: string | null; orgId: string | null }): Promise<UsageResponse>;
  listAlerts(_token: string): Promise<{ alerts: AlertRecord[] }>;
  runCodexCapacityAlertEmailMonitor?(): Promise<CodexCapacityAlertMonitorResult>;
  runCredentialAlertEmailMonitor?(): Promise<CredentialAlertEmailMonitorResult>;
  acknowledgeAlert(_token: string, alertId: string, actorUserId: string | null): Promise<{ alert: AlertRecord }>;
  resolveAlert(_token: string, alertId: string, actorUserId: string | null): Promise<{ alert: AlertRecord }>;
  listAudit(_token: string): Promise<{ events: AuditRecord[] }>;
  listOrganizationAudit?(_token: string, orgId: string, limit?: number): Promise<AdminDenProxyResponse>;
  runCodexCapacityAlertEmailMonitor?(): Promise<CodexCapacityAlertMonitorResult>;
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function requireAdminDependency<T>(value: T | null | undefined, name: string): T {
  if (value == null) {
    throw new HttpError(`admin_dependency_unavailable:${name}`, 503);
  }
  return value;
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
  listOrganizationAudit(token: string, orgId: string, limit: number): Promise<AdminDenProxyResponse>;
  getOrganizationBilling(token: string, orgId: string): Promise<AdminDenProxyResponse>;
  createOrganizationBillingCheckout(token: string, orgId: string, input: AdminOrganizationBillingInput): Promise<AdminDenProxyResponse>;
  createOrganizationBillingPortal(token: string, orgId: string, input: AdminOrganizationBillingInput): Promise<AdminDenProxyResponse>;
  updateOrganizationBillingPlan(token: string, orgId: string, input: AdminOrganizationBillingInput): Promise<AdminDenProxyResponse>;
  cancelOrganizationBilling(token: string, orgId: string, input: AdminOrganizationBillingInput): Promise<AdminDenProxyResponse>;
  updatePlatformOrganizationBilling(token: string, orgId: string, input: AdminOrganizationBillingInput): Promise<AdminDenProxyResponse>;
  listOrganizationMembers(token: string, orgId: string): Promise<{ members: AdminOrganizationMemberRecord[] }>;
  createOrganizationMember(token: string, orgId: string, input: CreateOrganizationMemberInput): Promise<{ member: AdminOrganizationMemberRecord }>;
  updateOrganizationMember(token: string, orgId: string, memberId: string, input: UpdateOrganizationMemberInput): Promise<{ member: AdminOrganizationMemberRecord }>;
  deleteOrganizationMember(token: string, orgId: string, memberId: string): Promise<void>;
  listOrganizationDomains(token: string, orgId: string): Promise<{ domains: AdminOrganizationDomainRecord[] }>;
  createOrganizationDomain(token: string, orgId: string, input: CreateOrganizationDomainInput): Promise<{ domain: AdminOrganizationDomainRecord }>;
  updateOrganizationDomain(token: string, orgId: string, domainId: string, input: UpdateOrganizationDomainInput): Promise<{ domain: AdminOrganizationDomainRecord }>;
  deleteOrganizationDomain(token: string, orgId: string, domainId: string): Promise<void>;
  listOrganizationInvites(token: string, orgId: string): Promise<{ invites: AdminOrganizationInviteRecord[] }>;
  createOrganizationInvite(token: string, orgId: string, input: CreateOrganizationInviteInput): Promise<OrganizationInviteActionPayload>;
  resendOrganizationInvite(token: string, orgId: string, inviteId: string): Promise<OrganizationInviteActionPayload>;
  revokeOrganizationInvite(token: string, orgId: string, inviteId: string): Promise<{ invite: AdminOrganizationInviteRecord }>;
  disableUser(token: string, userId: string): Promise<AdminUserRecord>;
  enableUser(token: string, userId: string): Promise<AdminUserRecord>;
  deleteUser(token: string, userId: string): Promise<void>;
  listPlatformAdminRecipients?(token: string | null): Promise<Array<{ userId: string; email: string; name: string | null }>>;
};

const ADMIN_AUTH_COOKIE_NAME = "veslo.ai-gateway.admin.token";
const ADMIN_PENDING_AUTH_COOKIE_NAME = "veslo.ai-gateway.admin.browser-auth";
const ADMIN_AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const ADMIN_PENDING_AUTH_COOKIE_MAX_AGE_SECONDS = 10 * 60;
const ADMIN_AUTH_RANDOM_BYTES = 32;
const CODEX_AUTH_UPLOAD_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CODEX_CAPACITY_ALERT_READ_TIMEOUT_MS = 2500;

type CodexAuthUploadSessionRecord = {
  token: string;
  mode: "replace" | "create";
  credentialId: string | null;
  credentialName: string;
  actorUserId: string | null;
  expiresAt: Date;
};

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
  renameCredential(input: { credentialId: string; name: string }): Promise<boolean>;
  revokeCredential(credentialId: string): Promise<boolean>;
  drainCredential(credentialId: string): Promise<boolean>;
  rotateCredential(credentialId: string): Promise<boolean>;
  reconnectCredential(credentialId: string): Promise<boolean>;
  quarantineCredential(credentialId: string, reason: string): Promise<boolean>;
  deleteCredential(input: { credentialId: string; allowHealthyUnavailable?: boolean }): Promise<DeleteCredentialResult>;
};

type AdminCredentialWriteRepository = {
  createPlatformCredential(input: CreatePlatformCredentialInput): Promise<GatewayCredentialRecord>;
};

type CredentialSecretLookupRepository = {
  getCredentialRecordById(
    credentialId: string,
  ): Promise<(Pick<GatewayCredentialRecord, "provider" | "secretRef"> & { name?: string | null }) | null>;
};

export type AdminServiceDependencies = {
  denClient?: DenAdminApi;
  credentialReadRepository?: AdminCredentialReadRepository;
  credentialActionRepository?: AdminCredentialActionRepository;
  credentialWriteRepository?: AdminCredentialWriteRepository;
  credentialSecretLookupRepository?: CredentialSecretLookupRepository;
  credentialRotationService?: AutoAssignedCodexCredentialRotationService;
  sessionReadRepository?: AdminSessionReadRepository;
  aiAccessRepository?: AiAccessRepository;
  aiAccessMutation?: AiAccessMutation;
  alertRepository?: AlertRepository;
  usageRepository?: UsageRepository;
  codexStatusProvider?: CodexCredentialStatusProvider;
  auditRepository?: AuditRepository;
  secretStore?: SecretStore;
  openAiCompatibleTransport?: OpenAiCompatibleProviderTransport;
  modelPolicyRepository?: PlatformModelPolicyRepository;
  modelPolicyMutation?: PlatformModelPolicyMutation;
  modelCapabilities?: PlatformModelCapabilityVerifier;
  alertEmailRecipients?: string[];
  sendAlertEmail?: (input: AdminAlertEmailInput) => Promise<void>;
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

export class MySqlAdminSessionReadRepository implements AdminSessionReadRepository {
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

  async renameCredential(input: { credentialId: string; name: string }): Promise<boolean> {
    const credential = await this.getCredential(input.credentialId);
    if (!credential || credential.deleted_at) {
      return false;
    }

    await this.db
      .update(credentialRecordTable)
      .set({
        name: input.name,
        updated_at: new Date(),
      })
      .where(eq(credentialRecordTable.id, input.credentialId));

    return true;
  }

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

  async reconnectCredential(credentialId: string): Promise<boolean> {
    return this.transitionCredentialState(credentialId, "healthy", "admin_reconnect");
  }

  async quarantineCredential(credentialId: string, reason: string): Promise<boolean> {
    return this.transitionCredentialState(credentialId, "unhealthy", reason || "credential_quarantined");
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

function isCodexRefreshTokenReuseStatus(upstreamStatus: CodexUsageStatus | null): boolean {
  const statusText = [upstreamStatus?.label, upstreamStatus?.detail].filter(Boolean).join(" | ");
  return /refresh token was already used|access token could not be refreshed/i.test(statusText);
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

  private async proxyAdminJson(pathname: string, token: string, init: RequestInit = {}): Promise<AdminDenProxyResponse> {
    const response = await fetch(`${this.denApiBase}${pathname}`, {
      ...init,
      headers: {
        ...this.adminHeaders(token, init.body !== undefined),
        ...(init.headers ?? {}),
      },
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
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

  async listOrganizationAudit(token: string, orgId: string, limit: number) {
    return this.proxyAdminJson(
      `/v1/admin/organizations/${encodeURIComponent(orgId)}/audit?limit=${encodeURIComponent(String(limit))}`,
      token,
    );
  }

  async getOrganizationBilling(token: string, orgId: string) {
    return this.proxyAdminJson(`/v1/admin/organizations/${encodeURIComponent(orgId)}/billing`, token);
  }

  async createOrganizationBillingCheckout(token: string, orgId: string, input: AdminOrganizationBillingInput) {
    return this.proxyAdminJson(`/v1/admin/organizations/${encodeURIComponent(orgId)}/billing/checkout`, token, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async createOrganizationBillingPortal(token: string, orgId: string, input: AdminOrganizationBillingInput) {
    return this.proxyAdminJson(`/v1/admin/organizations/${encodeURIComponent(orgId)}/billing/portal`, token, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateOrganizationBillingPlan(token: string, orgId: string, input: AdminOrganizationBillingInput) {
    return this.proxyAdminJson(`/v1/admin/organizations/${encodeURIComponent(orgId)}/billing/plan`, token, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async cancelOrganizationBilling(token: string, orgId: string, input: AdminOrganizationBillingInput) {
    return this.proxyAdminJson(`/v1/admin/organizations/${encodeURIComponent(orgId)}/billing/cancel`, token, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updatePlatformOrganizationBilling(token: string, orgId: string, input: AdminOrganizationBillingInput) {
    return this.proxyAdminJson(`/v1/admin/organizations/${encodeURIComponent(orgId)}/billing/platform`, token, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
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
    }) as Promise<OrganizationInviteActionPayload>;
  }

  async resendOrganizationInvite(token: string, orgId: string, inviteId: string) {
    return this.requestJson(
      `/v1/admin/organizations/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}/resend`,
      {
        method: "POST",
        headers: this.adminHeaders(token),
      },
    ) as Promise<OrganizationInviteActionPayload>;
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
}

export function createDefaultAdminService(
  denApiBase: string,
  deps: AdminServiceDependencies = {},
): AdminService {
  const denClient = deps.denClient ?? new DenAdminClient(denApiBase);
  const getCredentialReadRepository = () =>
    requireAdminDependency(deps.credentialReadRepository, "credential_read_repository");
  const getCredentialActionRepository = () =>
    requireAdminDependency(deps.credentialActionRepository, "credential_action_repository");
  const getCredentialWriteRepository = () =>
    requireAdminDependency(deps.credentialWriteRepository, "credential_write_repository");
  const getCredentialSecretLookupRepository = () =>
    requireAdminDependency(deps.credentialSecretLookupRepository, "credential_secret_lookup_repository");
  const getSessionReadRepository = () =>
    requireAdminDependency(deps.sessionReadRepository, "session_read_repository");
  const getAiAccessRepository = () =>
    requireAdminDependency(deps.aiAccessRepository, "ai_access_repository");
  const getAiAccessMutation = () =>
    requireAdminDependency(deps.aiAccessMutation, "ai_access_mutation");
  const getAlertRepository = () =>
    requireAdminDependency(deps.alertRepository, "alert_repository");
  const getUsageRepository = () =>
    requireAdminDependency(deps.usageRepository, "usage_repository");
  const getAuditRepository = () =>
    requireAdminDependency(deps.auditRepository, "audit_repository");
  const getModelPolicyRepository = () => {
    if (!deps.modelPolicyRepository) {
      throw new HttpError("model_policy_store_unavailable", 503);
    }
    return deps.modelPolicyRepository;
  };
  const getModelPolicyMutation = () => {
    if (!deps.modelPolicyMutation) {
      throw new HttpError("model_policy_store_unavailable", 503);
    }
    return deps.modelPolicyMutation;
  };
  const getModelCapabilities = () =>
    requireAdminDependency(deps.modelCapabilities, "model_capabilities");
  const getSecretStore = () =>
    requireAdminDependency(deps.secretStore, "secret_store");
  const openAiCompatibleTransport = deps.openAiCompatibleTransport ?? new OpenAiCompatibleTransport();
  const alertEmailRecipients = deps.alertEmailRecipients ?? env.alertEmail.recipients;
  const sendAlertEmail = deps.sendAlertEmail ?? sendAdminAlertEmail;
  const now = deps.now ?? (() => new Date());
  const codexStatusProvider =
    deps.codexStatusProvider ??
    (deps.credentialSecretLookupRepository && deps.secretStore
      ? new CachedCodexCredentialStatusProvider({
          loadCredentialAuthJson: async (credentialId) => {
            const credential = await deps.credentialSecretLookupRepository!.getCredentialRecordById(credentialId);
            if (!credential) {
              return null;
            }

            const secret = await deps.secretStore!.get(credential.secretRef).catch(() => null);
            return secret?.kind === "codex_auth_json" ? secret.authJson : null;
          },
          saveCredentialAuthJson: async (credentialId, authJson) => {
            const credential = await deps.credentialSecretLookupRepository!.getCredentialRecordById(credentialId);
            if (!credential) {
              return;
            }
            await deps.secretStore!.replace(credential.secretRef, {
              kind: "codex_auth_json",
              authJson,
            });
          },
        })
      : new UnavailableCodexCredentialStatusProvider());
  let credentialRotationService: AutoAssignedCodexCredentialRotationService | null =
    deps.credentialRotationService ?? null;
  let codexCapacityAlertEmailRunner: (() => Promise<CodexCapacityAlertMonitorResult>) | null = null;
  let credentialAlertEmailRunner: (() => Promise<CredentialAlertEmailMonitorResult>) | null = null;
  const codexAuthUploadSessions = new Map<string, CodexAuthUploadSessionRecord>();
  type DenOrganizationProxyMethod =
    | "listOrganizations"
    | "getOrganization"
    | "updateOrganization"
    | "listOrganizationAudit"
    | "getOrganizationBilling"
    | "createOrganizationBillingCheckout"
    | "createOrganizationBillingPortal"
    | "updateOrganizationBillingPlan"
    | "cancelOrganizationBilling"
    | "updatePlatformOrganizationBilling"
    | "listOrganizationMembers"
    | "createOrganizationMember"
    | "updateOrganizationMember"
    | "deleteOrganizationMember"
    | "listOrganizationDomains"
    | "createOrganizationDomain"
    | "updateOrganizationDomain"
    | "deleteOrganizationDomain"
    | "listOrganizationInvites"
    | "createOrganizationInvite"
    | "resendOrganizationInvite"
    | "revokeOrganizationInvite";

  function requireDenOrganizationProxy<K extends DenOrganizationProxyMethod>(method: K): DenAdminApi[K] {
    return denClient[method].bind(denClient) as DenAdminApi[K];
  }

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
    activeModel: PlatformModelRef,
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
        activeModel,
        reason: "admin_ai_access_read",
      });
    } catch (error) {
      console.error("admin_codex_assignment_repair_failed", error);
      return aiAccess;
    }
  }

  async function recordAuditEvent(input: {
    actorUserId?: string | null;
    organizationId?: string | null;
    entityType: string;
    entityId: string;
    action: string;
    result: "ok" | "warning" | "error";
    summary: string;
  }) {
    try {
      await getAuditRepository().recordEvent({
        actorUserId: input.actorUserId ?? null,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
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
        const eligibility = readCodexCredentialEligibility(credential, upstreamStatus, now());
        if (credential.state === "healthy" && isCodexRefreshTokenReuseStatus(upstreamStatus)) {
          try {
            const quarantined = await getCredentialActionRepository().quarantineCredential(
              credential.id,
              "codex_refresh_token_reused",
            );
            if (quarantined) {
              await recordAuditEvent({
                actorUserId: "admin-ui",
                action: "credential.quarantine",
                entityType: "credential",
                entityId: credential.id,
                result: "warning",
                summary: `Quarantined Codex credential ${credential.id} after refresh token reuse was detected.`,
              });
              return {
                ...credential,
                state: "unhealthy",
                cachedTokens: readCachedTokens(credential),
                upstreamStatus,
                eligibility,
              };
            }
          } catch (error) {
            console.error("admin_codex_credential_quarantine_failed", {
              credentialId: credential.id,
              error,
            });
          }
        }

        return {
          ...credential,
          cachedTokens: readCachedTokens(credential),
          upstreamStatus,
          eligibility,
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

  async function assessAssignmentCredential(
    credential: CredentialRecord,
    activeModel: PlatformModelRef,
  ): Promise<"eligible" | "ineligible" | "incompatible"> {
    if (credential.state !== "healthy" || credential.provider !== activeModel.provider) {
      return "ineligible";
    }

    if (credential.provider === "codex_oauth") {
      const status = await codexStatusProvider.getStatus({
        credentialId: credential.id,
        credentialName: credential.name,
      });
      if (!evaluateCodexCredentialEligibility(status, now()).eligible) {
        return "ineligible";
      }
    } else if (credential.provider !== "openai_compatible") {
      return "ineligible";
    }

    const capability = await getModelCapabilities().checkCredentialForModel(credential.id, activeModel);
    if (capability.status === "transient") {
      throw new HttpError("ai_access_credential_capability_unavailable", 503);
    }
    return capability.status === "supported" && capability.credentialId === credential.id
      ? "eligible"
      : "incompatible";
  }

  async function listAvailableAssignmentCredentials(activeModel: PlatformModelRef): Promise<AdminCredentialOption[]> {
    const credentials = await getCredentialReadRepository().listAdminCredentials();
    const options: AdminCredentialOption[] = [];

    for (const credential of credentials) {
      if (await assessAssignmentCredential(credential, activeModel) !== "eligible") {
        continue;
      }

      options.push({
        id: credential.id,
        name: credential.name,
        provider: activeModel.provider,
      });
    }

    return options;
  }

  async function assertAssignableCredential(
    provider: AiAccessProvider | null,
    credentialId: string | null,
    activeModel: PlatformModelRef,
  ): Promise<void> {
    if (provider !== "codex_oauth" && provider !== "openai_compatible") {
      return;
    }

    if (!credentialId) {
      throw new HttpError("invalid_ai_access_credential_id", 400);
    }

    const credential = (await getCredentialReadRepository().listAdminCredentials())
      .find((entry) => entry.id === credentialId && entry.provider === provider);
    if (!credential) {
      throw new HttpError(provider === "codex_oauth"
        ? "ineligible_ai_access_credential_id"
        : "invalid_ai_access_credential_id", 400);
    }
    const assessment = await assessAssignmentCredential(credential, activeModel);
    if (assessment === "incompatible") {
      throw new HttpError("incompatible_ai_access_credential_id", 400);
    }
    if (assessment === "ineligible" && provider === "codex_oauth") {
      throw new HttpError("ineligible_ai_access_credential_id", 400);
    }
    if (assessment !== "eligible") {
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

  async function getCodexCredentialSecretRecordOrThrow(credentialId: string): Promise<{
    visible: CredentialRecord;
    stored: Pick<GatewayCredentialRecord, "provider" | "secretRef"> & { name?: string | null };
  }> {
    const visible = await getCredentialOrThrow(credentialId);
    if (visible.provider !== "codex_oauth") {
      throw new HttpError("invalid_codex_auth_credential", 400);
    }

    const stored = await getCredentialSecretLookupRepository().getCredentialRecordById(credentialId);
    if (!stored) {
      throw new HttpError("credential_not_found", 404);
    }
    if (stored.provider !== "codex_oauth") {
      throw new HttpError("invalid_codex_auth_credential", 400);
    }

    return { visible, stored };
  }

  function pruneExpiredCodexAuthUploadSessions() {
    const timestamp = now().getTime();
    for (const [token, session] of codexAuthUploadSessions) {
      if (session.expiresAt.getTime() <= timestamp) {
        codexAuthUploadSessions.delete(token);
      }
    }
  }

  function getCodexAuthUploadSession(token: string): CodexAuthUploadSessionRecord | null {
    pruneExpiredCodexAuthUploadSessions();
    return codexAuthUploadSessions.get(token) ?? null;
  }

  function createCodexAuthUploadCommand(input: {
    uploadUrl: string;
    credentialId?: string | null;
    credentialName: string;
  }) {
    const command = [
      "node",
      "scripts/admin/codex-auth-upload.mjs",
      "--upload-url",
      shellQuote(input.uploadUrl),
      "--credential-name",
      shellQuote(input.credentialName),
    ];
    if (input.credentialId) {
      command.splice(4, 0, "--credential-id", shellQuote(input.credentialId));
    }
    return command.join(" ");
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

  async function toCodexCapacityCredentials(
    credentials: CredentialRecord[],
    statusProvider: CodexCredentialStatusProvider,
  ): Promise<CodexCapacityCredential[]> {
    return Promise.all(
      credentials
        .filter((credential) => credential.provider === "codex_oauth")
        .map(async (credential) => {
          let upstreamStatus: CodexUsageStatus | null = null;
          if (Object.hasOwn(credential, "upstreamStatus")) {
            upstreamStatus = credential.upstreamStatus ?? null;
          } else {
            upstreamStatus = await statusProvider.getStatus({
              credentialId: credential.id,
              credentialName: credential.name,
            });
          }

          return {
            id: credential.id,
            name: credential.name,
            state: credential.state,
            upstreamStatus,
          };
        }),
    );
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

    const capacityCredentials = await toCodexCapacityCredentials(credentials, statusProvider);

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
      capacity: buildCodexCapacityOverview(capacityCredentials),
    };
  }

  async function listCodexCapacityAlerts(): Promise<AlertRecord[]> {
    const capacity = await loadCodexCapacityOverview();
    return buildCodexCapacityAlerts(capacity, now());
  }

  async function loadCodexCapacityOverview(): Promise<CodexCapacityOverview> {
    const credentials = await withCodexUpstreamStatus(
      await getCredentialReadRepository().listAdminCredentials(),
      codexStatusProvider,
    );
    const capacityCredentials = await toCodexCapacityCredentials(credentials, codexStatusProvider);
    return buildCodexCapacityOverview(capacityCredentials);
  }

  async function listCodexCapacityAlertsBestEffort(): Promise<AlertRecord[]> {
    try {
      return await withTimeout(
        listCodexCapacityAlerts(),
        readCodexCapacityAlertReadTimeoutMs(),
        "codex_capacity_alerts_timeout",
      );
    } catch (error) {
      console.error("ai_gateway_admin_codex_capacity_alerts_failed", error);
      return [];
    }
  }

  function getCodexCapacityAlertEmailRunner() {
    if (!codexCapacityAlertEmailRunner) {
      codexCapacityAlertEmailRunner = createCodexCapacityAlertMonitorRunner({
        loadCapacityOverview: loadCodexCapacityOverview,
        listAdminRecipients: async () => alertEmailRecipients,
        sendEmail: sendAlertEmail,
        audit: getAuditRepository(),
        now,
      });
    }

    return codexCapacityAlertEmailRunner;
  }

  function getCredentialAlertEmailRunner() {
    if (!credentialAlertEmailRunner) {
      credentialAlertEmailRunner = createCredentialAlertEmailMonitorRunner({
        listAlerts: async () => getAlertRepository().listAlerts(),
        listPlatformAdminRecipients: async () => denClient.listPlatformAdminRecipients?.(env.denInternalToken) ?? [],
        listFallbackRecipients: async () => alertEmailRecipients,
        sendEmail: sendAlertEmail,
        audit: getAuditRepository(),
        now,
      });
    }

    return credentialAlertEmailRunner;
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
    createUser(token, input) {
      return denClient.createUser(token, input);
    },
    updateUser(token, userId, input) {
      return denClient.updateUser(token, userId, input);
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
    getOrganizationBilling(token, orgId) {
      return requireDenOrganizationProxy("getOrganizationBilling")(token, orgId);
    },
    createOrganizationBillingCheckout(token, orgId, input) {
      return requireDenOrganizationProxy("createOrganizationBillingCheckout")(token, orgId, input);
    },
    createOrganizationBillingPortal(token, orgId, input) {
      return requireDenOrganizationProxy("createOrganizationBillingPortal")(token, orgId, input);
    },
    updateOrganizationBillingPlan(token, orgId, input) {
      return requireDenOrganizationProxy("updateOrganizationBillingPlan")(token, orgId, input);
    },
    cancelOrganizationBilling(token, orgId, input) {
      return requireDenOrganizationProxy("cancelOrganizationBilling")(token, orgId, input);
    },
    updatePlatformOrganizationBilling(token, orgId, input) {
      return requireDenOrganizationProxy("updatePlatformOrganizationBilling")(token, orgId, input);
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
    resendOrganizationInvite(token, orgId, inviteId) {
      return requireDenOrganizationProxy("resendOrganizationInvite")(token, orgId, inviteId);
    },
    revokeOrganizationInvite(token, orgId, inviteId) {
      return requireDenOrganizationProxy("revokeOrganizationInvite")(token, orgId, inviteId);
    },
    async getUserAiAccess(_token, userId) {
      const modelPolicy = await getModelPolicyRepository().getPolicy();
      if (!modelPolicy) throw new HttpError("platform_model_policy_not_configured", 503);
      const availableCredentials = await listAvailableAssignmentCredentials(modelPolicy.activeModel);
      const aiAccess = await repairCodexAccessForRead(
        await getAiAccessRepository().getUserAiAccess(userId),
        availableCredentials,
        modelPolicy.activeModel,
      );

      return {
        aiAccess: toAdminUserAiAccessRecord(aiAccess),
        availableCredentials,
      };
    },
    async upsertUserAiAccess(_token, userId, input, organizationId, actorUserId) {
      const modelPolicy = await getModelPolicyRepository().getPolicy();
      if (!modelPolicy) throw new HttpError("platform_model_policy_not_configured", 503);
      const validated = validateUserAiAccessInput({
        ...input,
        userId,
      }, modelPolicy);
      if (validated.enabled) {
        await assertAssignableCredential(validated.provider, validated.credentialId, modelPolicy.activeModel);
      }
      if (!actorUserId) {
        throw new HttpError("admin_actor_required", 401);
      }
      if (!organizationId) {
        throw new HttpError("organization_context_required", 400);
      }
      const availableCredentials = await listAvailableAssignmentCredentials(modelPolicy.activeModel);
      const saved = await getAiAccessMutation().upsertUserAiAccessWithAudit({
        ...validated,
        actorUserId,
        organizationId,
      });
      return {
        aiAccess: toAdminUserAiAccessRecord(saved)!,
        availableCredentials,
      };
    },
    disableUser(token, userId) {
      return denClient.disableUser(token, userId);
    },
    enableUser(token, userId) {
      return denClient.enableUser(token, userId);
    },
    deleteUser(token, userId) {
      return denClient.deleteUser(token, userId);
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
        const status = await codexStatusProvider.getStatus({
          credentialId,
          credentialName: credential.name?.trim() || credentialId,
        }).catch(() => null);
        const models = filterUnsupportedCodexModels(listCodexModelCatalog(), status);
        const defaultModel = models.includes(CODEX_DEFAULT_MODEL) ? CODEX_DEFAULT_MODEL : models[0];
        return {
          credentialId,
          models,
          ...(defaultModel ? { defaultModel } : {}),
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
    async getPlatformModelPolicy() {
      return {
        policy: toAdminPlatformModelPolicy(await getModelPolicyRepository().getPolicy()),
      };
    },
    async replacePlatformModelPolicy(_token, input, actorUserId) {
      const validated = validatePlatformModelPolicyInput(input);
      await assertEnabledModelCapabilities(validated.enabledModels);
      await assertNoEnabledAssignmentProviderConflicts(validated.activeModel);
      try {
        const saved = await getModelPolicyMutation().replacePolicyWithAudit({
          actorUserId,
          enabledModels: validated.enabledModels,
          activeModel: validated.activeModel,
        });
        return { policy: toAdminPlatformModelPolicy(saved)! };
      } catch (error) {
        if (
          error instanceof PlatformModelPolicyAuditPersistenceError
          || (error && typeof error === "object" && (error as { code?: unknown }).code === "model_policy_audit_failed")
        ) {
          throw new HttpError("model_policy_audit_failed", 502);
        }
        throw error;
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
    async renameCredential(_token, credentialId, input, actorUserId) {
      const name = validateCredentialName(input.name);
      const updated = await getCredentialActionRepository().renameCredential({ credentialId, name });
      if (!updated) {
        throw new HttpError("credential_not_found", 404);
      }
      await recordAuditEvent({
        actorUserId,
        action: "credential.rename",
        entityType: "credential",
        entityId: credentialId,
        result: "ok",
        summary: `Renamed credential ${credentialId}.`,
      });
      return { credential: await getCredentialOrThrow(credentialId) };
    },
    async createCodexAuthUploadSession(_token, credentialId, input, actorUserId) {
      const { visible } = await getCodexCredentialSecretRecordOrThrow(credentialId);
      const token = randomBytes(24).toString("hex");
      const expiresAt = new Date(now().getTime() + CODEX_AUTH_UPLOAD_SESSION_TTL_MS);
      const credentialName = visible.name;
      const uploadUrl = `${input.origin.replace(/\/+$/, "")}/admin/api/credentials/codex-auth-upload/${token}`;

      pruneExpiredCodexAuthUploadSessions();
      codexAuthUploadSessions.set(token, {
        token,
        mode: "replace",
        credentialId,
        credentialName,
        actorUserId,
        expiresAt,
      });

      await recordAuditEvent({
        actorUserId,
        action: "credential.codex_auth_upload_session.create",
        entityType: "credential",
        entityId: credentialId,
        result: "ok",
        summary: `Created Codex auth upload session for credential ${credentialId}.`,
      });

      return {
        upload: {
          token,
          credentialId,
          credentialName,
          uploadUrl,
          expiresAt: expiresAt.toISOString(),
        },
        command: createCodexAuthUploadCommand({
          uploadUrl,
          credentialId,
          credentialName,
        }),
      };
    },
    async createCodexAuthCredentialUploadSession(_token, input, actorUserId) {
      const token = randomBytes(24).toString("hex");
      const expiresAt = new Date(now().getTime() + CODEX_AUTH_UPLOAD_SESSION_TTL_MS);
      const credentialName = "New Codex account";
      const uploadUrl = `${input.origin.replace(/\/+$/, "")}/admin/api/credentials/codex-auth-upload/${token}`;

      pruneExpiredCodexAuthUploadSessions();
      codexAuthUploadSessions.set(token, {
        token,
        mode: "create",
        credentialId: null,
        credentialName,
        actorUserId,
        expiresAt,
      });

      await recordAuditEvent({
        actorUserId,
        action: "credential.codex_auth_upload_session.create",
        entityType: "credential",
        entityId: "new_codex_credential",
        result: "ok",
        summary: "Created Codex auth upload session for a new credential.",
      });

      return {
        upload: {
          token,
          credentialId: null,
          credentialName,
          uploadUrl,
          expiresAt: expiresAt.toISOString(),
        },
        command: createCodexAuthUploadCommand({
          uploadUrl,
          credentialName,
        }),
      };
    },
    async uploadCodexAuth(token, input) {
      const uploadSession = getCodexAuthUploadSession(token);
      if (!uploadSession) {
        throw new HttpError("codex_auth_upload_session_not_found", 404);
      }

      const authJson = validateCodexAuthJson(typeof input.authJson === "string" ? input.authJson : "");
      const accountId = readCodexAuthAccountId(authJson);
      if (uploadSession.mode === "create") {
        const credentialName = buildCodexCredentialNameFromAuthJson(authJson);
        const stored = await getSecretStore().put({
          kind: "codex_auth_json",
          authJson,
        });
        const created = await getCredentialWriteRepository().createPlatformCredential({
          ownerUserId: getPlatformCredentialOwnerUserId("codex_oauth"),
          name: credentialName,
          provider: "codex_oauth",
          credentialType: "oauth",
          secretRef: stored.secretRef,
        });
        codexAuthUploadSessions.delete(token);

        await recordAuditEvent({
          actorUserId: uploadSession.actorUserId,
          action: "credential.codex_auth_upload",
          entityType: "credential",
          entityId: created.id,
          result: "ok",
          summary: `Uploaded Codex auth and created credential ${created.id}.`,
        });

        return {
          ok: true,
          credentialId: created.id,
          credentialName: toAdminCredentialRecord(created).name,
          accountId,
        };
      }

      if (!uploadSession.credentialId) {
        throw new HttpError("codex_auth_upload_session_not_found", 404);
      }
      const { visible, stored } = await getCodexCredentialSecretRecordOrThrow(uploadSession.credentialId);

      await getSecretStore().replace(stored.secretRef, {
        kind: "codex_auth_json",
        authJson,
      });
      const updated = await getCredentialActionRepository().reconnectCredential(uploadSession.credentialId);
      if (!updated) {
        throw new HttpError("credential_not_found", 404);
      }
      codexAuthUploadSessions.delete(token);

      await recordAuditEvent({
        actorUserId: uploadSession.actorUserId,
        action: "credential.codex_auth_upload",
        entityType: "credential",
        entityId: uploadSession.credentialId,
        result: "ok",
        summary: `Uploaded Codex auth for credential ${uploadSession.credentialId}.`,
      });

      return {
        ok: true,
        credentialId: uploadSession.credentialId,
        credentialName: visible.name,
        accountId,
      };
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
        summary: `Rotated active routes off credential ${credentialId}.`,
      });
      return { credential: await getCredentialOrThrow(credentialId) };
    },
    async reconnectCredential(_token, credentialId, input, actorUserId) {
      const credential = await getCredentialOrThrow(credentialId);
      if (credential.provider !== "codex_oauth") {
        throw new HttpError("credential_reconnect_unsupported_provider", 400);
      }

      const authJson = validateCodexAuthJson(typeof input.secret === "string" ? input.secret.trim() : "");
      const storedCredential = await getCredentialSecretLookupRepository().getCredentialRecordById(credentialId);
      if (!storedCredential) {
        throw new HttpError("credential_not_found", 404);
      }
      if (storedCredential.provider !== "codex_oauth") {
        throw new HttpError("credential_reconnect_unsupported_provider", 400);
      }

      await getSecretStore().replace(storedCredential.secretRef, {
        kind: "codex_auth_json",
        authJson,
      });
      const updated = await getCredentialActionRepository().reconnectCredential(credentialId);
      if (!updated) {
        throw new HttpError("credential_not_found", 404);
      }
      await recordAuditEvent({
        actorUserId,
        action: "credential.reconnect",
        entityType: "credential",
        entityId: credentialId,
        result: "ok",
        summary: `Reconnected Codex credential ${credentialId}.`,
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
      const [capacityAlerts, repositoryAlerts] = await Promise.all([
        listCodexCapacityAlertsBestEffort(),
        getAlertRepository().listAlerts(),
      ]);
      return { alerts: [...capacityAlerts, ...repositoryAlerts] };
    },
    async runCodexCapacityAlertEmailMonitor() {
      return getCodexCapacityAlertEmailRunner()();
    },
    async runCredentialAlertEmailMonitor() {
      return getCredentialAlertEmailRunner()();
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
    async listOrganizationAudit(token, orgId, requestedLimit = ORGANIZATION_AUDIT_SOURCE_LIMIT) {
      const denResult = await requireDenOrganizationProxy("listOrganizationAudit")(
        token,
        orgId,
        ORGANIZATION_AUDIT_SOURCE_LIMIT,
      );
      if (denResult.status < 200 || denResult.status >= 300) {
        return denResult;
      }
      const denEvents = readDenOrganizationAuditEvents(denResult.body);
      const auditRepository = getAuditRepository();
      if (!auditRepository.listEvents) {
        throw new HttpError("organization_audit_gateway_source_unavailable", 503);
      }
      const listInput: ListAuditEventsInput = {
        limit: ORGANIZATION_AUDIT_SOURCE_LIMIT,
        organizationId: orgId,
      };
      const gatewayEvents = await auditRepository.listEvents(listInput);
      return {
        status: 200,
        body: {
          events: mergeOrganizationAuditEvents({
            denEvents,
            gatewayEvents,
            limit: readOrganizationAuditLimit(String(requestedLimit)),
          }),
        },
      };
    },
  };

  async function assertEnabledModelCapabilities(enabledModels: PlatformModelRef[]): Promise<void> {
    for (const modelRef of enabledModels) {
      if (modelRef.provider === "openai" || modelRef.provider === "anthropic") {
        throw new HttpError("model_policy_activation_not_verifiable_for_provider", 422);
      }
    }

    const results = await getModelCapabilities().checkHealthyCredentialsForModels(enabledModels);
    if (results.length !== enabledModels.length) {
      throw new HttpError("model_policy_capability_evidence_unavailable", 503);
    }

    for (const [index, result] of results.entries()) {
      const expected = enabledModels[index]!;
      if (result.model.provider !== expected.provider || result.model.model !== expected.model) {
        throw new HttpError("model_policy_capability_evidence_unavailable", 503);
      }
      if (result.status === "supported") continue;
      if (result.status === "unsupported") {
        if (result.reason === "no_healthy_credential") {
          throw new HttpError(
            `model_policy_enabled_model_has_no_healthy_credential:${expected.provider}/${expected.model}`,
            422,
          );
        }
        throw new HttpError("model_policy_enabled_model_unsupported", 422);
      }
      throw mapModelPolicyCapabilityError(result.reason);
    }
  }

  async function assertNoEnabledAssignmentProviderConflicts(activeModel: PlatformModelRef): Promise<void> {
    const aiAccess = getAiAccessRepository();
    if (!aiAccess.countEnabledPoliciesIncompatibleWithProvider) {
      throw new HttpError("model_policy_assignment_compatibility_unavailable", 503);
    }

    let incompatibleCount: number;
    try {
      incompatibleCount = await aiAccess.countEnabledPoliciesIncompatibleWithProvider(activeModel.provider);
    } catch (error) {
      console.error("model_policy_assignment_compatibility_check_failed", error);
      throw new HttpError("model_policy_assignment_compatibility_unavailable", 503);
    }

    if (incompatibleCount > 0) {
      throw new HttpError("model_policy_active_provider_has_incompatible_assignments", 409);
    }
  }
}

function mapModelPolicyCapabilityError(reason: string): HttpError {
  if (reason === "capability_check_timeout") {
    return new HttpError("model_policy_capability_check_timeout", 504);
  }
  if (reason === "model_discovery_timeout") {
    return new HttpError("model_policy_model_discovery_timeout", 504);
  }
  if (reason === "model_discovery_unavailable") {
    return new HttpError("model_policy_model_discovery_unavailable", 503);
  }
  if (reason === "model_discovery_target_not_allowed") {
    return new HttpError("model_policy_model_discovery_target_not_allowed", 400);
  }
  if (reason === "model_discovery_failed") {
    return new HttpError("model_policy_model_discovery_failed", 502);
  }
  if (reason === "credential_lookup_failed" || reason === "credential_lookup_unavailable") {
    return new HttpError("model_policy_credential_lookup_failed", 503);
  }
  return new HttpError("model_policy_capability_evidence_unavailable", 503);
}

function validatePlatformModelPolicyInput(input: ReplacePlatformModelPolicyInput): ReplacePlatformModelPolicyInput {
  const rawEnabledModels = Array.isArray(input?.enabledModels) ? input.enabledModels : [];
  const enabledModels: PlatformModelRef[] = [];
  const seen = new Set<string>();

  for (const value of rawEnabledModels) {
    const modelRef = normalizePlatformModelRef(value);
    if (!modelRef) continue;
    const key = `${modelRef.provider}\u0000${modelRef.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    enabledModels.push(modelRef);
  }
  if (enabledModels.length === 0) {
    throw new HttpError("model_policy_enabled_models_required", 400);
  }

  const activeModel = normalizePlatformModelRef(input?.activeModel);
  if (!activeModel || !enabledModels.some((model) => modelRefsEqual(model, activeModel))) {
    throw new HttpError("model_policy_active_model_not_enabled", 400);
  }
  return { enabledModels, activeModel };
}

function normalizePlatformModelRef(value: PlatformModelRef | null | undefined): PlatformModelRef | null {
  const provider = typeof value?.provider === "string" ? value.provider.trim() : "";
  if (!isAiGatewayProvider(provider)) {
    throw new HttpError("model_policy_invalid_provider", 400);
  }
  const model = typeof value?.model === "string" ? value.model.trim() : "";
  if (!model) return null;
  if (Array.from(model).length > 128) {
    throw new HttpError("model_policy_model_too_long", 400);
  }
  return { provider, model };
}

function modelRefsEqual(left: PlatformModelRef, right: PlatformModelRef) {
  return left.provider === right.provider && left.model === right.model;
}

function toAdminPlatformModelPolicy(policy: PlatformModelPolicyRecord | null): AdminPlatformModelPolicy | null {
  if (!policy) return null;
  return {
    enabledModels: policy.enabledModels,
    activeModel: policy.activeModel,
    updatedAt: policy.updatedAt.toISOString(),
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
  modelPolicy: PlatformModelPolicyRecord,
): UpsertUserAiAccessPolicyInput {
  const activeModel = modelPolicy.activeModel;
  const enabled = input.enabled === true;
  const provider = parseAiAccessProvider(input.provider);
  const credentialId =
    typeof input.credentialId === "string" && input.credentialId.trim()
      ? input.credentialId.trim()
      : null;
  if (enabled && !provider) {
    throw new HttpError("invalid_ai_access_provider", 400);
  }

  if (enabled && provider !== activeModel.provider) {
    throw new HttpError("ai_access_provider_mismatch", 400);
  }

  if (enabled && (provider === "codex_oauth" || provider === "openai_compatible") && !credentialId) {
    throw new HttpError("invalid_ai_access_credential_id", 400);
  }

  return {
    userId: input.userId,
    enabled,
    provider,
    credentialId,
    defaultModel: enabled ? activeModel.model : null,
    allowedModels: enabled ? assignedPlatformModelRoster(modelPolicy) : [],
    assignmentOrigin: "admin_assigned",
  };
}

function assignedPlatformModelRoster(modelPolicy: PlatformModelPolicyRecord): string[] {
  const provider = modelPolicy.activeModel.provider;
  const activeModel = modelPolicy.activeModel.model;
  const seen = new Set<string>();
  const models: string[] = [];
  for (const entry of modelPolicy.enabledModels) {
    if (entry.provider !== provider) continue;
    const model = entry.model.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models.includes(activeModel)
    ? [activeModel, ...models.filter((model) => model !== activeModel)]
    : [activeModel];
}

function parseAiAccessProvider(value: unknown): AiAccessProvider | null {
  return isAiGatewayProvider(value) ? value : null;
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

function readCodexAuthAccountId(authJson: string): string {
  try {
    const parsed = JSON.parse(authJson) as { tokens?: { account_id?: unknown } };
    const accountId = typeof parsed.tokens?.account_id === "string" ? parsed.tokens.account_id.trim() : "";
    if (accountId) {
      return accountId;
    }
  } catch {
    // validateCodexAuthJson already maps this for callers.
  }

  throw new HttpError("invalid_credential_secret", 400);
}

function buildCodexCredentialNameFromAuthJson(authJson: string): string {
  const email = readCodexAuthEmail(authJson);
  return validateCredentialName(`${email} Codex`);
}

function readCodexAuthEmail(authJson: string): string {
  try {
    const parsed = JSON.parse(authJson) as { tokens?: { id_token?: unknown } };
    const idToken = typeof parsed.tokens?.id_token === "string" ? parsed.tokens.id_token.trim() : "";
    const [, payload] = idToken.split(".");
    if (!payload) {
      throw new Error("missing id token payload");
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (email && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return email;
    }
  } catch {
    // mapped below
  }

  throw new HttpError("invalid_codex_auth_account_email", 400);
}

function validateCredentialName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 120) {
    throw new HttpError("invalid_credential_name", 400);
  }
  return name;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
  return pathname === "/admin/app.js"
    || pathname === "/admin/app.css"
    || pathname === "/admin/admin-route-state.js"
    || pathname === "/admin/admin-page-load-state.js"
    || pathname === "/admin/model-policy-editor-state.js";
}

function errorStatus(error: unknown): number | null {
  return error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
}

function escapeAdminShellHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function adminFallbackShellHtml(session: AdminSessionSnapshot) {
  const platformNavigation = session.platformAdmin
    ? `<nav aria-label="Platform administration" data-nav-group="platform">
        <h2>Platform administration</h2>
        <a href="/admin">Overview</a>
        <a href="/admin/organizations">Organizations</a>
        <a href="/admin/ai-infrastructure">AI Infrastructure</a>
        <a href="/admin/ai-infrastructure/usage">Usage</a>
        <a href="/admin/ai-infrastructure/alerts">Alerts</a>
        <a href="/admin/platform-users">Platform Users</a>
        <a href="/admin/audit">Global Audit</a>
      </nav>`
    : "";
  const organizationNavigation = session.organizations.map((organization) => {
    const organizationId = encodeURIComponent(organization.id);
    const organizationLabel = escapeAdminShellHtml(organization.name || organization.slug || organization.id);
    return `<section data-organization-workspace="${escapeAdminShellHtml(organization.id)}">
          <h3>${organizationLabel}</h3>
          <nav aria-label="${organizationLabel} organization workspace">
            <a href="/admin/organizations/${organizationId}/overview">Overview</a>
            <a href="/admin/organizations/${organizationId}/members">Members</a>
            <a href="/admin/organizations/${organizationId}/domains-invites">Domains &amp; invites</a>
            <a href="/admin/organizations/${organizationId}/billing">Billing</a>
            <a href="/admin/organizations/${organizationId}/ai-access">AI access</a>
            <a href="/admin/organizations/${organizationId}/audit">Audit</a>
          </nav>
        </section>`;
  }).join("\n");
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
        <p>The full admin shell is unavailable. Use a canonical workspace link to retry safely.</p>
      </header>
      ${platformNavigation}
      <section aria-labelledby="organization-workspaces-title">
        <h2 id="organization-workspaces-title">Organization workspaces</h2>
        ${organizationNavigation || "<p>No authorized organization workspace is available.</p>"}
      </section>
    </div>
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

function requirePlatformAdmin(res: express.Response): boolean {
  const session = res.locals.adminSession as AdminSessionSnapshot | undefined;
  if (session?.platformAdmin === true) {
    return true;
  }

  res.status(403).json({ error: "forbidden" });
  return false;
}

function requireOrganizationAccess(res: express.Response, orgId: string): boolean {
  const session = res.locals.adminSession as AdminSessionSnapshot | undefined;
  if (
    session?.platformAdmin === true
    || session?.organizations.some(
      (organization) => organization.id === orgId && organization.role === "organization_admin",
    )
  ) {
    return true;
  }
  res.status(403).json({ error: "forbidden" });
  return false;
}

const platformAdminShellPaths = new Set([
  "/admin",
  "/admin/organizations",
  "/admin/ai-infrastructure",
  "/admin/ai-infrastructure/usage",
  "/admin/ai-infrastructure/alerts",
  "/admin/platform-users",
  "/admin/audit",
]);

function organizationIdFromAdminShellPath(pathname: string): string | null {
  const match = pathname.match(/^\/admin\/organizations\/([^/]+)\/(overview|members|domains-invites|billing|ai-access|audit)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] ?? "").trim() || null;
  } catch {
    return null;
  }
}

function adminShellRouteAllowed(pathname: string, session: AdminSessionSnapshot): boolean {
  if (platformAdminShellPaths.has(pathname)) {
    return session.platformAdmin === true;
  }
  const organizationId = organizationIdFromAdminShellPath(pathname);
  if (!organizationId) return false;
  return session.platformAdmin === true || session.organizations.some((organization) => organization.id === organizationId);
}

function firstAuthorizedAdminPath(session: AdminSessionSnapshot): string {
  if (session.platformAdmin) return "/admin";
  const organizationId = session.organizations[0]?.id;
  return organizationId
    ? `/admin/organizations/${encodeURIComponent(organizationId)}/overview`
    : "/admin";
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

function readOrganizationUpdateInput(
  body: unknown,
  options: { allowSeatLimit?: boolean } = {},
): UpdateOrganizationInput {
  const input: UpdateOrganizationInput = {};
  if (hasOwn(body, "name")) {
    input.name = readTrimmedString((body as { name?: unknown }).name) ?? "";
  }
  if (hasOwn(body, "slug")) {
    input.slug = readTrimmedString((body as { slug?: unknown }).slug) ?? "";
  }
  if (hasOwn(body, "seatLimit")) {
    if (options.allowSeatLimit !== true) {
      throw new HttpError("forbidden_seat_limit", 403);
    }
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

function readFirstHeader(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") {
    return null;
  }
  const [first] = raw.split(",");
  const trimmed = first?.trim();
  return trimmed || null;
}

function createRequestOrigin(req: express.Request): string {
  const protocol = readFirstHeader(req.headers["x-forwarded-proto"]) ?? req.protocol ?? "http";
  const host = readFirstHeader(req.headers["x-forwarded-host"]) ?? req.get("host");
  if (!host) {
    throw new HttpError("codex_auth_upload_origin_unavailable", 500);
  }

  return `${protocol}://${host}`;
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

  router.post("/admin/api/credentials/codex-auth-upload/:token", async (req, res) => {
    try {
      const payload = await adminService.uploadCodexAuth(req.params.token, {
        authJson: typeof req.body?.authJson === "string" ? req.body.authJson : "",
      });
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "codex_auth_upload_failed" });
    }
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

  router.get("/admin/api/ai-infrastructure/model-policy", async (_req, res) => {
    if (!requirePlatformAdmin(res)) {
      return;
    }

    try {
      const payload = await adminService.getPlatformModelPolicy(res.locals.adminToken as string);
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "model_policy_read_failed" });
    }
  });

  router.put("/admin/api/ai-infrastructure/model-policy", async (req, res) => {
    if (!requirePlatformAdmin(res)) {
      return;
    }

    try {
      const payload = await adminService.replacePlatformModelPolicy(
        res.locals.adminToken as string,
        req.body as ReplacePlatformModelPolicyInput,
        (res.locals.adminSession as AdminSessionSnapshot).user.id,
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "model_policy_replace_failed" });
    }
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
      const session = res.locals.adminSession as AdminSessionSnapshot | undefined;
      const payload = await adminService.updateOrganization(
        res.locals.adminToken as string,
        req.params.orgId,
        readOrganizationUpdateInput(req.body, { allowSeatLimit: session?.platformAdmin === true }),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_update_failed" });
    }
  });

  const sendOrganizationBillingProxy = async (
    req: express.Request,
    res: express.Response,
    operation: keyof Pick<AdminService,
      | "getOrganizationBilling"
      | "createOrganizationBillingCheckout"
      | "createOrganizationBillingPortal"
      | "updateOrganizationBillingPlan"
      | "cancelOrganizationBilling"
      | "updatePlatformOrganizationBilling">,
    options: { platformOnly?: boolean } = {},
  ) => {
    const orgId = req.params.orgId;
    if (!orgId) {
      res.status(400).json({ error: "invalid_organization_id" });
      return;
    }
    if (
      !requireAdminCapability(res, "organization")
      || !requireOrganizationAccess(res, orgId)
      || (options.platformOnly === true && !requirePlatformAdmin(res))
    ) return;
    const handler = adminService[operation];
    if (!handler) {
      res.status(503).json({ error: "organization_billing_unavailable" });
      return;
    }
    try {
      const token = res.locals.adminToken as string;
      const result = operation === "getOrganizationBilling"
        ? await (handler as NonNullable<AdminService["getOrganizationBilling"]>)(token, orgId)
        : await (handler as (
            token: string,
            orgId: string,
            input: AdminOrganizationBillingInput,
          ) => Promise<AdminDenProxyResponse>)(token, orgId, req.body ?? {});
      res.status(result.status).json(result.body);
    } catch (error) {
      if (mapHttpError(error, res)) return;
      res.status(502).json({ error: "organization_billing_proxy_failed" });
    }
  };

  router.get("/admin/api/organizations/:orgId/billing", (req, res) => {
    void sendOrganizationBillingProxy(req, res, "getOrganizationBilling");
  });
  router.post("/admin/api/organizations/:orgId/billing/checkout", (req, res) => {
    void sendOrganizationBillingProxy(req, res, "createOrganizationBillingCheckout");
  });
  router.post("/admin/api/organizations/:orgId/billing/portal", (req, res) => {
    void sendOrganizationBillingProxy(req, res, "createOrganizationBillingPortal");
  });
  router.patch("/admin/api/organizations/:orgId/billing/plan", (req, res) => {
    void sendOrganizationBillingProxy(req, res, "updateOrganizationBillingPlan");
  });
  router.post("/admin/api/organizations/:orgId/billing/cancel", (req, res) => {
    void sendOrganizationBillingProxy(req, res, "cancelOrganizationBilling");
  });
  router.patch("/admin/api/organizations/:orgId/billing/platform", (req, res) => {
    void sendOrganizationBillingProxy(req, res, "updatePlatformOrganizationBilling", { platformOnly: true });
  });

  router.get("/admin/api/organizations/:orgId/audit", async (req, res) => {
    if (!requireAdminCapability(res, "organization") || !requireOrganizationAccess(res, req.params.orgId)) return;
    if (!adminService.listOrganizationAudit) {
      res.status(503).json({ error: "organization_audit_unavailable" });
      return;
    }
    try {
      const result = await adminService.listOrganizationAudit(
        res.locals.adminToken as string,
        req.params.orgId,
        readOrganizationAuditLimit(req.query.limit),
      );
      res.status(result.status).json(result.body);
    } catch (error) {
      if (mapHttpError(error, res)) return;
      res.status(502).json({ error: "organization_audit_list_failed" });
    }
  });

  router.get("/admin/api/organizations/:orgId/members", async (req, res) => {
    if (!requireAdminCapability(res, "organization") || !requireOrganizationAccess(res, req.params.orgId)) return;

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
    if (!requireAdminCapability(res, "organization") || !requireOrganizationAccess(res, req.params.orgId)) return;

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
    if (!requireAdminCapability(res, "organization") || !requireOrganizationAccess(res, req.params.orgId)) return;

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
    if (!requireAdminCapability(res, "organization") || !requireOrganizationAccess(res, req.params.orgId)) return;

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

  router.post("/admin/api/organizations/:orgId/invites/:inviteId/resend", async (req, res) => {
    if (!requireAdminCapability(res, "organization")) {
      return;
    }

    try {
      const payload = await adminService.resendOrganizationInvite(
        res.locals.adminToken as string,
        req.params.orgId,
        req.params.inviteId,
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "organization_invite_resend_failed" });
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

  router.patch("/admin/api/credentials/:credentialId", async (req, res) => {
    try {
      const payload = await adminService.renameCredential(
        res.locals.adminToken as string,
        req.params.credentialId,
        {
          name: typeof req.body?.name === "string" ? req.body.name.trim() : "",
        },
        getAdminActorUserId(res),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "credential_rename_failed" });
    }
  });

  router.post("/admin/api/credentials/codex-auth-upload-session", async (req, res) => {
    try {
      const payload = await adminService.createCodexAuthCredentialUploadSession(
        res.locals.adminToken as string,
        {
          origin: createRequestOrigin(req),
        },
        getAdminActorUserId(res),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "codex_auth_upload_session_create_failed" });
    }
  });

  router.post("/admin/api/credentials/:credentialId/codex-auth-upload-session", async (req, res) => {
    try {
      const payload = await adminService.createCodexAuthUploadSession(
        res.locals.adminToken as string,
        req.params.credentialId,
        {
          origin: createRequestOrigin(req),
        },
        getAdminActorUserId(res),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "codex_auth_upload_session_create_failed" });
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

  router.post("/admin/api/credentials/:credentialId/reconnect", async (req, res) => {
    if (!requireAdminCapability(res, "credentials")) {
      return;
    }

    try {
      const payload = await adminService.reconnectCredential(
        res.locals.adminToken as string,
        req.params.credentialId,
        {
          secret: typeof req.body?.secret === "string" ? req.body.secret.trim() : "",
        },
        getAdminActorUserId(res),
      );
      res.json(payload);
    } catch (error) {
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "credential_reconnect_failed" });
    }
  });

  router.get("/admin/api/sessions", async (req, res) => {
    if (!requirePlatformAdmin(res)) {
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
    if (!requireAdminCapability(res, "users")) {
      return;
    }

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
    if (!requireAdminCapability(res, "users") || !requirePlatformAdmin(res)) {
      return;
    }

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
    if (!requireAdminCapability(res, "users")) {
      return;
    }

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

  const confirmOrganizationAiAccessMember = async (
    res: express.Response,
    orgId: string,
    userId: string,
  ): Promise<boolean> => {
    try {
      const payload: unknown = await adminService.listOrganizationMembers(
        res.locals.adminToken as string,
        orgId,
      );
      if (
        !payload
        || typeof payload !== "object"
        || Array.isArray(payload)
        || !Array.isArray((payload as { members?: unknown }).members)
      ) {
        res.status(502).json({ error: "organization_member_response_invalid" });
        return false;
      }
      const members = (payload as { members: unknown[] }).members;
      if (!members.every((member): member is AdminOrganizationMemberRecord => (
        member != null
        && typeof member === "object"
        && !Array.isArray(member)
        && typeof (member as { membershipId?: unknown }).membershipId === "string"
        && (member as { membershipId: string }).membershipId.trim().length > 0
        && typeof (member as { userId?: unknown }).userId === "string"
        && (member as { userId: string }).userId.trim().length > 0
        && typeof (member as { name?: unknown }).name === "string"
        && typeof (member as { email?: unknown }).email === "string"
        && (
          (member as { role?: unknown }).role === "organization_admin"
          || (member as { role?: unknown }).role === "member"
        )
        && (
          (member as { status?: unknown }).status === "active"
          || (member as { status?: unknown }).status === "disabled"
          || (member as { status?: unknown }).status === "removed"
        )
        && typeof (member as { createdAt?: unknown }).createdAt === "string"
        && (member as { createdAt: string }).createdAt.trim().length > 0
      ))) {
        res.status(502).json({ error: "organization_member_response_invalid" });
        return false;
      }
      const targetMembers = members.filter((member) => member.userId === userId);
      if (targetMembers.length > 1) {
        res.status(502).json({ error: "organization_member_response_invalid" });
        return false;
      }
      if (targetMembers.length === 0 || targetMembers[0]?.status !== "active") {
        res.status(404).json({ error: "member_not_found" });
        return false;
      }
      return true;
    } catch (error) {
      const status = error && typeof error === "object"
        ? (error as { status?: unknown }).status
        : null;
      if (status === 401) {
        res.status(401).json({ error: "unauthorized" });
        return false;
      }
      if (status === 403) {
        res.status(403).json({ error: "forbidden" });
        return false;
      }
      res.status(502).json({ error: "organization_member_lookup_failed" });
      return false;
    }
  };

  router.get("/admin/api/organizations/:orgId/members/:userId/ai-access", async (req, res) => {
    if (
      !requireAdminCapability(res, "managedAiUserAccess")
      || !requireOrganizationAccess(res, req.params.orgId)
    ) return;

    if (!await confirmOrganizationAiAccessMember(res, req.params.orgId, req.params.userId)) {
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

  router.put("/admin/api/organizations/:orgId/members/:userId/ai-access", async (req, res) => {
    if (
      !requireAdminCapability(res, "managedAiUserAccess")
      || !requireOrganizationAccess(res, req.params.orgId)
    ) return;

    try {
      if (
        req.body && typeof req.body === "object"
        && (Object.hasOwn(req.body, "defaultModel") || Object.hasOwn(req.body, "allowedModels"))
      ) {
        throw new HttpError("user_model_policy_not_supported", 400);
      }
      if (!await confirmOrganizationAiAccessMember(res, req.params.orgId, req.params.userId)) {
        return;
      }
      const payload = await adminService.upsertUserAiAccess(res.locals.adminToken as string, req.params.userId, {
        enabled: req.body?.enabled === true,
        provider: parseAiAccessProvider(req.body?.provider),
        credentialId: typeof req.body?.credentialId === "string" ? req.body.credentialId : null,
      }, req.params.orgId, (res.locals.adminSession as AdminSessionSnapshot).user.id);
      res.json(payload);
    } catch (error) {
      if (error instanceof AiAccessAuditPersistenceError) {
        res.status(502).json({ error: error.code });
        return;
      }
      if (mapHttpError(error, res)) {
        return;
      }
      res.status(502).json({ error: "user_ai_access_update_failed" });
    }
  });

  router.post("/admin/api/users/:userId/disable", async (req, res) => {
    if (!requireAdminCapability(res, "users") || !requirePlatformAdmin(res)) {
      return;
    }

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
    if (!requireAdminCapability(res, "users") || !requirePlatformAdmin(res)) {
      return;
    }

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
    if (!requireAdminCapability(res, "users") || !requirePlatformAdmin(res)) {
      return;
    }

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

  router.use("/admin/api", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  const sendAdminShell = (_req: express.Request, res: express.Response) => {
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
      return;
    }
    res.type("html").send(adminFallbackShellHtml(res.locals.adminSession as AdminSessionSnapshot));
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
        if (!adminShellRouteAllowed(req.path, session)) {
          res.redirect(302, firstAuthorizedAdminPath(session));
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    unrefTimer(timeout);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function readCodexCapacityAlertReadTimeoutMs(): number {
  const raw = Number(process.env.AI_GATEWAY_CODEX_CAPACITY_ALERT_READ_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CODEX_CAPACITY_ALERT_READ_TIMEOUT_MS;
}

function unrefTimer(handle: unknown) {
  if (!handle || typeof handle !== "object") {
    return;
  }
  const unref = (handle as { unref?: unknown }).unref;
  if (typeof unref === "function") {
    unref.call(handle);
  }
}

function parseCredentialProvider(value: unknown): LeaseProvider | null {
  return isAiGatewayProvider(value) ? value : null;
}
