import { createAutomationsClient } from "../veslo-server-domains/automations";
import { createCommandsClient } from "../veslo-server-domains/commands";
import { createConversationsClient } from "../veslo-server-domains/conversations";
import { createExtensionsInventoryClient } from "../veslo-server-domains/extensions-inventory";
import { createFilesClient } from "../veslo-server-domains/files";
import { createMessagingIdentitiesClient } from "../veslo-server-domains/messaging-identities";
import { createMcpClient } from "../veslo-server-domains/mcp";
import { createPluginsClient } from "../veslo-server-domains/plugins";
import { createSkillsClient } from "../veslo-server-domains/skills";
import { createSoulClient } from "../veslo-server-domains/soul";
import { createWorkspaceClient } from "../veslo-server-domains/workspace";
import type { DocumentRuntimeStatusPayload } from "../document-runtime";
import {
  VesloServerError,
  buildGatewayCallerHeaders,
  normalizeBearerToken,
  requestBinary,
  requestJson,
  requestJsonRaw,
  requestMultipartRaw,
} from "./transport";
import type {
  VesloServerCapabilities,
  VesloServerStatus,
  VesloServerDiagnostics,
  VesloServerSettings,
  VesloWorkspaceInfo,
  VesloWorkspaceList,
  VesloResourceOwner,
  VesloPluginItem,
  VesloSkillItem,
  VesloSkillContent,
  VesloUserGlobalSkillStoreItem,
  VesloUserGlobalSkillStoreContent,
  VesloUserGlobalSkillStoreMutationResult,
  VesloUserGlobalSkillStoreSyncResult,
  VesloSkillResolveCandidate,
  VesloSkillResolveResult,
  VesloSkillRemovalScope,
  VesloSkillEnabledScope,
  VesloSkillRemovalItem,
  VesloSkillRemovalsResponse,
  VesloSkillEnabledRegistryIdentity,
  VesloSkillEnabledTarget,
  VesloDisabledSkillRecord,
  VesloDisabledSkillsResponse,
  VesloSkillEnabledStateResponse,
  VesloSkillRemovalMutationResult,
  VesloSkillBatchRemoveScope,
  VesloSkillBatchRemoveItem,
  VesloSkillBatchRemoveRequest,
  VesloSkillBatchRemoveSuccess,
  VesloSkillBatchRemoveFailure,
  VesloSkillBatchRemoveResponse,
  VesloHubSkillItem,
  VesloHubMcpOAuthConfig,
  VesloHubMcpAuthorization,
  VesloHubMcpItem,
  VesloSkillRegistryOwnerScope,
  VesloSkillRegistryVisibility,
  VesloSkillRegistryReviewStatus,
  VesloSkillRegistryUpdatePolicy,
  VesloSkillRegistryRolloutTarget,
  VesloSkillRegistryRolloutAudience,
  VesloSkillRegistryRolloutCatalogScope,
  VesloSkillRegistryRolloutRemovalPolicy,
  VesloSkillRegistryVersionSummary,
  VesloSkillRegistrySearchSkill,
  VesloSkillRegistrySearchResponse,
  VesloSkillRegistrySkillResponse,
  VesloSkillRegistryVersionResponse,
  VesloSkillRegistryVersionsResponse,
  VesloManagedSkillSource,
  VesloSkillRegistryInstallation,
  VesloSkillRegistryInstallationResponse,
  VesloSkillRegistryReviewRequestResponse,
  VesloSkillRegistryWorkspaceSkillSetResponse,
  VesloSkillRegistryRolloutPolicy,
  VesloSkillRegistryRolloutPolicyResponse,
  VesloSkillRegistryRolloutPoliciesResponse,
  VesloSkillRegistrySearchParams,
  VesloSkillRegistryCreateSkillInput,
  VesloSkillRegistryCreateVersionInput,
  VesloSkillRegistryCreateInstallationInput,
  VesloSkillRegistryListRolloutPoliciesInput,
  VesloSkillRegistryCreateRolloutPolicyInput,
  VesloSkillRegistryListVersionsInput,
  VesloSkillRegistryUpdateInstallationInput,
  VesloSkillRegistryUpdateRolloutPolicyInput,
  VesloSkillRegistryRestoreInstallationInput,
  VesloSkillRegistryCreateReviewRequestInput,
  VesloSkillRegistryReplaceWorkspaceSkillSetInput,
  VesloSkillRegistryReviewDecisionInput,
  VesloSkillMaterializationEntry,
  VesloSkillMaterializationConflict,
  VesloSkillMaterializationStatus,
  VesloGlobalSkillMaterializationStatus,
  VesloSkillMaterializationSyncOptions,
  VesloSkillRegistryAuthContext,
  VesloSkillMaterializationRequestOptions,
  VesloSkillMaterializationSyncResult,
  VesloGlobalSkillMaterializationSyncResult,
  VesloWorkspaceFileContent,
  VesloWorkspaceFileWriteResult,
  VesloFileSession,
  VesloFileCatalogEntry,
  VesloFileSessionEvent,
  VesloFileReadBatchResult,
  VesloFileWriteBatchResult,
  VesloFileOpsBatchResult,
  VesloCommandItem,
  VesloMcpItem,
  VesloOpenCodeRouterTelegramResult,
  VesloOpenCodeRouterSlackResult,
  VesloOpenCodeRouterTelegramBotInfo,
  VesloOpenCodeRouterTelegramInfo,
  VesloOpenCodeRouterTelegramEnabledResult,
  VesloOpenCodeRouterHealthSnapshot,
  VesloOpenCodeRouterBindingItem,
  VesloOpenCodeRouterBindingsResult,
  VesloOpenCodeRouterBindingUpdateResult,
  VesloOpenCodeRouterSendResult,
  VesloOpenCodeRouterIdentityItem,
  VesloOpenCodeRouterTelegramIdentitiesResult,
  VesloOpenCodeRouterSlackIdentitiesResult,
  VesloOpenCodeRouterTelegramIdentityUpsertResult,
  VesloOpenCodeRouterSlackIdentityUpsertResult,
  VesloOpenCodeRouterTelegramIdentityDeleteResult,
  VesloOpenCodeRouterSlackIdentityDeleteResult,
  VesloWorkspaceExport,
  VesloSessionArchiveRecord,
  VesloArtifactItem,
  VesloArtifactList,
  VesloSessionArtifactFamily,
  VesloSessionArtifactKind,
  VesloSessionArtifactStatus,
  VesloSessionArtifactItem,
  VesloSessionLatestRunArtifacts,
  VesloSessionTranscriptSnapshot,
  VesloSessionTranscriptPrefetchInput,
  VesloSessionTranscriptPrefetchResult,
  VesloSessionTranscriptAppendInput,
  VesloConversationList,
  VesloConversationCreateResult,
  VesloConversationImportInput,
  VesloConversationImportResult,
  VesloConversationRunKind,
  VesloConversationRunInput,
  VesloConversationRunDebugTraceEntry,
  VesloConversationRunSubmittedResult,
  VesloConversationRunQueuedResult,
  VesloConversationRunResult,
  VesloConversationRunStatusResult,
  VesloConversationAbortResult,
  VesloInboxItem,
  VesloInboxList,
  VesloInboxUploadResult,
  VesloSoulScope,
  VesloSoulVersionSource,
  VesloSoulVersion,
  VesloSoulDocument,
  VesloSoulSummary,
  VesloSoulMaterializationConflict,
  VesloSoulMaterializationFile,
  VesloSoulMaterializationResult,
  VesloSoulConfiguredMaterializationResult,
  VesloSoulAnyMaterializationResult,
  VesloSoulReadResponse,
  VesloSoulOverviewResponse,
  VesloWorkspaceSoulsResponse,
  VesloSoulVersionsResponse,
  VesloSoulVersionResponse,
  VesloSoulAuthContext,
  VesloSoulVersionListOptions,
  VesloSoulVersionGetOptions,
  VesloSoulUpdateInput,
  VesloSoulRestoreInput,
  VesloWorkspaceSystemProvisionResult,
  VesloActor,
  VesloAuditEntry,
  VesloReloadTrigger,
  VesloReloadEvent,
  VesloGatewayProvider,
  VesloUserAiAccess,
  VesloUserAiAccessResult,
  VesloManagedAiAccessBundle,
} from "./types";
import { normalizeVesloServerUrl, parseVesloWorkspaceIdFromUrl } from "./connection";

const SKILL_REGISTRY_ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SKILL_REGISTRY_SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SKILL_REGISTRY_VISIBILITY_VALUES: readonly VesloSkillRegistryVisibility[] = [
  "personal",
  "workspace",
  "organization",
  "platform",
];
const SKILL_REGISTRY_REVIEW_STATUS_VALUES: readonly VesloSkillRegistryReviewStatus[] = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRegistryRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requireRegistryString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireRegistryQuery(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("query must be a string");
  }
  return value.trim();
}

function optionalRegistryString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value.trim() || undefined;
}

function requireRegistryIsoInstant(value: unknown, field: string): string {
  const normalized = requireRegistryString(value, field);
  if (!SKILL_REGISTRY_ISO_INSTANT_PATTERN.test(normalized)) {
    throw new Error(`${field} must be a UTC ISO instant`);
  }
  return normalized;
}

function requireRegistrySha256(value: unknown, field: string): string {
  const normalized = requireRegistryString(value, field).toLowerCase();
  if (!SKILL_REGISTRY_SHA256_PATTERN.test(normalized)) {
    throw new Error(`${field} must be a SHA-256 digest`);
  }
  return normalized;
}

function requireRegistryEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function optionalRegistryStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item, index) => requireRegistryString(item, `${field}[${index}]`));
}

function optionalRegistryScore(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function validateSkillRegistryVersionSummary(value: unknown, field: string): VesloSkillRegistryVersionSummary {
  const record = requireRegistryRecord(value, field);
  return {
    id: requireRegistryString(record.id, `${field}.id`),
    version: requireRegistryString(record.version, `${field}.version`),
    packageSha256: requireRegistrySha256(record.packageSha256, `${field}.packageSha256`),
    createdAt: requireRegistryIsoInstant(record.createdAt, `${field}.createdAt`),
  };
}

function validateSkillRegistrySearchSkill(value: unknown, field: string): VesloSkillRegistrySearchSkill {
  const record = requireRegistryRecord(value, field);
  const description = optionalRegistryString(record.description, `${field}.description`);
  const tags = optionalRegistryStringArray(record.tags, `${field}.tags`);
  const latestVersion =
    record.latestVersion === undefined || record.latestVersion === null
      ? undefined
      : validateSkillRegistryVersionSummary(record.latestVersion, `${field}.latestVersion`);
  const score = optionalRegistryScore(record.score, `${field}.score`);
  const matchedFields = optionalRegistryStringArray(record.matchedFields, `${field}.matchedFields`);

  const skill: VesloSkillRegistrySearchSkill = {
    id: requireRegistryString(record.id, `${field}.id`),
    slug: requireRegistryString(record.slug, `${field}.slug`),
    name: requireRegistryString(record.name, `${field}.name`),
    visibility: requireRegistryEnum(record.visibility, `${field}.visibility`, SKILL_REGISTRY_VISIBILITY_VALUES),
    reviewStatus: requireRegistryEnum(record.reviewStatus, `${field}.reviewStatus`, SKILL_REGISTRY_REVIEW_STATUS_VALUES),
    createdAt: requireRegistryIsoInstant(record.createdAt, `${field}.createdAt`),
    updatedAt: requireRegistryIsoInstant(record.updatedAt, `${field}.updatedAt`),
  };
  if (description) skill.description = description;
  if (tags) skill.tags = tags;
  if (latestVersion) skill.latestVersion = latestVersion;
  if (score !== undefined) skill.score = score;
  if (matchedFields) skill.matchedFields = matchedFields;
  return skill;
}

function validateSkillRegistrySearchResponse(value: unknown): VesloSkillRegistrySearchResponse {
  try {
    const record = requireRegistryRecord(value, "skill registry search response");
    if (!Array.isArray(record.skills)) {
      throw new Error("skills must be an array");
    }
    const nextCursor =
      record.nextCursor === undefined || record.nextCursor === null
        ? record.nextCursor
        : requireRegistryString(record.nextCursor, "nextCursor");
    const response: VesloSkillRegistrySearchResponse = {
      query: requireRegistryQuery(record.query),
      skills: record.skills.map((skill, index) => validateSkillRegistrySearchSkill(skill, `skills[${index}]`)),
    };
    if (nextCursor !== undefined) response.nextCursor = nextCursor;
    return response;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Invalid skill registry search response";
    throw new VesloServerError(502, "skill_registry_invalid_payload", "Skill registry returned an invalid search payload", {
      reason,
    });
  }
}

export async function requestManagedAiAccessBundle(baseUrl: string, userToken: string) {
  const normalizedBaseUrl = normalizeVesloServerUrl(baseUrl);
  if (!normalizedBaseUrl) {
    throw new Error("Managed AI gateway base URL is required");
  }

  return requestJson<VesloManagedAiAccessBundle>(normalizedBaseUrl, "/api/me/ai-access", {
    timeoutMs: 30_000,
    extraHeaders: {
      Authorization: normalizeBearerToken(userToken, "userToken"),
    },
  });
}

export function createVesloServerClient(options: {
  baseUrl: string;
  token?: string;
  hostToken?: string;
  accountId?: string;
}) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const token = options.token;
  const hostToken = options.hostToken;
  const accountId = options.accountId?.trim() || undefined;

  const timeouts = {
    health: 3_000,
    capabilities: 6_000,
    listWorkspaces: 8_000,
    activateWorkspace: 10_000,
    addLocalWorkspace: 10_000,
    deleteWorkspace: 10_000,
    deleteSession: 12_000,
    sessionArtifacts: 10_000,
    sessionTranscript: 10_000,
    conversationCreate: 70_000,
    conversationRun: 90_000,
    conversationAbort: 10_000,
    status: 6_000,
    config: 10_000,
    opencodeRouter: 10_000,
    workspaceExport: 30_000,
    workspaceImport: 30_000,
    workspaceProvision: 20_000,
    aiAccess: 30_000,
    binary: 60_000,
    skillRegistrySearch: 10_000,
    skillRegistryMutation: 30_000,
    skillMaterialization: 30_000,
    soulMemory: 30_000,
    documentRuntime: 30_000,
  };

  const identities = createMessagingIdentitiesClient({
    baseUrl,
    token,
    hostToken,
    timeoutMs: timeouts.opencodeRouter,
    mountedWorkspaceId: parseVesloWorkspaceIdFromUrl(baseUrl),
    requestJson,
    requestJsonRaw,
    isNotFoundError: (error) => error instanceof VesloServerError && error.status === 404,
  });
  const automations = createAutomationsClient({
    baseUrl,
    token,
    hostToken,
    requestJson,
  });
  const plugins = createPluginsClient({
    baseUrl,
    token,
    hostToken,
    requestJson,
  });
  const commands = createCommandsClient({
    baseUrl,
    token,
    hostToken,
    requestJson,
  });
  const mcp = createMcpClient({
    baseUrl,
    token,
    hostToken,
    requestJson,
  });
  const skills = createSkillsClient({
    baseUrl,
    token,
    hostToken,
    requestJson,
    validateSearchResponse: validateSkillRegistrySearchResponse,
    timeouts,
  });
  const soul = createSoulClient({
    baseUrl,
    token,
    hostToken,
    requestJson,
    timeoutMs: timeouts.soulMemory,
  });
  const workspace = createWorkspaceClient({
    baseUrl,
    token,
    hostToken,
    requestJson,
    timeouts,
  });
  const conversations = createConversationsClient({
    baseUrl,
    token,
    hostToken,
    accountId,
    requestJson,
    timeouts,
  });
  const files = createFilesClient({
    baseUrl,
    token,
    hostToken,
    requestJson,
    requestMultipartRaw,
    requestBinary,
    createRequestFailedError: (status, message) => new VesloServerError(status, "request_failed", message),
    binaryTimeoutMs: timeouts.binary,
  });
  const extensionsInventory = createExtensionsInventoryClient({
    mcp,
    plugins,
    skills,
    commands,
  });

  return {
    baseUrl,
    token,
    identities,
    automations,
    plugins,
    commands,
    mcp,
    skills,
    soul,
    workspace,
    conversations,
    files,
    extensionsInventory,
    health: workspace.health,
    status: workspace.status,
    capabilities: workspace.capabilities,
    getDocumentRuntimeStatus: () =>
      requestJson<DocumentRuntimeStatusPayload>(baseUrl, "/document-runtime/status", {
        token,
        hostToken,
        timeoutMs: timeouts.status,
      }),
    repairDocumentRuntime: () =>
      requestJson<DocumentRuntimeStatusPayload>(baseUrl, "/document-runtime/repair", {
        method: "POST",
        token,
        hostToken,
        timeoutMs: timeouts.documentRuntime,
      }),
    opencodeRouterHealth: identities.health,
    opencodeRouterBindings: identities.bindings,
    getMyAiAccess: (userToken: string) =>
      requestJson<VesloManagedAiAccessBundle>(baseUrl, "/ai-gateway/me/ai-access", {
        token,
        hostToken,
        timeoutMs: timeouts.aiAccess,
        extraHeaders: buildGatewayCallerHeaders(userToken),
      }),
    opencodeRouterTelegramIdentities: identities.telegramIdentities,
    opencodeRouterSlackIdentities: identities.slackIdentities,
    listWorkspaces: workspace.list,
    listSessionArchives: conversations.listArchives,
    putSessionArchive: conversations.putArchive,
    deleteSessionArchive: conversations.deleteArchive,
    activateWorkspace: workspace.activate,
    addLocalWorkspace: workspace.addLocal,
    deleteWorkspace: workspace.delete,
    deleteSession: conversations.deleteSession,
    listConversations: conversations.list,
    createConversation: conversations.create,
    importConversations: conversations.import,
    runConversation: conversations.run,
    submitConversation: conversations.submit,
    abortConversation: conversations.abort,
    getConversationRunStatus: conversations.getRunStatus,
    getSessionLatestRunArtifacts: conversations.getLatestRunArtifacts,
    prefetchSessionTranscripts: conversations.prefetchTranscripts,
    getSessionTranscript: (workspaceId: string, sessionId: string, limit = 140, directory?: string) =>
      conversations.getTranscript(workspaceId, sessionId, { limit, directory }),
    appendSessionTranscript: conversations.appendTranscript,
    exportWorkspace: workspace.export,
    importWorkspace: workspace.import,
    provisionWorkspaceSystem: workspace.provisionSystem,
    getConfig: workspace.getConfig,
    setOpenCodeRouterTelegramToken: identities.setTelegramToken,
    setOpenCodeRouterSlackTokens: identities.setSlackTokens,
    getOpenCodeRouterTelegram: identities.getTelegram,
    getOpenCodeRouterTelegramIdentities: identities.getTelegramIdentities,
    upsertOpenCodeRouterTelegramIdentity: identities.upsertTelegramIdentity,
    deleteOpenCodeRouterTelegramIdentity: identities.deleteTelegramIdentity,
    getOpenCodeRouterSlackIdentities: identities.getSlackIdentities,
    upsertOpenCodeRouterSlackIdentity: identities.upsertSlackIdentity,
    deleteOpenCodeRouterSlackIdentity: identities.deleteSlackIdentity,
    getOpenCodeRouterBindings: identities.getBindings,
    setOpenCodeRouterBinding: identities.setBinding,
    sendOpenCodeRouterMessage: identities.sendMessage,
    setOpenCodeRouterTelegramEnabled: identities.setTelegramEnabled,
    patchConfig: workspace.patchConfig,
    listReloadEvents: workspace.listReloadEvents,
    reloadEngine: workspace.reloadEngine,
    listPlugins: plugins.list,
    addPlugin: plugins.add,
    removePlugin: plugins.remove,
    listSkills: skills.list,
    listDisabledSkills: skills.listDisabled,
    setSkillEnabledState: skills.setEnabledState,
    resolveSkill: skills.resolve,
    searchRegistrySkills: skills.searchRegistry,
    createRegistrySkill: skills.createRegistrySkill,
    createRegistrySkillVersion: skills.createRegistrySkillVersion,
    createRegistrySkillInstallation: skills.createRegistrySkillInstallation,
    listRegistrySkillVersions: skills.listRegistrySkillVersions,
    updateRegistrySkillInstallation: skills.updateRegistrySkillInstallation,
    deleteRegistrySkillInstallation: skills.deleteRegistrySkillInstallation,
    restoreRegistrySkillInstallation: skills.restoreRegistrySkillInstallation,
    createRegistrySkillReviewRequest: skills.createRegistrySkillReviewRequest,
    replaceRegistryWorkspaceSkillSet: skills.replaceRegistryWorkspaceSkillSet,
    approveRegistrySkillReviewRequest: skills.approveRegistrySkillReviewRequest,
    rejectRegistrySkillReviewRequest: skills.rejectRegistrySkillReviewRequest,
    listRegistrySkillRolloutPolicies: skills.listRegistrySkillRolloutPolicies,
    createRegistrySkillRolloutPolicy: skills.createRegistrySkillRolloutPolicy,
    updateRegistrySkillRolloutPolicy: skills.updateRegistrySkillRolloutPolicy,
    deleteRegistrySkillRolloutPolicy: skills.deleteRegistrySkillRolloutPolicy,
    getGlobalSkillMaterializationStatus: skills.getGlobalMaterializationStatus,
    syncGlobalSkillMaterialization: skills.syncGlobalMaterialization,
    getWorkspaceSkillMaterializationStatus: skills.getWorkspaceMaterializationStatus,
    syncWorkspaceSkillMaterialization: skills.syncWorkspaceMaterialization,
    listUserGlobalSkillStore: skills.listUserGlobalStore,
    getUserGlobalSkillStoreSkill: skills.getUserGlobalStoreSkill,
    upsertUserGlobalSkillStoreSkill: skills.upsertUserGlobalStoreSkill,
    deleteUserGlobalSkillStoreSkill: skills.deleteUserGlobalStoreSkill,
    syncUserGlobalSkillStore: skills.syncUserGlobalStore,
    listHubSkills: skills.listHub,
    listHubMcp: mcp.listHub,
    installHubSkill: skills.installHub,
    installHubMcp: mcp.installHub,
    getSkill: skills.get,
    getSkillFiles: skills.getFiles,
    getGlobalSkillFiles: skills.getGlobalFiles,
    getUserGlobalSkillStoreSkillFiles: skills.getUserGlobalStoreSkillFiles,
    upsertSkill: skills.upsert,
    deleteSkill: skills.delete,
    deleteGlobalSkill: skills.deleteGlobal,
    batchRemoveSkills: skills.batchRemove,
    listSkillRemovals: skills.listRemovals,
    listSkillImportCandidates: skills.listImportCandidates,
    importSkillCandidates: skills.importCandidates,
    restoreSkillRemoval: skills.restoreRemoval,
    listMcp: mcp.list,
    addMcp: mcp.add,
    removeMcp: mcp.remove,
    refreshMcpRuntimeToken: mcp.refreshRuntimeToken,
    logoutMcpAuth: mcp.logoutAuth,

    listCommands: commands.list,
    listAudit: workspace.listAudit,
    upsertCommand: commands.upsert,
    deleteCommand: commands.delete,
    listAutomations: automations.list,
    createAutomation: automations.create,
    updateAutomation: automations.update,
    deleteAutomation: automations.delete,
    runAutomation: automations.run,
    listAutomationRuns: automations.listRuns,
    listScheduledJobs: workspace.listScheduledJobs,
    deleteScheduledJob: workspace.deleteScheduledJob,
    getSoulOverview: soul.overview,
    getOrganizationSoul: soul.getOrganization,
    getUserSoul: soul.getUser,
    listWorkspaceSouls: soul.listWorkspaces,
    getWorkspaceSoul: soul.getWorkspace,
    listSoulVersions: soul.listVersions,
    getSoulVersion: soul.getVersion,
    updateOrganizationSoul: soul.updateOrganization,
    updateUserSoul: soul.updateUser,
    restoreOrganizationSoulVersion: soul.restoreOrganizationVersion,
    restoreUserSoulVersion: soul.restoreUserVersion,
    updateWorkspaceSoul: soul.updateWorkspace,
    restoreWorkspaceSoulVersion: soul.restoreWorkspaceVersion,
    syncWorkspaceSoulMaterialization: soul.syncWorkspaceMaterialization,
    setWorkspaceSoulHeartbeat: soul.setWorkspaceHeartbeat,

    uploadInbox: files.uploadInbox,
    listInbox: files.listInbox,
    downloadInboxItem: files.downloadInboxItem,
    createFileSession: files.createSession,
    renewFileSession: files.renewSession,
    closeFileSession: files.closeSession,
    getFileCatalogSnapshot: files.getCatalogSnapshot,
    listFileSessionEvents: files.listSessionEvents,
    readFileBatch: files.readBatch,
    writeFileBatch: files.writeBatch,
    runFileBatchOps: files.runBatchOps,
    readWorkspaceFile: files.readWorkspaceFile,
    writeWorkspaceFile: files.writeWorkspaceFile,
    listArtifacts: files.listArtifacts,
    downloadArtifact: files.downloadArtifact,
  };
}

export type VesloServerClient = ReturnType<typeof createVesloServerClient>;
