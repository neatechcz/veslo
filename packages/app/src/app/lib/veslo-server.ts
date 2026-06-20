import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { Part, Session } from "@opencode-ai/sdk/v2/client";
import type {
  MessageInfo,
  ModelRef,
  VesloAutomation,
  VesloAutomationCreatePayload,
  VesloAutomationRun,
  VesloAutomationUpdatePayload,
  SkillInventoryRegistryMetadata,
} from "../types";
import type { SessionSendOrigin } from "./session-send-contract";
import { isTauriRuntime } from "../utils";
import type { ScheduledJob } from "./tauri";
import { mergeVesloServerSettingsWithEnv } from "./cloud-policy";
import { fetchWithTimeout } from "./http";
import { wrapStartupRequestAuditFetch } from "./startup-request-audit";

export type VesloServerCapabilities = {
  skills: { read: boolean; write: boolean; source: "veslo" | "opencode" };
  hub?: {
    skills?: {
      read: boolean;
      install: boolean;
    };
    mcp?: {
      read: boolean;
      install: boolean;
    };
  };
  plugins: { read: boolean; write: boolean };
  mcp: { read: boolean; write: boolean };
  commands: { read: boolean; write: boolean };
  config: { read: boolean; write: boolean };
  sandbox?: {
    enabled: boolean;
    backend:
      | "none"
      | "docker"
      | "container"
      | "mac-sandbox-exec"
      | "windows-wsl2"
      | "windows-job-object"
      | "stub";
  };
  proxy?: { opencode: boolean; opencodeRouter: boolean };
  toolProviders?: {
    browser?: {
      enabled: boolean;
      placement: "in-sandbox" | "host-machine" | "client-machine" | "external";
      mode: "none" | "headless" | "interactive";
    };
    files?: {
      injection: boolean;
      outbox: boolean;
      inboxPath: string;
      outboxPath: string;
      maxBytes: number;
    };
  };
};

export type VesloServerStatus = "connected" | "disconnected" | "limited";

export type VesloServerDiagnostics = {
  ok: boolean;
  version: string;
  uptimeMs: number;
  readOnly: boolean;
  approval: { mode: "manual" | "auto"; timeoutMs: number };
  corsOrigins: string[];
  workspaceCount: number;
  activeWorkspaceId: string | null;
  workspace: VesloWorkspaceInfo | null;
  authorizedRoots: string[];
  server: { host: string; port: number; configPath?: string | null };
  tokenSource: { client: string; host: string };
};

export type VesloServerSettings = {
  urlOverride?: string;
  portOverride?: number;
  token?: string;
};

export type VesloWorkspaceInfo = {
  id: string;
  name: string;
  path: string;
  workspaceType: "local" | "remote";
  baseUrl?: string;
  directory?: string;
  opencodeDbPath?: string;
  opencodeDataDir?: string;
  opencodeDataHome?: string;
  opencode?: {
    baseUrl?: string;
    directory?: string;
    dbPath?: string;
    dataDir?: string;
    dataHome?: string;
    xdgDataHome?: string;
    username?: string;
    password?: string;
  };
};

export type VesloWorkspaceList = {
  items: VesloWorkspaceInfo[];
  activeId?: string | null;
};

export type VesloResourceOwner = {
  kind: "workspace" | "user" | "organization" | "platform";
  id: string;
  label?: string;
  root?: string;
};

export type VesloPluginItem = {
  spec: string;
  source: "config" | "dir.project" | "dir.global";
  scope: "project" | "global";
  owner?: VesloResourceOwner;
  path?: string;
};

export type VesloSkillItem = {
  name: string;
  path: string;
  description: string;
  scope: "project" | "global";
  owner?: VesloResourceOwner;
  trigger?: string;
  registry?: SkillInventoryRegistryMetadata;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  aliases?: string[];
  whenToUse?: string;
  paths?: string[];
};

export type VesloSkillContent = {
  item: VesloSkillItem;
  content: string;
};

export type VesloUserGlobalSkillStoreItem = {
  name: string;
  path: string;
  description: string;
  scope: "user-global";
  source: "veslo-user-store";
  owner?: VesloResourceOwner;
  hash: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type VesloUserGlobalSkillStoreContent = {
  item: VesloUserGlobalSkillStoreItem;
  content: string;
};

export type VesloUserGlobalSkillStoreMutationResult = {
  ok: true;
  action?: "added" | "updated";
  item?: VesloUserGlobalSkillStoreItem;
  name?: string;
  path?: string;
  reloadRequired?: boolean;
  trigger?: VesloReloadTrigger & { scope?: "user-global" };
};

export type VesloUserGlobalSkillStoreSyncResult = {
  workspaceId?: string;
  status: "synced" | string;
  synced: boolean;
  reloadRequired: boolean;
  rootDir: string;
  materializedSkills: Array<{
    name: string;
    hash: string;
    skillDir: string;
    materializedAt: string;
  }>;
  removedSkillNames: string[];
  conflicts: Array<{
    code: string;
    name: string;
    message: string;
    localPath?: string;
  }>;
};

export type VesloSkillResolveCandidate = {
  name: string;
  score: number;
  reasons: string[];
  description?: string;
  trigger?: string;
};

export type VesloSkillResolveResult = {
  text: string;
  match: VesloSkillResolveCandidate | null;
  candidates: VesloSkillResolveCandidate[];
};

export type VesloSkillRemovalScope = "workspace" | "user-global";
export type VesloSkillEnabledScope = "workspace" | "user-global" | "organization" | "platform";

export type VesloSkillRemovalItem = {
  id: string;
  name: string;
  scope: VesloSkillRemovalScope;
  workspaceId?: string;
  path: string;
  reason?: string;
  status: "removed" | "restored";
  removedAt: string;
  restoredAt?: string;
  canRestore: boolean;
};

export type VesloSkillRemovalsResponse = {
  items: VesloSkillRemovalItem[];
};

export type VesloSkillEnabledRegistryIdentity = {
  skillId?: string;
  installationId?: string;
  policyId?: string;
  versionId?: string;
  source?: "personal" | "workspace" | "organization" | "platform";
};

export type VesloSkillEnabledTarget = {
  name: string;
  scope: VesloSkillEnabledScope;
  workspaceId?: string;
  path?: string;
  registry?: VesloSkillEnabledRegistryIdentity;
};

export type VesloDisabledSkillRecord = VesloSkillEnabledTarget & {
  id: string;
  disabledAt: string;
  disabledBy?: string;
};

export type VesloDisabledSkillsResponse = {
  items: VesloDisabledSkillRecord[];
};

export type VesloSkillEnabledStateResponse = {
  ok: true;
  enabled: boolean;
  record?: VesloDisabledSkillRecord;
};

export type VesloSkillRemovalMutationResult = {
  ok: true;
  name?: string;
  path: string;
  removalId?: string;
  reloadRequired?: boolean;
  trigger?: VesloReloadTrigger & { scope?: VesloSkillRemovalScope };
};

export type VesloSkillBatchRemoveScope = VesloSkillRemovalScope | "organization";

export type VesloSkillBatchRemoveItem = {
  id?: string;
  name: string;
  scope: VesloSkillBatchRemoveScope;
  path?: string;
  workspaceId?: string;
  reason?: string;
  registry?: {
    installationId?: string;
    policyId?: string;
  };
};

export type VesloSkillBatchRemoveRequest = {
  items: VesloSkillBatchRemoveItem[];
  denApiBase?: string;
  denToken?: string;
  denOrgId?: string;
  denUserId?: string;
};

export type VesloSkillBatchRemoveSuccess = {
  id?: string;
  index: number;
  ok: true;
  name: string;
  scope: VesloSkillBatchRemoveScope;
  path?: string;
  removalId?: string;
  reloadRequired?: boolean;
  registry?: {
    installationId?: string;
    policyId?: string;
  };
  trigger?: VesloReloadTrigger & { scope?: VesloSkillBatchRemoveScope };
};

export type VesloSkillBatchRemoveFailure = {
  id?: string;
  index: number;
  ok: false;
  name?: string;
  scope?: string;
  code: string;
  message: string;
  status: number;
  details?: unknown;
};

export type VesloSkillBatchRemoveResponse = {
  ok: boolean;
  succeeded: number;
  failed: number;
  results: Array<VesloSkillBatchRemoveSuccess | VesloSkillBatchRemoveFailure>;
};

export type VesloHubSkillItem = {
  name: string;
  description: string;
  trigger?: string;
  source: {
    owner: string;
    repo: string;
    ref: string;
    path: string;
  };
};

export type VesloHubMcpOAuthConfig =
  | boolean
  | {
      clientId: string;
      clientSecret?: string;
      scope?: string;
    };

export type VesloHubMcpAuthorization = {
  type: "veslo-server-oauth";
  provider: string;
  connectorId: string;
  scopes: string[];
  startPath: string;
  runtimeTokenPath: string;
  statusPath: string;
  disconnectPath: string;
};

export type VesloHubMcpItem = {
  id: string;
  name: string;
  description?: string;
  config: {
    type: "remote" | "local";
    url?: string;
    command?: string[];
    oauth?: VesloHubMcpOAuthConfig;
    headers?: Record<string, string>;
  };
  authorization?: VesloHubMcpAuthorization;
  source:
    | {
        scope: "org";
        orgId: string;
      }
    | {
        scope: "platform";
      };
  provider?: {
    id: string;
    group?: string;
  };
};

export type VesloSkillRegistryOwnerScope = "user" | "workspace" | "org" | "system";
export type VesloSkillRegistryVisibility = "personal" | "workspace" | "organization" | "platform";
export type VesloSkillRegistryReviewStatus = "draft" | "pending_review" | "approved" | "rejected";
export type VesloSkillRegistryUpdatePolicy = "pinned" | "latest_user" | "latest_approved" | "release_channel";
export type VesloSkillRegistryRolloutTarget = "user-global" | "workspace";
export type VesloSkillRegistryRolloutAudience =
  | "user"
  | "selected-workspaces"
  | "all-org-users"
  | "all-platform-users";
export type VesloSkillRegistryRolloutCatalogScope = "organization" | "platform";
export type VesloSkillRegistryRolloutRemovalPolicy = "user_removable" | "admin_removable" | "locked";

export type VesloSkillRegistryVersionSummary = {
  id: string;
  version: string;
  packageSha256: string;
  createdAt: string;
};

export type VesloSkillRegistrySearchSkill = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  tags?: string[];
  visibility: VesloSkillRegistryVisibility;
  reviewStatus: VesloSkillRegistryReviewStatus;
  createdAt: string;
  updatedAt: string;
  latestVersion?: VesloSkillRegistryVersionSummary;
  score?: number;
  matchedFields?: string[];
};

export type VesloSkillRegistrySearchResponse = {
  query: string;
  skills: VesloSkillRegistrySearchSkill[];
  nextCursor?: string | null;
};

export type VesloSkillRegistrySkillResponse = {
  skill: VesloSkillRegistrySearchSkill;
};

export type VesloSkillRegistryVersionResponse = {
  version: VesloSkillRegistryVersionSummary;
};

export type VesloSkillRegistryVersionsResponse = {
  versions: VesloSkillRegistryVersionSummary[];
  nextCursor?: string | null;
};

export type VesloManagedSkillSource = "personal" | "workspace" | "organization" | "platform";

export type VesloSkillRegistryInstallation = {
  installationId: string;
  skillId: string;
  versionId: string;
  enabled: boolean;
  source: VesloManagedSkillSource;
  installedAt: string;
  updatedAt?: string;
  name?: string;
  packageSha256?: string;
  ownerUserId?: string | null;
  orgId?: string | null;
  workspaceId?: string | null;
  approved?: boolean;
  desiredVersionId?: string | null;
  desiredPackageSha256?: string | null;
};

export type VesloSkillRegistryInstallationResponse = {
  installation: VesloSkillRegistryInstallation;
};

export type VesloSkillRegistryReviewRequestResponse = {
  requestId: string;
  skillId: string;
  status: Extract<VesloSkillRegistryReviewStatus, "pending_review" | "approved" | "rejected">;
  createdAt: string;
  updatedAt?: string;
};

export type VesloSkillRegistryWorkspaceSkillSetResponse = {
  workspaceId: string;
  skillSetId?: string;
  revision?: string;
  skills: VesloSkillRegistryInstallation[];
};

export type VesloSkillRegistryRolloutPolicy = {
  id: string;
  skillId: string;
  versionId: string | null;
  target: VesloSkillRegistryRolloutTarget;
  audience: VesloSkillRegistryRolloutAudience;
  catalogScope: VesloSkillRegistryRolloutCatalogScope;
  orgId?: string | null;
  userId?: string | null;
  workspaceId?: string | null;
  enabled: boolean;
  updatePolicy: VesloSkillRegistryUpdatePolicy;
  releaseChannel?: string | null;
  removalPolicy: VesloSkillRegistryRolloutRemovalPolicy;
  createdAt: string;
  updatedAt?: string;
};

export type VesloSkillRegistryRolloutPolicyResponse = {
  policy: VesloSkillRegistryRolloutPolicy;
};

export type VesloSkillRegistryRolloutPoliciesResponse = {
  policies: VesloSkillRegistryRolloutPolicy[];
  nextCursor?: string | null;
};

export type VesloSkillRegistrySearchParams = {
  q: string;
  workspaceId?: string;
  scope?: VesloSkillRegistryOwnerScope;
  owner?: VesloSkillRegistryOwnerScope;
  ownerScope?: VesloSkillRegistryOwnerScope;
  approvalStatus?: VesloSkillRegistryReviewStatus;
  reviewStatus?: VesloSkillRegistryReviewStatus;
  includeDeleted?: boolean;
  language?: string;
  cursor?: string;
  limit?: number;
};

export type VesloSkillRegistryCreateSkillInput = VesloSkillRegistryAuthContext & {
  scope: VesloSkillRegistryOwnerScope;
  name: string;
  displayName?: string;
  description?: string;
  orgId?: string;
  workspaceId?: string;
};

export type VesloSkillRegistryCreateVersionInput = VesloSkillRegistryAuthContext & {
  package: Record<string, unknown>;
};

export type VesloSkillRegistryCreateInstallationInput = VesloSkillRegistryAuthContext & {
  scope: VesloSkillRegistryOwnerScope;
  skillId: string;
  versionId: string;
  orgId?: string;
  ownerUserId?: string;
  workspaceId?: string;
  updatePolicy?: VesloSkillRegistryUpdatePolicy | string;
  releaseChannel?: string;
};

export type VesloSkillRegistryListRolloutPoliciesInput = VesloSkillRegistryAuthContext & {
  cursor?: string;
  limit?: number;
  target?: VesloSkillRegistryRolloutTarget;
  audience?: VesloSkillRegistryRolloutAudience;
  workspaceId?: string;
};

export type VesloSkillRegistryCreateRolloutPolicyInput = VesloSkillRegistryAuthContext & {
  skillId: string;
  versionId?: string | null;
  target: VesloSkillRegistryRolloutTarget;
  audience: VesloSkillRegistryRolloutAudience;
  catalogScope: VesloSkillRegistryRolloutCatalogScope;
  orgId?: string | null;
  userId?: string | null;
  workspaceId?: string | null;
  enabled?: boolean;
  updatePolicy: VesloSkillRegistryUpdatePolicy;
  releaseChannel?: string | null;
  removalPolicy: VesloSkillRegistryRolloutRemovalPolicy;
};

export type VesloSkillRegistryListVersionsInput = VesloSkillRegistryAuthContext & {
  cursor?: string;
  limit?: number;
};

export type VesloSkillRegistryUpdateInstallationInput = VesloSkillRegistryAuthContext & {
  enabled?: boolean;
  versionId?: string | null;
  updatePolicy?: VesloSkillRegistryUpdatePolicy | string;
  releaseChannel?: string | null;
};

export type VesloSkillRegistryUpdateRolloutPolicyInput = VesloSkillRegistryAuthContext & {
  skillId?: string;
  versionId?: string | null;
  target?: VesloSkillRegistryRolloutTarget;
  audience?: VesloSkillRegistryRolloutAudience;
  catalogScope?: VesloSkillRegistryRolloutCatalogScope;
  orgId?: string | null;
  userId?: string | null;
  workspaceId?: string | null;
  enabled?: boolean;
  updatePolicy?: VesloSkillRegistryUpdatePolicy;
  releaseChannel?: string | null;
  removalPolicy?: VesloSkillRegistryRolloutRemovalPolicy;
};

export type VesloSkillRegistryRestoreInstallationInput = VesloSkillRegistryAuthContext & {
  orgId?: string | null;
  ownerUserId?: string | null;
  workspaceId?: string | null;
  versionId?: string | null;
};

export type VesloSkillRegistryCreateReviewRequestInput = VesloSkillRegistryAuthContext & {
  scope: Extract<VesloSkillRegistryOwnerScope, "org" | "system">;
  versionId: string;
  orgId?: string;
  reason?: string;
  releaseChannel?: string;
};

export type VesloSkillRegistryReplaceWorkspaceSkillSetInput = VesloSkillRegistryAuthContext & {
  orgId?: string;
  releaseChannel?: string;
  skills: Array<{
    installationId: string;
    desiredVersionId?: string | null;
    releaseChannel?: string | null;
  }>;
};

export type VesloSkillRegistryReviewDecisionInput = VesloSkillRegistryAuthContext & {
  reviewerNote?: string;
  releaseChannel?: string;
};

export type VesloSkillMaterializationEntry = {
  installationId?: string;
  skillId?: string;
  name: string;
  versionId?: string;
  packageSha256: string;
  source?: VesloManagedSkillSource;
  removalPolicy?: VesloSkillRegistryRolloutRemovalPolicy;
  target?: "workspace" | "personal-global";
  owner?: VesloResourceOwner;
  skillDir?: string;
  materializedAt?: string;
};

export type VesloSkillMaterializationConflict = {
  code: "personal-global-shadowed" | "unmanaged-local-shadowed" | "target-conflict" | string;
  name: string;
  message: string;
  blockingInstallationId?: string;
  blockedInstallationId?: string;
  localPath?: string;
};

export type VesloSkillMaterializationStatus = {
  workspaceId: string;
  status: "not-configured" | "pending" | "current" | "synced" | string;
  registryConfigured: boolean;
  rootDir?: string;
  materializedSkills: VesloSkillMaterializationEntry[];
  conflicts?: VesloSkillMaterializationConflict[];
  reloadRequired?: boolean;
  synced?: boolean;
};

export type VesloGlobalSkillMaterializationStatus = Omit<VesloSkillMaterializationStatus, "workspaceId"> & {
  scope: "personal-global";
  platformManaged?: {
    enabled: boolean;
    synced: boolean;
    desiredSkills: VesloSkillMaterializationEntry[];
  };
};

export type VesloSkillMaterializationSyncOptions = {
  activeRun?: boolean;
};

export type VesloSkillRegistryAuthContext = {
  denApiBase?: string;
  denToken?: string;
  denOrgId?: string;
  denUserId?: string;
};

export type VesloSkillMaterializationRequestOptions =
  VesloSkillMaterializationSyncOptions & VesloSkillRegistryAuthContext;

export type VesloSkillMaterializationSyncResult = VesloSkillMaterializationStatus & {
  synced: boolean;
  removedSkillNames?: string[];
  backupDirs?: string[];
  globalRootDir?: string;
};

export type VesloGlobalSkillMaterializationSyncResult = VesloGlobalSkillMaterializationStatus & {
  synced: boolean;
  removedSkillNames?: string[];
  backupDirs?: string[];
};

export type VesloWorkspaceFileContent = {
  path: string;
  content: string;
  bytes: number;
  updatedAt: number;
};

export type VesloWorkspaceFileWriteResult = {
  ok: boolean;
  path: string;
  bytes: number;
  updatedAt: number;
  revision?: string;
};

export type VesloFileSession = {
  id: string;
  workspaceId: string;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
  canWrite: boolean;
};

export type VesloFileCatalogEntry = {
  path: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
  revision: string;
};

export type VesloFileSessionEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  type: "write" | "delete" | "rename" | "mkdir";
  path: string;
  toPath?: string;
  revision?: string;
  timestamp: number;
};

export type VesloFileReadBatchResult = {
  items: Array<
    | {
        ok: true;
        path: string;
        kind: "file";
        bytes: number;
        updatedAt: number;
        revision: string;
        contentBase64: string;
      }
    | {
        ok: false;
        path: string;
        code: string;
        message: string;
        maxBytes?: number;
        size?: number;
      }
  >;
};

export type VesloFileWriteBatchResult = {
  items: Array<
    | {
        ok: true;
        path: string;
        bytes: number;
        updatedAt: number;
        revision: string;
        previousRevision?: string | null;
      }
    | {
        ok: false;
        path: string;
        code: string;
        message: string;
        expectedRevision?: string;
        currentRevision?: string | null;
        maxBytes?: number;
        size?: number;
      }
  >;
  cursor: number;
};

export type VesloFileOpsBatchResult = {
  items: Array<Record<string, unknown>>;
  cursor: number;
};

export type VesloCommandItem = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string | null;
  subtask?: boolean;
  scope: "workspace" | "global";
  owner?: VesloResourceOwner;
};

export type VesloMcpItem = {
  name: string;
  config: Record<string, unknown>;
  source: "config.project" | "config.global" | "config.remote";
  owner?: VesloResourceOwner;
  disabledByTools?: boolean;
};

export type VesloOpenCodeRouterTelegramResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  telegram?: {
    configured: boolean;
    enabled: boolean;
    applied?: boolean;
    starting?: boolean;
    error?: string;
  };
};

export type VesloOpenCodeRouterSlackResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  slack?: {
    configured: boolean;
    enabled: boolean;
    applied?: boolean;
    starting?: boolean;
    error?: string;
  };
};

export type VesloOpenCodeRouterTelegramBotInfo = {
  id: number;
  username?: string;
  name?: string;
};

export type VesloOpenCodeRouterTelegramInfo = {
  ok: boolean;
  configured: boolean;
  enabled: boolean;
  bot: VesloOpenCodeRouterTelegramBotInfo | null;
};

export type VesloOpenCodeRouterTelegramEnabledResult = {
  ok: boolean;
  persisted?: boolean;
  enabled: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
};

export type VesloOpenCodeRouterHealthSnapshot = {
  ok: boolean;
  opencode: {
    url: string;
    healthy: boolean;
    version?: string;
  };
  channels: {
    telegram: boolean;
    whatsapp: boolean;
    slack: boolean;
  };
  config: {
    groupsEnabled: boolean;
  };
  activity?: {
    dayStart: number;
    inboundToday: number;
    outboundToday: number;
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastMessageAt?: number;
  };
  agent?: {
    scope: "workspace";
    path: string;
    loaded: boolean;
    selected?: string;
  };
};

export type VesloOpenCodeRouterBindingItem = {
  channel: string;
  identityId: string;
  peerId: string;
  directory: string;
  updatedAt?: number;
};

export type VesloOpenCodeRouterBindingsResult = {
  ok: boolean;
  items: VesloOpenCodeRouterBindingItem[];
};

export type VesloOpenCodeRouterBindingUpdateResult = {
  ok: boolean;
};

export type VesloOpenCodeRouterSendResult = {
  ok: boolean;
  channel: string;
  identityId?: string;
  directory: string;
  peerId?: string;
  attempted: number;
  sent: number;
  failures?: Array<{ identityId: string; peerId: string; error: string }>;
  reason?: string;
};

export type VesloOpenCodeRouterIdentityItem = {
  id: string;
  enabled: boolean;
  running: boolean;
  access?: "public" | "private";
  pairingRequired?: boolean;
};

export type VesloOpenCodeRouterTelegramIdentitiesResult = {
  ok: boolean;
  items: VesloOpenCodeRouterIdentityItem[];
};

export type VesloOpenCodeRouterSlackIdentitiesResult = {
  ok: boolean;
  items: VesloOpenCodeRouterIdentityItem[];
};

export type VesloOpenCodeRouterTelegramIdentityUpsertResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  telegram?: {
    id: string;
    enabled: boolean;
    access?: "public" | "private";
    pairingRequired?: boolean;
    pairingCode?: string;
    applied?: boolean;
    starting?: boolean;
    error?: string;
    bot?: VesloOpenCodeRouterTelegramBotInfo | null;
  };
};

export type VesloOpenCodeRouterSlackIdentityUpsertResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  slack?: {
    id: string;
    enabled: boolean;
    applied?: boolean;
    starting?: boolean;
    error?: string;
  };
};

export type VesloOpenCodeRouterTelegramIdentityDeleteResult = {
  ok: boolean;
  persisted?: boolean;
  deleted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  telegram?: {
    id: string;
    deleted: boolean;
  };
};

export type VesloOpenCodeRouterSlackIdentityDeleteResult = {
  ok: boolean;
  persisted?: boolean;
  deleted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  slack?: {
    id: string;
    deleted: boolean;
  };
};

export type VesloWorkspaceExport = {
  workspaceId: string;
  exportedAt: number;
  opencode?: Record<string, unknown>;
  veslo?: Record<string, unknown>;
  skills?: Array<{ name: string; description?: string; trigger?: string; content: string }>;
  commands?: Array<{ name: string; description?: string; template?: string }>;
};

export type VesloSessionArchiveRecord = {
  sessionId: string;
  archivedAt: number;
  titleSnapshot: string;
  workspaceIdAtArchive?: string;
  workspaceLabelSnapshot?: string;
  resolvedDirectoryAtArchive?: string;
  projectRootAtArchive?: string;
  projectLabelSnapshot?: string;
  parentSessionId?: string | null;
  createdAtSnapshot?: number | null;
  updatedAtSnapshot?: number | null;
  workspaceIdentity?: string;
};

export type VesloArtifactItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  createdAt?: number;
  updatedAt?: number;
  mime?: string;
};

export type VesloArtifactList = {
  items: VesloArtifactItem[];
};

export type VesloSessionArtifactFamily = "files" | "skills" | "mcp" | "soul";

export type VesloSessionArtifactKind =
  | "file_output"
  | "file_discovered"
  | "skill_used"
  | "mcp_used"
  | "soul_memory_used"
  | "heartbeat_used";

export type VesloSessionArtifactStatus = "scanned" | "updated" | "created" | "exported" | "used" | "active";

export type VesloSessionArtifactItem = {
  id: string;
  sessionId: string;
  workspaceId: string;
  runId: string;
  family: VesloSessionArtifactFamily;
  kind: VesloSessionArtifactKind;
  status: VesloSessionArtifactStatus;
  title: string;
  subtitle?: string;
  path?: string;
  sourceName?: string;
  messageId?: string;
  partId?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
};

export type VesloSessionLatestRunArtifacts = {
  sessionId: string;
  workspaceId: string;
  runId: string | null;
  items: VesloSessionArtifactItem[];
};

export type VesloSessionTranscriptSnapshot = {
  workspaceId: string;
  sessionId: string;
  directory?: string;
  conversationId?: string;
  opencodeSessionId?: string;
  limit: number;
  messages: MessageInfo[];
  partsByMessageId: Record<string, Part[]>;
  fetchedAt?: number;
  staleAt?: number;
  source?: "sqlite" | "unavailable";
};

export type VesloSessionTranscriptPrefetchInput = {
  clickedSessionId?: string | null;
  selectedSessionId?: string | null;
  loadedTopLevelSessionIds: string[];
  expandedSubagentSessionIds: string[];
  directory?: string | null;
  sessionDirectoriesById?: Record<string, string | null | undefined>;
  limit?: number;
};

export type VesloSessionTranscriptPrefetchResult = {
  workspaceId: string;
  queuedSessionIds: string[];
  items: VesloSessionTranscriptSnapshot[];
};

export type VesloSessionTranscriptAppendInput = {
  directory?: string | null;
  limit?: number;
  messages: MessageInfo[];
  partsByMessageId: Record<string, Part[]>;
  deletedMessageIds?: string[];
  deletedPartsByMessageId?: Record<string, string[]>;
};

export type VesloConversationList = {
  workspaceId: string;
  items: Array<Session & {
    conversationId?: string;
    opencodeSessionId?: string;
    parentConversationId?: string | null;
    branchId?: string | null;
  }>;
  source?: "sqlite" | "unavailable";
};

export type VesloConversationCreateResult = Session & {
  workspaceId: string;
  conversationId: string;
  opencodeSessionId: string;
  parentConversationId?: string | null;
  branchId?: string | null;
};

export type VesloConversationImportInput = {
  directory?: string | null;
  sessions: Array<Pick<Session, "id" | "title" | "parentID" | "time">>;
};

export type VesloConversationImportResult = {
  workspaceId: string;
  items: Array<Session & {
    conversationId?: string;
    opencodeSessionId?: string;
    parentConversationId?: string | null;
    branchId?: string | null;
  }>;
};

export type VesloConversationRunKind = "prompt_async" | "command" | "shell" | "summarize";

export type VesloConversationRunInput = {
  kind: VesloConversationRunKind;
  directory?: string | null;
  clientMessageId?: string | null;
  origin?: SessionSendOrigin | string | null;
  expectAiGatewayStart?: boolean;
  sessionID?: string;
  messageID?: string;
  model?: ModelRef | string;
  agent?: string;
  variant?: string;
  parts?: unknown[];
  system?: string;
  command?: string;
  arguments?: string;
  reasoning_effort?: string;
  noReply?: boolean;
  tools?: unknown;
  providerID?: string;
  modelID?: string;
  auto?: boolean;
};

export type VesloConversationRunDebugTraceEntry = {
  source: string;
  event: string;
  traceId?: string | null;
  durationMs?: number;
  [key: string]: unknown;
};

export type VesloConversationRunSubmittedResult = {
  ok: boolean;
  workspaceId: string;
  conversationId: string;
  opencodeSessionId: string;
  runId: string;
  clientMessageId?: string | null;
  origin?: string | null;
  status: "submitted";
  kind: VesloConversationRunKind;
  upstream?: unknown;
  debugTrace?: VesloConversationRunDebugTraceEntry[];
};

export type VesloConversationRunQueuedResult = {
  ok: boolean;
  workspaceId: string;
  conversationId: string;
  opencodeSessionId: string;
  runId?: string;
  reservedRunId: string;
  queueItemId: string;
  activeRunId?: string | null;
  queuePosition: number;
  clientMessageId?: string | null;
  origin?: string | null;
  status: "queued";
  kind: VesloConversationRunKind;
  debugTrace?: VesloConversationRunDebugTraceEntry[];
};

export type VesloConversationRunResult = VesloConversationRunSubmittedResult | VesloConversationRunQueuedResult;

export type VesloConversationAbortResult = {
  ok: boolean;
  workspaceId: string;
  conversationId: string;
  opencodeSessionId: string;
  runId: string;
  status: "submitted";
  kind: "abort";
  upstream?: unknown;
};

export type VesloInboxItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  updatedAt?: number;
};

export type VesloInboxList = {
  items: VesloInboxItem[];
};

export type VesloInboxUploadResult = {
  ok: boolean;
  path: string;
  bytes: number;
};

export type VesloSoulHeartbeatEntry = {
  id: string;
  ts: string | null;
  workspace: string | null;
  summary: string;
  looseEnds: string[];
  nextAction: string | null;
};

export type VesloSoulStatus = {
  enabled: boolean;
  state: "off" | "healthy" | "stale" | "error";
  memoryEnabled: boolean;
  instructionsEnabled: boolean;
  heartbeatLogExists: boolean;
  heartbeatCommandExists: boolean;
  heartbeatJob: {
    name: string;
    slug: string;
    schedule: string;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    lastRunError: string | null;
  } | null;
  heartbeatCount: number;
  lastHeartbeatAt: string | null;
  lastHeartbeatSummary: string | null;
  staleAfterMs: number | null;
  overdue: boolean;
  summary: string;
  memoryPath: string;
  heartbeatPath: string;
};

export type VesloSoulScope = "organization" | "user" | "workspace";
export type VesloSoulVersionSource = "manual" | "api" | "heartbeat" | "restore" | "system";

export type VesloSoulVersion = {
  id: string;
  content: string;
  changeSummary: string;
  createdAt: string;
  createdBy: string;
  source: VesloSoulVersionSource;
  baseVersionId: string | null;
  restoreSourceVersionId: string | null;
};

export type VesloSoulDocument = {
  id: string;
  scope: VesloSoulScope;
  ownerId: string;
  currentVersionId: string | null;
  heartbeatEnabled: boolean;
  versions: VesloSoulVersion[];
};

export type VesloSoulSummary = {
  scope: VesloSoulScope;
  ownerId: string;
  owner: VesloResourceOwner;
  title: string;
  currentVersionId: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  status: "active" | "pending" | "conflict" | "not_configured" | string;
  heartbeatEnabled: boolean;
  pendingSuggestionCount: number;
  canEdit: boolean;
};

export type VesloSoulMaterializationConflict = {
  path: string;
  relativePath: string;
  reason: "unmanaged_target_exists" | "managed_target_modified" | "managed_target_missing" | string;
};

export type VesloSoulMaterializationFile = {
  path: string;
  scope: VesloSoulScope;
  ownerId: string | null;
  owner?: VesloResourceOwner | null;
  documentId: string | null;
  currentVersionId: string | null;
  sourceVersionId: string | null;
  contentSha256: string;
  managedBy: string;
  materializedAt: string;
  absolutePath?: string;
};

export type VesloSoulMaterializationResult =
  | {
      ok: true;
      status: "current" | string;
      workspaceRoot: string;
      effectiveContent: string;
      manifestPath: string;
      instructionsPath: string;
      files: VesloSoulMaterializationFile[];
      pending: boolean;
      reloadRequired: boolean;
      manualSyncRequired: false;
      requiresAction?: never;
    }
  | {
      ok: false;
      reason: "conflict" | "config_error" | "manifest_error" | "write_error" | string;
      message: string;
      path?: string;
      conflicts?: VesloSoulMaterializationConflict[];
      pending: boolean;
      manualSyncRequired: false;
      requiresAction:
        | "preserve_unmanaged_soul_file"
        | "restore_managed_soul_file"
        | "fix_opencode_config"
        | "fix_soul_manifest"
        | "inspect_materialization_error"
        | string;
    };

export type VesloSoulConfiguredMaterializationResult = {
  ok: boolean;
  pending: boolean;
  manualSyncRequired: false;
  workspaces: Array<{ workspaceId: string; result: VesloSoulMaterializationResult }>;
};

export type VesloSoulAnyMaterializationResult =
  | VesloSoulMaterializationResult
  | VesloSoulConfiguredMaterializationResult;

export type VesloSoulReadResponse = {
  document: VesloSoulDocument | null;
  summary: VesloSoulSummary;
  materialization?: VesloSoulAnyMaterializationResult;
  pendingEdits?: unknown[];
  denSynced?: boolean;
};

export type VesloSoulOverviewResponse = {
  organization: VesloSoulSummary;
  user: VesloSoulSummary;
  workspaces: VesloSoulSummary[];
};

export type VesloWorkspaceSoulsResponse = {
  workspaces: VesloSoulSummary[];
};

export type VesloSoulVersionsResponse = {
  versions: VesloSoulVersion[];
  nextCursor?: string | null;
  denSynced?: boolean;
};

export type VesloSoulVersionResponse = {
  version: VesloSoulVersion;
  denSynced?: boolean;
};

export type VesloSoulAuthContext = VesloSkillRegistryAuthContext;

export type VesloSoulVersionListOptions = VesloSoulAuthContext & {
  workspaceId?: string;
  cursor?: string;
  limit?: number;
};

export type VesloSoulVersionGetOptions = VesloSoulAuthContext & {
  workspaceId?: string;
};

export type VesloSoulUpdateInput = VesloSoulAuthContext & {
  content: string;
  changeSummary: string;
  baseVersionId: string | null;
  activeWorkspaceIds?: string[];
};

export type VesloSoulRestoreInput = VesloSoulAuthContext & {
  changeSummary?: string;
  activeWorkspaceIds?: string[];
  activeRun?: boolean;
};

export type VesloWorkspaceSystemProvisionResult = {
  ok: boolean;
  workspaceId: string;
  version: string;
  status: "updated" | "unchanged";
  written: number;
  unchanged: number;
};

type RawJsonResponse<T> = {
  ok: boolean;
  status: number;
  json: T | null;
};

export type VesloActor = {
  type: "remote" | "host";
  clientId?: string;
  tokenHash?: string;
};

export type VesloAuditEntry = {
  id: string;
  workspaceId: string;
  actor: VesloActor;
  action: string;
  target: string;
  summary: string;
  timestamp: number;
};

export type VesloReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp" | "agent" | "command";
  name?: string;
  action?: "added" | "removed" | "updated";
  path?: string;
};

export type VesloReloadEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  reason: "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";
  trigger?: VesloReloadTrigger;
  timestamp: number;
};

export type VesloGatewayProvider = "openai" | "anthropic" | "codex_oauth" | "openai_compatible";

export type VesloUserAiAccess = {
  id: string;
  userId: string;
  enabled: boolean;
  provider: VesloGatewayProvider | null;
  defaultModel: string | null;
  allowedModels: string[];
  updatedAt: string | null;
};

export type VesloUserAiAccessResult = {
  aiAccess: VesloUserAiAccess | null;
};

export type VesloManagedAiAccessBundle = {
  accessToken?: string | null;
  aiAccess: VesloUserAiAccess | null;
};

export const DEFAULT_VESLO_SERVER_PORT = 8787;

const STORAGE_URL_OVERRIDE = "veslo.server.urlOverride";
const STORAGE_PORT_OVERRIDE = "veslo.server.port";
const STORAGE_TOKEN = "veslo.server.token";
const LEGACY_STORAGE_URL_OVERRIDE = "openwork.server.urlOverride";
const LEGACY_STORAGE_PORT_OVERRIDE = "openwork.server.port";
const LEGACY_STORAGE_TOKEN = "openwork.server.token";

export function normalizeVesloServerUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export const LOCAL_SESSION_ARCHIVE_OWNER_KEY = "local:desktop";

function isLoopbackVesloServerUrl(input: string) {
  try {
    const parsed = new URL(input);
    const hostname = parsed.hostname.trim().toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

export function resolveSessionArchiveClientOptions(options: {
  accountId?: string | null;
  activeBaseUrl?: string | null;
  activeToken?: string | null;
  settingsUrl?: string | null;
  settingsToken?: string | null;
  cloudUrl?: string | null;
  cloudToken?: string | null;
}) {
  const accountId = options.accountId?.trim() ?? "";

  const candidates = [
    {
      baseUrl: normalizeVesloServerUrl(options.activeBaseUrl ?? ""),
      token: options.activeToken?.trim() ?? "",
    },
    {
      baseUrl: normalizeVesloServerUrl(options.settingsUrl ?? ""),
      token: options.settingsToken?.trim() ?? "",
    },
    {
      baseUrl: normalizeVesloServerUrl(options.cloudUrl ?? ""),
      token: options.cloudToken?.trim() ?? "",
    },
  ];

  for (const candidate of candidates) {
    if (!candidate.baseUrl || !candidate.token) continue;
    const ownerKey = accountId || (isLoopbackVesloServerUrl(candidate.baseUrl) ? LOCAL_SESSION_ARCHIVE_OWNER_KEY : "");
    if (!ownerKey) return null;
    return {
      baseUrl: candidate.baseUrl,
      token: candidate.token,
      accountId: ownerKey,
    };
  }

  return null;
}

function isLikelyLocalHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") {
    return true;
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
    const octets = normalized.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
      return false;
    }
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  return normalized.endsWith(".local");
}

export function deriveLocalVesloServerUrlFromOpencodeBaseUrl(
  opencodeBaseUrl: string,
  port: number = DEFAULT_VESLO_SERVER_PORT,
) {
  const trimmed = opencodeBaseUrl.trim();
  if (!trimmed) return null;
  if (!Number.isFinite(port) || port <= 0) return null;

  try {
    const parsed = new URL(trimmed);
    if (!isLikelyLocalHostname(parsed.hostname)) {
      return null;
    }
    parsed.port = String(port);
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.origin;
  } catch {
    return null;
  }
}

export function parseVesloWorkspaceIdFromUrl(input: string) {
  const normalized = normalizeVesloServerUrl(input) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    const prev = segments[segments.length - 2] ?? "";
    if (prev !== "w" || !last) return null;
    return decodeURIComponent(last);
  } catch {
    const match = normalized.match(/\/w\/([^/?#]+)/);
    if (!match?.[1]) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
}

export function buildVesloWorkspaceBaseUrl(hostUrl: string, workspaceId?: string | null) {
  const normalized = normalizeVesloServerUrl(hostUrl) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    const prev = segments[segments.length - 2] ?? "";
    const alreadyMounted = prev === "w" && Boolean(last);
    if (alreadyMounted) {
      return url.toString().replace(/\/+$/, "");
    }

    const id = (workspaceId ?? "").trim();
    if (!id) return url.toString().replace(/\/+$/, "");

    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/w/${encodeURIComponent(id)}`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    const id = (workspaceId ?? "").trim();
    if (!id) return normalized;
    return `${normalized.replace(/\/+$/, "")}/w/${encodeURIComponent(id)}`;
  }
}

export const DEFAULT_VESLO_CONNECT_APP_URL = "https://app.veslo.work";

const VESLO_INVITE_PARAM_URL = "veslo_url";
const VESLO_INVITE_PARAM_TOKEN = "veslo_token";
const VESLO_INVITE_PARAM_STARTUP = "veslo_startup";
const VESLO_INVITE_PARAM_BUNDLE = "veslo_bundle";
const VESLO_INVITE_PARAM_BUNDLE_INTENT = "veslo_intent";
const VESLO_INVITE_PARAM_BUNDLE_SOURCE = "veslo_source";
const VESLO_INVITE_PARAM_BUNDLE_ORG = "veslo_org";
const VESLO_INVITE_PARAM_BUNDLE_LABEL = "veslo_label";

const LEGACY_INVITE_PARAM_URL = "ow_url";
const LEGACY_INVITE_PARAM_TOKEN = "ow_token";
const LEGACY_INVITE_PARAM_STARTUP = "ow_startup";
const LEGACY_INVITE_PARAM_BUNDLE = "ow_bundle";
const LEGACY_INVITE_PARAM_BUNDLE_INTENT = "ow_intent";
const LEGACY_INVITE_PARAM_BUNDLE_SOURCE = "ow_source";
const LEGACY_INVITE_PARAM_BUNDLE_ORG = "ow_org";
const LEGACY_INVITE_PARAM_BUNDLE_LABEL = "ow_label";

export type VesloConnectInvite = {
  url: string;
  token?: string;
  startup?: "server";
};

export type VesloBundleInviteIntent = "new_worker" | "import_current";

export type VesloBundleInvite = {
  bundleUrl: string;
  intent: VesloBundleInviteIntent;
  source?: string;
  orgId?: string;
  label?: string;
};

function normalizeVesloBundleInviteIntent(value: string | null | undefined): VesloBundleInviteIntent {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "new_worker" || normalized === "new-worker" || normalized === "newworker") {
    return "new_worker";
  }
  return "import_current";
}

export function buildVesloConnectInviteUrl(input: {
  workspaceUrl: string;
  token?: string | null;
  appUrl?: string | null;
  startup?: "server";
}) {
  const workspaceUrl = normalizeVesloServerUrl(input.workspaceUrl ?? "") ?? "";
  if (!workspaceUrl) return "";

  const base = normalizeVesloServerUrl(input.appUrl ?? "") ?? DEFAULT_VESLO_CONNECT_APP_URL;

  try {
    const url = new URL(base);
    const search = new URLSearchParams(url.search);
    search.set(VESLO_INVITE_PARAM_URL, workspaceUrl);

    const token = input.token?.trim() ?? "";
    if (token) {
      search.set(VESLO_INVITE_PARAM_TOKEN, token);
    }

    const startup = input.startup ?? "server";
    search.set(VESLO_INVITE_PARAM_STARTUP, startup);

    url.search = search.toString();
    return url.toString();
  } catch {
    const search = new URLSearchParams();
    search.set(VESLO_INVITE_PARAM_URL, workspaceUrl);
    const token = input.token?.trim() ?? "";
    if (token) {
      search.set(VESLO_INVITE_PARAM_TOKEN, token);
    }
    search.set(VESLO_INVITE_PARAM_STARTUP, input.startup ?? "server");
    return `${DEFAULT_VESLO_CONNECT_APP_URL}?${search.toString()}`;
  }
}

export function readVesloConnectInviteFromSearch(input: string | URLSearchParams) {
  const search =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;

  const rawUrl = (
    search.get(VESLO_INVITE_PARAM_URL) ??
    search.get(LEGACY_INVITE_PARAM_URL) ??
    ""
  ).trim();
  const url = normalizeVesloServerUrl(rawUrl);
  if (!url) return null;

  const token = (
    search.get(VESLO_INVITE_PARAM_TOKEN) ??
    search.get(LEGACY_INVITE_PARAM_TOKEN) ??
    ""
  ).trim();
  const startupRaw = (
    search.get(VESLO_INVITE_PARAM_STARTUP) ??
    search.get(LEGACY_INVITE_PARAM_STARTUP) ??
    ""
  ).trim();
  const startup = startupRaw === "server" ? "server" : undefined;

  return {
    url,
    token: token || undefined,
    startup,
  } satisfies VesloConnectInvite;
}

export function buildVesloBundleInviteUrl(input: {
  bundleUrl: string;
  appUrl?: string | null;
  intent?: VesloBundleInviteIntent;
  source?: string | null;
  orgId?: string | null;
  label?: string | null;
}) {
  const rawBundleUrl = input.bundleUrl?.trim() ?? "";
  if (!rawBundleUrl) return "";

  let bundleUrl: string;
  try {
    bundleUrl = new URL(rawBundleUrl).toString();
  } catch {
    return "";
  }

  const base = normalizeVesloServerUrl(input.appUrl ?? "") ?? DEFAULT_VESLO_CONNECT_APP_URL;

  try {
    const url = new URL(base);
    const search = new URLSearchParams(url.search);
    const intent = normalizeVesloBundleInviteIntent(input.intent);
    search.set(VESLO_INVITE_PARAM_BUNDLE, bundleUrl);
    search.set(VESLO_INVITE_PARAM_BUNDLE_INTENT, intent);

    const source = input.source?.trim() ?? "";
    if (source) {
      search.set(VESLO_INVITE_PARAM_BUNDLE_SOURCE, source);
    }

    const orgId = input.orgId?.trim() ?? "";
    if (orgId) {
      search.set(VESLO_INVITE_PARAM_BUNDLE_ORG, orgId);
    }

    const label = input.label?.trim() ?? "";
    if (label) {
      search.set(VESLO_INVITE_PARAM_BUNDLE_LABEL, label);
    }

    url.search = search.toString();
    return url.toString();
  } catch {
    const search = new URLSearchParams();
    const intent = normalizeVesloBundleInviteIntent(input.intent);
    search.set(VESLO_INVITE_PARAM_BUNDLE, bundleUrl);
    search.set(VESLO_INVITE_PARAM_BUNDLE_INTENT, intent);

    const source = input.source?.trim() ?? "";
    if (source) {
      search.set(VESLO_INVITE_PARAM_BUNDLE_SOURCE, source);
    }

    const orgId = input.orgId?.trim() ?? "";
    if (orgId) {
      search.set(VESLO_INVITE_PARAM_BUNDLE_ORG, orgId);
    }

    const label = input.label?.trim() ?? "";
    if (label) {
      search.set(VESLO_INVITE_PARAM_BUNDLE_LABEL, label);
    }

    return `${DEFAULT_VESLO_CONNECT_APP_URL}?${search.toString()}`;
  }
}

export function readVesloBundleInviteFromSearch(input: string | URLSearchParams) {
  const search =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;

  const rawBundleUrl = (
    search.get(VESLO_INVITE_PARAM_BUNDLE) ??
    search.get(LEGACY_INVITE_PARAM_BUNDLE) ??
    ""
  ).trim();
  if (!rawBundleUrl) return null;

  let bundleUrl: string;
  try {
    const parsed = new URL(rawBundleUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    bundleUrl = parsed.toString();
  } catch {
    return null;
  }

  const intent = normalizeVesloBundleInviteIntent(
    search.get(VESLO_INVITE_PARAM_BUNDLE_INTENT) ??
      search.get(LEGACY_INVITE_PARAM_BUNDLE_INTENT),
  );
  const source = (
    search.get(VESLO_INVITE_PARAM_BUNDLE_SOURCE) ??
    search.get(LEGACY_INVITE_PARAM_BUNDLE_SOURCE) ??
    ""
  ).trim();
  const orgId = (
    search.get(VESLO_INVITE_PARAM_BUNDLE_ORG) ??
    search.get(LEGACY_INVITE_PARAM_BUNDLE_ORG) ??
    ""
  ).trim();
  const label = (
    search.get(VESLO_INVITE_PARAM_BUNDLE_LABEL) ??
    search.get(LEGACY_INVITE_PARAM_BUNDLE_LABEL) ??
    ""
  ).trim();

  return {
    bundleUrl,
    intent,
    source: source || undefined,
    orgId: orgId || undefined,
    label: label || undefined,
  } satisfies VesloBundleInvite;
}

export function stripVesloConnectInviteFromUrl(input: string) {
  try {
    const url = new URL(input);
    url.searchParams.delete(VESLO_INVITE_PARAM_URL);
    url.searchParams.delete(VESLO_INVITE_PARAM_TOKEN);
    url.searchParams.delete(VESLO_INVITE_PARAM_STARTUP);
    url.searchParams.delete(LEGACY_INVITE_PARAM_URL);
    url.searchParams.delete(LEGACY_INVITE_PARAM_TOKEN);
    url.searchParams.delete(LEGACY_INVITE_PARAM_STARTUP);
    return url.toString();
  } catch {
    return input;
  }
}

export function stripVesloBundleInviteFromUrl(input: string) {
  try {
    const url = new URL(input);
    url.searchParams.delete(VESLO_INVITE_PARAM_BUNDLE);
    url.searchParams.delete(VESLO_INVITE_PARAM_BUNDLE_INTENT);
    url.searchParams.delete(VESLO_INVITE_PARAM_BUNDLE_SOURCE);
    url.searchParams.delete(VESLO_INVITE_PARAM_BUNDLE_ORG);
    url.searchParams.delete(VESLO_INVITE_PARAM_BUNDLE_LABEL);
    url.searchParams.delete(LEGACY_INVITE_PARAM_BUNDLE);
    url.searchParams.delete(LEGACY_INVITE_PARAM_BUNDLE_INTENT);
    url.searchParams.delete(LEGACY_INVITE_PARAM_BUNDLE_SOURCE);
    url.searchParams.delete(LEGACY_INVITE_PARAM_BUNDLE_ORG);
    url.searchParams.delete(LEGACY_INVITE_PARAM_BUNDLE_LABEL);
    return url.toString();
  } catch {
    return input;
  }
}

export function readVesloServerSettings(): VesloServerSettings {
  if (typeof window === "undefined") return {};
  try {
    const urlOverride = normalizeVesloServerUrl(
      window.localStorage.getItem(STORAGE_URL_OVERRIDE) ??
      window.localStorage.getItem(LEGACY_STORAGE_URL_OVERRIDE) ??
      "",
    );
    const portRaw =
      window.localStorage.getItem(STORAGE_PORT_OVERRIDE) ??
      window.localStorage.getItem(LEGACY_STORAGE_PORT_OVERRIDE) ??
      "";
    const portOverride = portRaw ? Number(portRaw) : undefined;
    const token =
      window.localStorage.getItem(STORAGE_TOKEN) ??
      window.localStorage.getItem(LEGACY_STORAGE_TOKEN) ??
      undefined;
    return {
      urlOverride: urlOverride ?? undefined,
      portOverride: Number.isNaN(portOverride) ? undefined : portOverride,
      token: token?.trim() || undefined,
    };
  } catch {
    return {};
  }
}

export function writeVesloServerSettings(next: VesloServerSettings): VesloServerSettings {
  if (typeof window === "undefined") return next;
  try {
    const urlOverride = normalizeVesloServerUrl(next.urlOverride ?? "");
    const portOverride = typeof next.portOverride === "number" ? next.portOverride : undefined;
    const token = next.token?.trim() || undefined;

    if (urlOverride) {
      window.localStorage.setItem(STORAGE_URL_OVERRIDE, urlOverride);
    } else {
      window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
    }
    window.localStorage.removeItem(LEGACY_STORAGE_URL_OVERRIDE);

    if (typeof portOverride === "number" && !Number.isNaN(portOverride)) {
      window.localStorage.setItem(STORAGE_PORT_OVERRIDE, String(portOverride));
    } else {
      window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    }
    window.localStorage.removeItem(LEGACY_STORAGE_PORT_OVERRIDE);

    if (token) {
      window.localStorage.setItem(STORAGE_TOKEN, token);
    } else {
      window.localStorage.removeItem(STORAGE_TOKEN);
    }
    window.localStorage.removeItem(LEGACY_STORAGE_TOKEN);

    return readVesloServerSettings();
  } catch {
    return next;
  }
}

export function hydrateVesloServerSettingsFromEnv() {
  if (typeof window === "undefined") return;

  try {
    const current = readVesloServerSettings();
    const { next, changed } = mergeVesloServerSettingsWithEnv(
      current,
      import.meta.env as Record<string, string | undefined>,
    );

    if (changed) {
      writeVesloServerSettings(next as VesloServerSettings);
    }
  } catch {
    // ignore
  }
}

export function clearVesloServerSettings() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
    window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    window.localStorage.removeItem(STORAGE_TOKEN);
    window.localStorage.removeItem(LEGACY_STORAGE_URL_OVERRIDE);
    window.localStorage.removeItem(LEGACY_STORAGE_PORT_OVERRIDE);
    window.localStorage.removeItem(LEGACY_STORAGE_TOKEN);
  } catch {
    // ignore
  }
}

export function deriveVesloServerUrl(
  opencodeBaseUrl: string,
  settings?: VesloServerSettings,
) {
  const override = settings?.urlOverride?.trim();
  if (override) {
    return normalizeVesloServerUrl(override);
  }

  const base = opencodeBaseUrl.trim();
  if (!base) return null;
  try {
    const url = new URL(base);
    const port = settings?.portOverride ?? DEFAULT_VESLO_SERVER_PORT;
    url.port = String(port);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.origin;
  } catch {
    return null;
  }
}

export class VesloServerError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

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

function setTrimmedSearchParam(search: URLSearchParams, key: string, value?: string | null) {
  const normalized = value?.trim() ?? "";
  if (normalized) search.set(key, normalized);
}

function buildSkillRegistrySearchPath(params: VesloSkillRegistrySearchParams) {
  const search = new URLSearchParams();
  setTrimmedSearchParam(search, "q", params.q);
  setTrimmedSearchParam(search, "workspaceId", params.workspaceId);
  const ownerScope = params.ownerScope ?? params.owner ?? params.scope;
  if (ownerScope) search.set("ownerScope", ownerScope);
  const reviewStatus = params.reviewStatus ?? params.approvalStatus;
  if (reviewStatus) search.set("reviewStatus", reviewStatus);
  if (typeof params.includeDeleted === "boolean") {
    search.set("includeDeleted", params.includeDeleted ? "true" : "false");
  }
  setTrimmedSearchParam(search, "language", params.language);
  setTrimmedSearchParam(search, "cursor", params.cursor);
  if (typeof params.limit === "number" && Number.isSafeInteger(params.limit) && params.limit > 0) {
    search.set("limit", String(params.limit));
  }
  const suffix = search.toString();
  return `/v1/skills/search${suffix ? `?${suffix}` : ""}`;
}

function buildSkillRegistryVersionsPath(skillId: string, params?: VesloSkillRegistryListVersionsInput) {
  const search = new URLSearchParams();
  setTrimmedSearchParam(search, "cursor", params?.cursor);
  if (typeof params?.limit === "number" && Number.isSafeInteger(params.limit) && params.limit > 0) {
    search.set("limit", String(params.limit));
  }
  const suffix = search.toString();
  return `/v1/skills/${encodeURIComponent(skillId)}/versions${suffix ? `?${suffix}` : ""}`;
}

function buildSkillRegistryRolloutPoliciesPath(params?: VesloSkillRegistryListRolloutPoliciesInput) {
  const search = new URLSearchParams();
  setTrimmedSearchParam(search, "cursor", params?.cursor);
  if (typeof params?.limit === "number" && Number.isSafeInteger(params.limit) && params.limit > 0) {
    search.set("limit", String(params.limit));
  }
  if (params?.target) search.set("target", params.target);
  if (params?.audience) search.set("audience", params.audience);
  setTrimmedSearchParam(search, "workspaceId", params?.workspaceId);
  const suffix = search.toString();
  return `/v1/skill-rollout-policies${suffix ? `?${suffix}` : ""}`;
}

function buildSoulVersionsPath(scope: VesloSoulScope, options?: VesloSoulVersionListOptions) {
  const search = new URLSearchParams();
  if (scope === "workspace") {
    setTrimmedSearchParam(search, "workspaceId", options?.workspaceId);
  } else {
    setTrimmedSearchParam(search, "cursor", options?.cursor);
    if (typeof options?.limit === "number" && Number.isSafeInteger(options.limit) && options.limit > 0) {
      search.set("limit", String(options.limit));
    }
  }
  const suffix = search.toString();
  return `/soul/${encodeURIComponent(scope)}/versions${suffix ? `?${suffix}` : ""}`;
}

function buildSoulVersionPath(scope: VesloSoulScope, versionId: string, options?: VesloSoulVersionGetOptions) {
  const search = new URLSearchParams();
  if (scope === "workspace") {
    setTrimmedSearchParam(search, "workspaceId", options?.workspaceId);
  }
  const suffix = search.toString();
  return `/soul/${encodeURIComponent(scope)}/versions/${encodeURIComponent(versionId)}${suffix ? `?${suffix}` : ""}`;
}

function buildSkillRemovalsPath(params?: {
  scope?: VesloSkillRemovalScope;
  workspaceId?: string;
  includeRestored?: boolean;
}) {
  const search = new URLSearchParams();
  if (params?.scope) search.set("scope", params.scope);
  setTrimmedSearchParam(search, "workspaceId", params?.workspaceId);
  if (typeof params?.includeRestored === "boolean") {
    search.set("includeRestored", params.includeRestored ? "true" : "false");
  }
  const suffix = search.toString();
  return `/skill-removals${suffix ? `?${suffix}` : ""}`;
}

function buildDeleteGlobalSkillPath(name: string, options?: { path?: string; reason?: string }) {
  const search = new URLSearchParams();
  setTrimmedSearchParam(search, "path", options?.path);
  setTrimmedSearchParam(search, "reason", options?.reason);
  const suffix = search.toString();
  return `/skills/user-global/${encodeURIComponent(name)}${suffix ? `?${suffix}` : ""}`;
}

function buildHeaders(
  token?: string,
  hostToken?: string,
  extra?: Record<string, string>,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-Veslo-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

function buildAuthHeaders(token?: string, hostToken?: string, extra?: Record<string, string>) {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-Veslo-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

function normalizeBearerToken(token: string, label: string): string {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

function buildGatewayCallerHeaders(userToken: string) {
  return {
    "X-Veslo-Gateway-Authorization": normalizeBearerToken(userToken, "userToken"),
  };
}

function buildDenContextHeaders(options?: VesloSkillRegistryAuthContext): Record<string, string> | undefined {
  const denApiBase = options?.denApiBase?.trim() ?? "";
  const denToken = options?.denToken?.trim() ?? "";
  const denOrgId = options?.denOrgId?.trim() ?? "";
  const denUserId = options?.denUserId?.trim() ?? "";
  const headers = {
    ...(denApiBase ? { "x-veslo-den-api-base": denApiBase } : {}),
    ...(denToken ? { "x-veslo-den-token": denToken } : {}),
    ...(denOrgId ? { "x-veslo-den-org-id": denOrgId } : {}),
    ...(denUserId ? { "x-veslo-den-user-id": denUserId } : {}),
  };
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function skillMaterializationSyncBody(options?: VesloSkillMaterializationRequestOptions): VesloSkillMaterializationSyncOptions | undefined {
  return options?.activeRun === true ? { activeRun: true } : undefined;
}

function activeWorkspaceIdsPayload(input?: { activeWorkspaceIds?: string[] }): { activeWorkspaceIds?: string[] } {
  const activeWorkspaceIds = [...new Set(
    (input?.activeWorkspaceIds ?? [])
      .map((item) => item.trim())
      .filter(Boolean),
  )];
  return activeWorkspaceIds.length ? { activeWorkspaceIds } : {};
}

function soulRestoreBody(input?: VesloSoulRestoreInput): { changeSummary?: string; activeWorkspaceIds?: string[]; activeRun?: boolean } | undefined {
  if (!input) return undefined;
  const body = {
    ...(input.changeSummary !== undefined ? { changeSummary: input.changeSummary } : {}),
    ...activeWorkspaceIdsPayload(input),
    ...(input.activeRun === true ? { activeRun: true } : {}),
  };
  return Object.keys(body).length ? body : undefined;
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

const auditedTauriFetch = wrapStartupRequestAuditFetch(
  tauriFetch as unknown as typeof globalThis.fetch,
  "tauri.veslo-server",
);

// Use Tauri's fetch when running in the desktop app to avoid CORS issues
const resolveFetch = () => (isTauriRuntime() ? auditedTauriFetch : globalThis.fetch);

const DEFAULT_VESLO_SERVER_TIMEOUT_MS = 10_000;

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    hostToken?: string;
    body?: unknown;
    timeoutMs?: number;
    extraHeaders?: Record<string, string>;
  } = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildHeaders(options.token, options.hostToken, options.extraHeaders),
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    options.timeoutMs ?? DEFAULT_VESLO_SERVER_TIMEOUT_MS,
  );

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  if (!response.ok) {
    let code = typeof json?.code === "string" ? json.code : "request_failed";
    let message = typeof json?.message === "string" ? json.message : response.statusText;
    // Orchestrator proxy returns {"error":"workspace not found"} on 404 for
    // /workspace/:id/opencode/* and similar per-workspace paths. Map to a
    // dedicated code so the caller can re-bootstrap the workspace registry and
    // retry with a fresh ID instead of surfacing a generic 404.
    if (response.status === 404 && typeof json?.error === "string") {
      message = json.error;
      if (json.error === "workspace not found") {
        code = "workspace_id_mismatch";
      }
    }
    throw new VesloServerError(response.status, code, message, json?.details);
  }

  return json as T;
}

async function requestJsonRaw<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<RawJsonResponse<T>> {
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildHeaders(options.token, options.hostToken),
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    options.timeoutMs ?? DEFAULT_VESLO_SERVER_TIMEOUT_MS,
  );

  const text = await response.text();
  let json: T | null = null;
  try {
    json = text ? (JSON.parse(text) as T) : null;
  } catch {
    json = null;
  }

  return { ok: response.ok, status: response.status, json };
}

async function requestMultipartRaw(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: FormData; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; text: string }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "POST",
      headers: buildAuthHeaders(options.token, options.hostToken),
      body: options.body,
    },
    options.timeoutMs ?? DEFAULT_VESLO_SERVER_TIMEOUT_MS,
  );
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function requestBinary(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; timeoutMs?: number } = {},
): Promise<{ data: ArrayBuffer; contentType: string | null; filename: string | null }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildAuthHeaders(options.token, options.hostToken),
    },
    options.timeoutMs ?? DEFAULT_VESLO_SERVER_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new VesloServerError(response.status, code, message, json?.details);
  }

  const contentType = response.headers.get("content-type");
  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const filenameRaw = filenameMatch?.[1] ?? filenameMatch?.[2] ?? null;
  const filename = filenameRaw ? decodeURIComponent(filenameRaw) : null;
  const data = await response.arrayBuffer();
  return { data, contentType, filename };
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
    conversationRun: 45_000,
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
  };

  return {
    baseUrl,
    token,
    health: () =>
      requestJson<{ ok: boolean; version: string; uptimeMs: number }>(baseUrl, "/health", { token, hostToken, timeoutMs: timeouts.health }),
    status: () => requestJson<VesloServerDiagnostics>(baseUrl, "/status", { token, hostToken, timeoutMs: timeouts.status }),
    capabilities: () => requestJson<VesloServerCapabilities>(baseUrl, "/capabilities", { token, hostToken, timeoutMs: timeouts.capabilities }),
    opencodeRouterHealth: () =>
      requestJsonRaw<VesloOpenCodeRouterHealthSnapshot>(baseUrl, "/veslo-code-router/health", { token, hostToken, timeoutMs: timeouts.opencodeRouter }),
    opencodeRouterBindings: (filters?: { channel?: string; identityId?: string }) => {
      const search = new URLSearchParams();
      if (filters?.channel?.trim()) search.set("channel", filters.channel.trim());
      if (filters?.identityId?.trim()) search.set("identityId", filters.identityId.trim());
      const suffix = search.toString();
      const path = suffix ? `/veslo-code-router/bindings?${suffix}` : "/veslo-code-router/bindings";
      return requestJsonRaw<VesloOpenCodeRouterBindingsResult>(baseUrl, path, { token, hostToken, timeoutMs: timeouts.opencodeRouter });
    },
    getMyAiAccess: (userToken: string) =>
      requestJson<VesloManagedAiAccessBundle>(baseUrl, "/ai-gateway/me/ai-access", {
        token,
        hostToken,
        timeoutMs: timeouts.aiAccess,
        extraHeaders: buildGatewayCallerHeaders(userToken),
      }),
    opencodeRouterTelegramIdentities: () =>
      requestJsonRaw<VesloOpenCodeRouterTelegramIdentitiesResult>(baseUrl, "/veslo-code-router/identities/telegram", { token, hostToken, timeoutMs: timeouts.opencodeRouter }),
    opencodeRouterSlackIdentities: () =>
      requestJsonRaw<VesloOpenCodeRouterSlackIdentitiesResult>(baseUrl, "/veslo-code-router/identities/slack", { token, hostToken, timeoutMs: timeouts.opencodeRouter }),
    listWorkspaces: () => requestJson<VesloWorkspaceList>(baseUrl, "/workspaces", { token, hostToken, timeoutMs: timeouts.listWorkspaces }),
    listSessionArchives: () =>
      requestJson<{ items: VesloSessionArchiveRecord[] }>(baseUrl, "/session-archives", {
        token,
        hostToken,
        extraHeaders: accountId ? { "X-Veslo-Account-Id": accountId } : undefined,
      }),
    putSessionArchive: (sessionId: string, payload: Omit<VesloSessionArchiveRecord, "sessionId">) =>
      requestJson<{ items: VesloSessionArchiveRecord[] }>(
        baseUrl,
        `/session-archives/${encodeURIComponent(sessionId)}`,
        {
          token,
          hostToken,
          method: "PUT",
          body: payload,
          extraHeaders: accountId ? { "X-Veslo-Account-Id": accountId } : undefined,
        },
      ),
    deleteSessionArchive: (sessionId: string) =>
      requestJson<{ items: VesloSessionArchiveRecord[] }>(
        baseUrl,
        `/session-archives/${encodeURIComponent(sessionId)}`,
        {
          token,
          hostToken,
          method: "DELETE",
          extraHeaders: accountId ? { "X-Veslo-Account-Id": accountId } : undefined,
        },
      ),
    activateWorkspace: (workspaceId: string) =>
      requestJson<{ activeId: string; workspace: VesloWorkspaceInfo }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}/activate`,
        { token, hostToken, method: "POST", timeoutMs: timeouts.activateWorkspace },
      ),
    // Hot-register a local workspace path without respawning the server
    // (VSLO-171). Server endpoint persists into config.workspaces at runtime;
    // returns 409 if the workspace already exists (caller can treat as success).
    addLocalWorkspace: (input: {
      path: string;
      name?: string;
      baseUrl?: string | null;
      directory?: string | null;
      opencodeUsername?: string | null;
      opencodePassword?: string | null;
    }) =>
      requestJson<{
        activeId: string;
        items: VesloWorkspaceInfo[];
        persisted: boolean;
      }>(baseUrl, `/workspaces/local`, {
        token,
        hostToken,
        method: "POST",
        body: {
          path: input.path,
          name: input.name,
          ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
          ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
          ...(input.opencodeUsername?.trim() ? { opencodeUsername: input.opencodeUsername.trim() } : {}),
          ...(input.opencodePassword?.trim() ? { opencodePassword: input.opencodePassword.trim() } : {}),
        },
        timeoutMs: timeouts.addLocalWorkspace,
      }),
    deleteWorkspace: (workspaceId: string) =>
      requestJson<{ ok: boolean; deleted: boolean; persisted: boolean; activeId: string | null; items: VesloWorkspaceInfo[] }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteWorkspace },
      ),
    deleteSession: (workspaceId: string, sessionId: string) =>
      requestJson<{ ok: boolean }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteSession },
      ),
    listConversations: (workspaceId: string, directory?: string, options?: { sync?: boolean }) => {
      const search = new URLSearchParams();
      const directoryRaw = directory?.trim() ?? "";
      if (directoryRaw) search.set("directory", directoryRaw);
      if (options?.sync === true) search.set("sync", "true");
      const query = search.toString();
      return requestJson<VesloConversationList>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/conversations${query ? `?${query}` : ""}`,
        { token, hostToken, timeoutMs: timeouts.sessionTranscript },
      );
    },
    createConversation: (
      workspaceId: string,
      input?: { directory?: string | null; title?: string | null },
      options?: { sendTraceId?: string | null },
    ) =>
      requestJson<VesloConversationCreateResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/conversations`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(input?.directory?.trim() ? { directory: input.directory.trim() } : {}),
            ...(input?.title?.trim() ? { title: input.title.trim() } : {}),
          },
          timeoutMs: timeouts.conversationCreate,
          extraHeaders: options?.sendTraceId?.trim()
            ? { "X-Veslo-Send-Trace-Id": options.sendTraceId.trim() }
            : undefined,
        },
      ),
    importConversations: (workspaceId: string, input: VesloConversationImportInput) =>
      requestJson<VesloConversationImportResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/conversations/import`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
            sessions: input.sessions.map((session) => ({
              id: session.id,
              title: session.title,
              parentID: session.parentID,
              time: session.time,
            })),
          },
          timeoutMs: timeouts.sessionTranscript,
        },
      ),
    runConversation: (
      workspaceId: string,
      conversationId: string,
      input: VesloConversationRunInput,
      options?: { sendTraceId?: string | null },
    ) =>
      requestJson<VesloConversationRunResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}/runs`,
        {
          token,
          hostToken,
          method: "POST",
          body: input,
          timeoutMs: timeouts.conversationRun,
          extraHeaders: options?.sendTraceId?.trim()
            ? { "X-Veslo-Send-Trace-Id": options.sendTraceId.trim() }
            : undefined,
        },
      ),
    abortConversation: (workspaceId: string, conversationId: string, input: { directory?: string | null; runId: string }) =>
      requestJson<VesloConversationAbortResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}/abort`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            runId: input.runId,
            ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
          },
          timeoutMs: timeouts.conversationAbort,
        },
      ),
    getSessionLatestRunArtifacts: (workspaceId: string, sessionId: string, directory?: string | null) => {
      const search = new URLSearchParams();
      const directoryRaw = directory?.trim() ?? "";
      if (directoryRaw) search.set("directory", directoryRaw);
      const query = search.toString();
      return requestJson<VesloSessionLatestRunArtifacts>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/artifacts/latest-run${query ? `?${query}` : ""}`,
        { token, hostToken, timeoutMs: timeouts.sessionArtifacts },
      );
    },
    prefetchSessionTranscripts: (workspaceId: string, input: VesloSessionTranscriptPrefetchInput) =>
      requestJson<VesloSessionTranscriptPrefetchResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/transcript-prefetch`,
        { token, hostToken, method: "POST", body: input, timeoutMs: timeouts.sessionTranscript },
      ),
    getSessionTranscript: (workspaceId: string, sessionId: string, limit = 140, directory?: string) => {
      const search = new URLSearchParams();
      search.set("limit", String(limit));
      const directoryRaw = directory?.trim() ?? "";
      if (directoryRaw) search.set("directory", directoryRaw);
      return requestJson<VesloSessionTranscriptSnapshot>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/transcript?${search.toString()}`,
        { token, hostToken, timeoutMs: timeouts.sessionTranscript },
      );
    },
    appendSessionTranscript: (workspaceId: string, sessionId: string, input: VesloSessionTranscriptAppendInput) =>
      requestJson<VesloSessionTranscriptSnapshot>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/transcript`,
        { token, hostToken, method: "POST", body: input, timeoutMs: timeouts.sessionTranscript },
      ),
    exportWorkspace: (workspaceId: string) =>
      requestJson<VesloWorkspaceExport>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/export`, {
        token,
        hostToken,
        timeoutMs: timeouts.workspaceExport,
      }),
    importWorkspace: (workspaceId: string, payload: Record<string, unknown>) =>
      requestJson<{ ok: boolean }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/import`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.workspaceImport,
      }),
    provisionWorkspaceSystem: (workspaceId: string) =>
      requestJson<VesloWorkspaceSystemProvisionResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/system/provision`,
        {
          token,
          hostToken,
          method: "POST",
          timeoutMs: timeouts.workspaceProvision,
        },
      ),
    getConfig: (workspaceId: string) =>
      requestJson<{ opencode: Record<string, unknown>; veslo: Record<string, unknown>; updatedAt?: number | null }>(
        baseUrl,
        `/workspace/${workspaceId}/config`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    setOpenCodeRouterTelegramToken: (
      workspaceId: string,
      tokenValue: string,
      healthPort?: number | null,
    ) =>
      requestJson<VesloOpenCodeRouterTelegramResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/telegram-token`,
        {
          token,
          hostToken,
          method: "POST",
          body: { token: tokenValue, healthPort },
          timeoutMs: timeouts.opencodeRouter,
        },
      ),
    setOpenCodeRouterSlackTokens: (
      workspaceId: string,
      botToken: string,
      appToken: string,
      healthPort?: number | null,
    ) =>
      requestJson<VesloOpenCodeRouterSlackResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/slack-tokens`,
        {
          token,
          hostToken,
          method: "POST",
          body: { botToken, appToken, healthPort },
          timeoutMs: timeouts.opencodeRouter,
        },
      ),
    getOpenCodeRouterTelegram: (workspaceId: string) =>
      requestJson<VesloOpenCodeRouterTelegramInfo>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/telegram`,
        { token, hostToken, timeoutMs: timeouts.opencodeRouter },
      ),
    getOpenCodeRouterTelegramIdentities: (workspaceId: string, options?: { healthPort?: number | null }) => {
      const query = typeof options?.healthPort === "number" ? `?healthPort=${encodeURIComponent(String(options.healthPort))}` : "";
      return requestJson<VesloOpenCodeRouterTelegramIdentitiesResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/identities/telegram${query}`,
        { token, hostToken, timeoutMs: timeouts.opencodeRouter },
      );
    },
    upsertOpenCodeRouterTelegramIdentity: (
      workspaceId: string,
      input: { id?: string; token: string; enabled?: boolean; access?: "public" | "private"; pairingCode?: string },
      options?: { healthPort?: number | null },
    ) =>
      requestJson<VesloOpenCodeRouterTelegramIdentityUpsertResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/identities/telegram`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(input.id?.trim() ? { id: input.id.trim() } : {}),
            token: input.token,
            ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
            ...(input.access ? { access: input.access } : {}),
            ...(input.pairingCode?.trim() ? { pairingCode: input.pairingCode.trim() } : {}),
            healthPort: options?.healthPort ?? null,
          },
        },
      ),
    deleteOpenCodeRouterTelegramIdentity: (workspaceId: string, identityId: string, options?: { healthPort?: number | null }) => {
      const query = typeof options?.healthPort === "number" ? `?healthPort=${encodeURIComponent(String(options.healthPort))}` : "";
      return requestJson<VesloOpenCodeRouterTelegramIdentityDeleteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/identities/telegram/${encodeURIComponent(identityId)}${query}`,
        { token, hostToken, method: "DELETE" },
      );
    },
    getOpenCodeRouterSlackIdentities: (workspaceId: string, options?: { healthPort?: number | null }) => {
      const query = typeof options?.healthPort === "number" ? `?healthPort=${encodeURIComponent(String(options.healthPort))}` : "";
      return requestJson<VesloOpenCodeRouterSlackIdentitiesResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/identities/slack${query}`,
        { token, hostToken },
      );
    },
    upsertOpenCodeRouterSlackIdentity: (
      workspaceId: string,
      input: { id?: string; botToken: string; appToken: string; enabled?: boolean },
      options?: { healthPort?: number | null },
    ) =>
      requestJson<VesloOpenCodeRouterSlackIdentityUpsertResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/identities/slack`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(input.id?.trim() ? { id: input.id.trim() } : {}),
            botToken: input.botToken,
            appToken: input.appToken,
            ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
            healthPort: options?.healthPort ?? null,
          },
        },
      ),
    deleteOpenCodeRouterSlackIdentity: (workspaceId: string, identityId: string, options?: { healthPort?: number | null }) => {
      const query = typeof options?.healthPort === "number" ? `?healthPort=${encodeURIComponent(String(options.healthPort))}` : "";
      return requestJson<VesloOpenCodeRouterSlackIdentityDeleteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/identities/slack/${encodeURIComponent(identityId)}${query}`,
        { token, hostToken, method: "DELETE" },
      );
    },
    getOpenCodeRouterBindings: (
      workspaceId: string,
      filters?: { channel?: string; identityId?: string; healthPort?: number | null },
    ) => {
      const search = new URLSearchParams();
      if (filters?.channel?.trim()) search.set("channel", filters.channel.trim());
      if (filters?.identityId?.trim()) search.set("identityId", filters.identityId.trim());
      if (typeof filters?.healthPort === "number") search.set("healthPort", String(filters.healthPort));
      const suffix = search.toString();
      return requestJson<VesloOpenCodeRouterBindingsResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/bindings${suffix ? `?${suffix}` : ""}`,
        { token, hostToken },
      );
    },
    setOpenCodeRouterBinding: (
      workspaceId: string,
      input: { channel: string; identityId?: string; peerId: string; directory?: string },
      options?: { healthPort?: number | null },
    ) =>
      requestJson<VesloOpenCodeRouterBindingUpdateResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/bindings`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            channel: input.channel,
            ...(input.identityId?.trim() ? { identityId: input.identityId.trim() } : {}),
            peerId: input.peerId,
            ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
            healthPort: options?.healthPort ?? null,
          },
        },
      ),
    sendOpenCodeRouterMessage: (
      workspaceId: string,
      input: {
        channel: "telegram" | "slack";
        text: string;
        identityId?: string;
        directory?: string;
        peerId?: string;
        autoBind?: boolean;
      },
      options?: { healthPort?: number | null },
    ) => {
      const payload = {
        channel: input.channel,
        text: input.text,
        ...(input.identityId?.trim() ? { identityId: input.identityId.trim() } : {}),
        ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
        ...(input.peerId?.trim() ? { peerId: input.peerId.trim() } : {}),
        ...(input.autoBind === true ? { autoBind: true } : {}),
        healthPort: options?.healthPort ?? null,
      };

      const primaryPath = `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/send`;
      const mountedWorkspaceId = parseVesloWorkspaceIdFromUrl(baseUrl);
      const fallbackPath =
        mountedWorkspaceId && mountedWorkspaceId === workspaceId
          ? `/veslo-code-router/send`
          : `/w/${encodeURIComponent(workspaceId)}/veslo-code-router/send`;

      return requestJson<VesloOpenCodeRouterSendResult>(baseUrl, primaryPath, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.opencodeRouter,
      }).catch(async (error) => {
        if (!(error instanceof VesloServerError) || error.status !== 404) {
          throw error;
        }
        return requestJson<VesloOpenCodeRouterSendResult>(baseUrl, fallbackPath, {
          token,
          hostToken,
          method: "POST",
          body: payload,
          timeoutMs: timeouts.opencodeRouter,
        });
      });
    },
    setOpenCodeRouterTelegramEnabled: (
      workspaceId: string,
      enabled: boolean,
      options?: { clearToken?: boolean; healthPort?: number | null },
    ) =>
      requestJson<VesloOpenCodeRouterTelegramEnabledResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/telegram-enabled`,
        {
          token,
          hostToken,
          method: "POST",
          body: { enabled, clearToken: options?.clearToken ?? false, healthPort: options?.healthPort ?? null },
        },
      ),
    patchConfig: (workspaceId: string, payload: { opencode?: Record<string, unknown>; veslo?: Record<string, unknown> }) =>
      requestJson<{ updatedAt?: number | null }>(baseUrl, `/workspace/${workspaceId}/config`, {
        token,
        hostToken,
        method: "PATCH",
        body: payload,
      }),
    listReloadEvents: (workspaceId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${options.since}` : "";
      return requestJson<{ items: VesloReloadEvent[]; cursor?: number }>(
        baseUrl,
        `/workspace/${workspaceId}/events${query}`,
        { token, hostToken },
      );
    },
    reloadEngine: (workspaceId: string) =>
      requestJson<{ ok: boolean; reloadedAt?: number }>(baseUrl, `/workspace/${workspaceId}/engine/reload`, {
        token,
        hostToken,
        method: "POST",
      }),
    listPlugins: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: VesloPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins${query}`,
        { token, hostToken },
      );
    },
    addPlugin: (workspaceId: string, spec: string) =>
      requestJson<{ items: VesloPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins`,
        { token, hostToken, method: "POST", body: { spec } },
      ),
    removePlugin: (workspaceId: string, name: string) =>
      requestJson<{ items: VesloPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins/${encodeURIComponent(name)}`,
        { token, hostToken, method: "DELETE" },
      ),
    listSkills: (workspaceId: string, options?: { includeGlobal?: boolean; includeDisabled?: boolean }) => {
      const queryParams = new URLSearchParams();
      if (options?.includeGlobal) queryParams.set("includeGlobal", "true");
      if (options?.includeDisabled) queryParams.set("includeDisabled", "true");
      const query = queryParams.toString();
      return requestJson<{ items: VesloSkillItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/skills${query ? `?${query}` : ""}`,
        { token, hostToken },
      );
    },
    listDisabledSkills: (options?: { workspaceId?: string }) => {
      const queryParams = new URLSearchParams();
      if (options?.workspaceId?.trim()) queryParams.set("workspaceId", options.workspaceId.trim());
      const query = queryParams.toString();
      return requestJson<VesloDisabledSkillsResponse>(
        baseUrl,
        `/skills/disabled${query ? `?${query}` : ""}`,
        { token, hostToken },
      );
    },
    setSkillEnabledState: (payload: { target: VesloSkillEnabledTarget; enabled: boolean }) =>
      requestJson<VesloSkillEnabledStateResponse>(baseUrl, "/skills/enabled-state", {
        token,
        hostToken,
        method: "PATCH",
        body: payload,
      }),
    resolveSkill: (
      workspaceId: string,
      payload: {
        text: string;
        includeGlobal?: boolean;
        threshold?: number;
        ambiguityDelta?: number;
        maxCandidates?: number;
      },
    ) =>
      requestJson<VesloSkillResolveResult>(
        baseUrl,
        `/workspace/${workspaceId}/skills/resolve`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
        },
      ),
    searchRegistrySkills: async (params: VesloSkillRegistrySearchParams) => {
      const payload = await requestJson<unknown>(baseUrl, buildSkillRegistrySearchPath(params), {
        token,
        hostToken,
        timeoutMs: timeouts.skillRegistrySearch,
      });
      return validateSkillRegistrySearchResponse(payload);
    },
    createRegistrySkill: (input: VesloSkillRegistryCreateSkillInput) =>
      requestJson<VesloSkillRegistrySkillResponse>(baseUrl, "/v1/skills", {
        token,
        hostToken,
        method: "POST",
        body: {
          scope: input.scope,
          name: input.name,
          displayName: input.displayName,
          description: input.description,
          orgId: input.orgId,
          workspaceId: input.workspaceId,
        },
        extraHeaders: buildDenContextHeaders(input),
        timeoutMs: timeouts.skillRegistryMutation,
      }),
    createRegistrySkillVersion: (skillId: string, input: VesloSkillRegistryCreateVersionInput) =>
      requestJson<VesloSkillRegistryVersionResponse>(
        baseUrl,
        `/v1/skills/${encodeURIComponent(skillId)}/versions`,
        {
          token,
          hostToken,
          method: "POST",
          body: { package: input.package },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),
    createRegistrySkillInstallation: (input: VesloSkillRegistryCreateInstallationInput) =>
      requestJson<VesloSkillRegistryInstallationResponse>(baseUrl, "/v1/skill-installations", {
        token,
        hostToken,
        method: "POST",
        body: {
          scope: input.scope,
          skillId: input.skillId,
          versionId: input.versionId,
          orgId: input.orgId,
          ownerUserId: input.ownerUserId,
          workspaceId: input.workspaceId,
          updatePolicy: input.updatePolicy,
          releaseChannel: input.releaseChannel,
        },
        extraHeaders: buildDenContextHeaders(input),
        timeoutMs: timeouts.skillRegistryMutation,
      }),
    listRegistrySkillVersions: (skillId: string, input?: VesloSkillRegistryListVersionsInput) =>
      requestJson<VesloSkillRegistryVersionsResponse>(baseUrl, buildSkillRegistryVersionsPath(skillId, input), {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(input),
        timeoutMs: timeouts.skillRegistrySearch,
      }),
    updateRegistrySkillInstallation: (
      installationId: string,
      input: VesloSkillRegistryUpdateInstallationInput,
    ) =>
      requestJson<VesloSkillRegistryInstallationResponse>(
        baseUrl,
        `/v1/skill-installations/${encodeURIComponent(installationId)}`,
        {
          token,
          hostToken,
          method: "PATCH",
          body: {
            enabled: input.enabled,
            versionId: input.versionId,
            updatePolicy: input.updatePolicy,
            releaseChannel: input.releaseChannel,
          },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),
    deleteRegistrySkillInstallation: (installationId: string, input?: VesloSkillRegistryAuthContext) =>
      requestJson<VesloSkillRegistryInstallationResponse>(
        baseUrl,
        `/v1/skill-installations/${encodeURIComponent(installationId)}`,
        {
          token,
          hostToken,
          method: "DELETE",
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),
    restoreRegistrySkillInstallation: (
      installationId: string,
      input: VesloSkillRegistryRestoreInstallationInput,
    ) =>
      requestJson<VesloSkillRegistryInstallationResponse>(
        baseUrl,
        `/v1/skill-installations/${encodeURIComponent(installationId)}/restore`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            orgId: input.orgId,
            ownerUserId: input.ownerUserId,
            workspaceId: input.workspaceId,
            versionId: input.versionId,
          },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),
    createRegistrySkillReviewRequest: (skillId: string, input: VesloSkillRegistryCreateReviewRequestInput) =>
      requestJson<VesloSkillRegistryReviewRequestResponse>(
        baseUrl,
        `/v1/skills/${encodeURIComponent(skillId)}/review-requests`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            scope: input.scope,
            versionId: input.versionId,
            orgId: input.orgId,
            reason: input.reason,
            releaseChannel: input.releaseChannel,
          },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),
    replaceRegistryWorkspaceSkillSet: (
      workspaceId: string,
      input: VesloSkillRegistryReplaceWorkspaceSkillSetInput,
    ) =>
      requestJson<VesloSkillRegistryWorkspaceSkillSetResponse>(
        baseUrl,
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/skill-set`,
        {
          token,
          hostToken,
          method: "PATCH",
          body: {
            orgId: input.orgId,
            releaseChannel: input.releaseChannel,
            skills: input.skills,
          },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),
    approveRegistrySkillReviewRequest: (requestId: string, input: VesloSkillRegistryReviewDecisionInput) =>
      requestJson<VesloSkillRegistryReviewRequestResponse>(
        baseUrl,
        `/v1/skill-review-requests/${encodeURIComponent(requestId)}/approve`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            reviewerNote: input.reviewerNote,
            releaseChannel: input.releaseChannel,
          },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),
    rejectRegistrySkillReviewRequest: (requestId: string, input: VesloSkillRegistryReviewDecisionInput) =>
      requestJson<VesloSkillRegistryReviewRequestResponse>(
        baseUrl,
        `/v1/skill-review-requests/${encodeURIComponent(requestId)}/reject`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            reviewerNote: input.reviewerNote,
          },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),
    listRegistrySkillRolloutPolicies: (input?: VesloSkillRegistryListRolloutPoliciesInput) =>
      requestJson<VesloSkillRegistryRolloutPoliciesResponse>(
        baseUrl,
        buildSkillRegistryRolloutPoliciesPath(input),
        {
          token,
          hostToken,
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistrySearch,
        },
      ),
    createRegistrySkillRolloutPolicy: (input: VesloSkillRegistryCreateRolloutPolicyInput) =>
      requestJson<VesloSkillRegistryRolloutPolicyResponse>(baseUrl, "/v1/skill-rollout-policies", {
        token,
        hostToken,
        method: "POST",
        body: {
          skillId: input.skillId,
          versionId: input.versionId,
          target: input.target,
          audience: input.audience,
          catalogScope: input.catalogScope,
          orgId: input.orgId,
          userId: input.userId,
          workspaceId: input.workspaceId,
          enabled: input.enabled,
          updatePolicy: input.updatePolicy,
          releaseChannel: input.releaseChannel,
          removalPolicy: input.removalPolicy,
        },
        extraHeaders: buildDenContextHeaders(input),
        timeoutMs: timeouts.skillRegistryMutation,
      }),
    updateRegistrySkillRolloutPolicy: (
      policyId: string,
      input: VesloSkillRegistryUpdateRolloutPolicyInput,
    ) =>
      requestJson<VesloSkillRegistryRolloutPolicyResponse>(
        baseUrl,
        `/v1/skill-rollout-policies/${encodeURIComponent(policyId)}`,
        {
          token,
          hostToken,
          method: "PATCH",
          body: {
            skillId: input.skillId,
            versionId: input.versionId,
            target: input.target,
            audience: input.audience,
            catalogScope: input.catalogScope,
            orgId: input.orgId,
            userId: input.userId,
            workspaceId: input.workspaceId,
            enabled: input.enabled,
            updatePolicy: input.updatePolicy,
            releaseChannel: input.releaseChannel,
            removalPolicy: input.removalPolicy,
          },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),
    deleteRegistrySkillRolloutPolicy: (policyId: string, input?: VesloSkillRegistryAuthContext) =>
      requestJson<VesloSkillRegistryRolloutPolicyResponse>(
        baseUrl,
        `/v1/skill-rollout-policies/${encodeURIComponent(policyId)}`,
        {
          token,
          hostToken,
          method: "DELETE",
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),
    getGlobalSkillMaterializationStatus: () =>
      requestJson<VesloGlobalSkillMaterializationStatus>(
        baseUrl,
        "/skills/materialization",
        {
          token,
          hostToken,
          timeoutMs: timeouts.skillMaterialization,
        },
      ),
    syncGlobalSkillMaterialization: (options?: VesloSkillMaterializationRequestOptions) =>
      requestJson<VesloGlobalSkillMaterializationSyncResult>(
        baseUrl,
        "/skills/materialization/sync-global",
        {
          method: "POST",
          token,
          hostToken,
          body: skillMaterializationSyncBody(options),
          extraHeaders: buildDenContextHeaders(options),
          timeoutMs: timeouts.skillMaterialization,
        },
      ),
    getWorkspaceSkillMaterializationStatus: (workspaceId: string) =>
      requestJson<VesloSkillMaterializationStatus>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/skills/materialization`,
        {
          token,
          hostToken,
          timeoutMs: timeouts.skillMaterialization,
        },
      ),
    syncWorkspaceSkillMaterialization: (
      workspaceId: string,
      options?: VesloSkillMaterializationRequestOptions,
    ) =>
      requestJson<VesloSkillMaterializationSyncResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/skills/materialization/sync`,
        {
          method: "POST",
          token,
          hostToken,
          body: skillMaterializationSyncBody(options),
          extraHeaders: buildDenContextHeaders(options),
          timeoutMs: timeouts.skillMaterialization,
        },
      ),
    listUserGlobalSkillStore: () =>
      requestJson<{ items: VesloUserGlobalSkillStoreItem[] }>(
        baseUrl,
        "/skills/user-global-store",
        { token, hostToken },
      ),
    getUserGlobalSkillStoreSkill: (name: string) =>
      requestJson<VesloUserGlobalSkillStoreContent>(
        baseUrl,
        `/skills/user-global-store/${encodeURIComponent(name)}`,
        { token, hostToken },
      ),
    upsertUserGlobalSkillStoreSkill: (
      payload: { name: string; content: string; description?: string; enabled?: boolean },
    ) =>
      requestJson<VesloUserGlobalSkillStoreMutationResult>(
        baseUrl,
        "/skills/user-global-store",
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
        },
      ),
    deleteUserGlobalSkillStoreSkill: (name: string) =>
      requestJson<VesloUserGlobalSkillStoreMutationResult>(
        baseUrl,
        `/skills/user-global-store/${encodeURIComponent(name)}`,
        { token, hostToken, method: "DELETE" },
      ),
    syncUserGlobalSkillStore: (workspaceId: string) =>
      requestJson<VesloUserGlobalSkillStoreSyncResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/skills/user-global-store/sync`,
        {
          token,
          hostToken,
          method: "POST",
          timeoutMs: timeouts.skillMaterialization,
        },
      ),
    listHubSkills: (options?: { denToken?: string; denOrgId?: string }) => {
      const denToken = options?.denToken?.trim() ?? "";
      const denOrgId = options?.denOrgId?.trim() ?? "";
      const extraHeaders = {
        ...(denToken ? { "x-veslo-den-token": denToken } : {}),
        ...(denOrgId ? { "x-veslo-den-org-id": denOrgId } : {}),
      };

      return requestJson<{ items: VesloHubSkillItem[] }>(baseUrl, `/hub/skills`, {
        token,
        hostToken,
        ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
      });
    },
    listHubMcp: (options?: { denToken?: string; denOrgId?: string }) => {
      const denToken = options?.denToken?.trim() ?? "";
      const denOrgId = options?.denOrgId?.trim() ?? "";
      const extraHeaders = {
        ...(denToken ? { "x-veslo-den-token": denToken } : {}),
        ...(denOrgId ? { "x-veslo-den-org-id": denOrgId } : {}),
      };

      return requestJson<{ items: VesloHubMcpItem[] }>(baseUrl, `/hub/mcp`, {
        token,
        hostToken,
        ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
      });
    },
    installHubSkill: (
      workspaceId: string,
      name: string,
      options?: { overwrite?: boolean; repo?: { owner?: string; repo?: string; ref?: string } },
    ) =>
      requestJson<{ ok: boolean; name: string; path: string; action: "added" | "updated"; written: number; skipped: number }>(
        baseUrl,
        `/workspace/${workspaceId}/skills/hub/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(options?.overwrite ? { overwrite: true } : {}),
            ...(options?.repo ? { repo: options.repo } : {}),
          },
        },
      ),
    installHubMcp: (
      workspaceId: string,
      name: string,
      options?: { denToken?: string; denOrgId?: string },
    ) => {
      const denToken = options?.denToken?.trim() ?? "";
      const denOrgId = options?.denOrgId?.trim() ?? "";
      const extraHeaders = {
        ...(denToken ? { "x-veslo-den-token": denToken } : {}),
        ...(denOrgId ? { "x-veslo-den-org-id": denOrgId } : {}),
      };

      return requestJson<{ ok: boolean; name: string; path: string; action: "added" | "updated"; written: number; skipped: number }>(
        baseUrl,
        `/workspace/${workspaceId}/mcp/hub/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "POST",
          ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
        },
      );
    },
    getSkill: (workspaceId: string, name: string, options?: { includeGlobal?: boolean; path?: string }) => {
      const queryParams = new URLSearchParams();
      if (options?.includeGlobal) queryParams.set("includeGlobal", "true");
      if (options?.path?.trim()) queryParams.set("path", options.path.trim());
      const query = queryParams.toString();
      return requestJson<VesloSkillContent>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}${query ? `?${query}` : ""}`,
        { token, hostToken },
      );
    },
    upsertSkill: (workspaceId: string, payload: { name: string; path?: string; content: string; description?: string }) =>
      requestJson<VesloSkillItem>(baseUrl, `/workspace/${workspaceId}/skills`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    deleteSkill: (workspaceId: string, name: string, options?: { path?: string }) => {
      const queryParams = new URLSearchParams();
      if (options?.path?.trim()) queryParams.set("path", options.path.trim());
      const query = queryParams.toString();
      return requestJson<{ ok: true; name: string; path: string }>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}${query ? `?${query}` : ""}`,
        { token, hostToken, method: "DELETE" },
      );
    },
    deleteGlobalSkill: (name: string, options?: { path?: string; reason?: string }) =>
      requestJson<VesloSkillRemovalMutationResult>(
        baseUrl,
        buildDeleteGlobalSkillPath(name, options),
        { token, hostToken, method: "DELETE" },
      ),
    batchRemoveSkills: (input: VesloSkillBatchRemoveRequest) => {
      const { denApiBase, denToken, denOrgId, denUserId, ...body } = input;
      return requestJson<VesloSkillBatchRemoveResponse>(
        baseUrl,
        "/skills/batch-remove",
        {
          token,
          hostToken,
          method: "POST",
          body,
          extraHeaders: buildDenContextHeaders({ denApiBase, denToken, denOrgId, denUserId }),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      );
    },
    listSkillRemovals: (params?: {
      scope?: VesloSkillRemovalScope;
      workspaceId?: string;
      includeRestored?: boolean;
    }) =>
      requestJson<VesloSkillRemovalsResponse>(
        baseUrl,
        buildSkillRemovalsPath(params),
        { token, hostToken },
      ),
    restoreSkillRemoval: (removalId: string) =>
      requestJson<VesloSkillRemovalMutationResult>(
        baseUrl,
        `/skill-removals/${encodeURIComponent(removalId)}/restore`,
        { token, hostToken, method: "POST" },
      ),
    listMcp: (workspaceId: string) =>
      requestJson<{ items: VesloMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp`, { token, hostToken }),
    addMcp: (workspaceId: string, payload: { name: string; config: Record<string, unknown> }) =>
      requestJson<{ items: VesloMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    removeMcp: (workspaceId: string, name: string) =>
      requestJson<{ items: VesloMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),

    logoutMcpAuth: (workspaceId: string, name: string) =>
      requestJson<{ ok: true }>(baseUrl, `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}/auth`, {
        token,
        hostToken,
        method: "DELETE",
      }),

    listCommands: (workspaceId: string, scope: "workspace" | "global" = "workspace") =>
      requestJson<{ items: VesloCommandItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/commands?scope=${scope}`,
        { token, hostToken },
      ),
    listAudit: (workspaceId: string, limit = 50) =>
      requestJson<{ items: VesloAuditEntry[] }>(
        baseUrl,
        `/workspace/${workspaceId}/audit?limit=${limit}`,
        { token, hostToken },
      ),
    upsertCommand: (
      workspaceId: string,
      payload: { name: string; description?: string; template: string; agent?: string; model?: string | null; subtask?: boolean },
    ) =>
      requestJson<{ items: VesloCommandItem[] }>(baseUrl, `/workspace/${workspaceId}/commands`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    deleteCommand: (workspaceId: string, name: string) =>
      requestJson<{ ok: boolean }>(baseUrl, `/workspace/${workspaceId}/commands/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),
    listAutomations: (workspaceId: string) =>
      requestJson<{ items: VesloAutomation[]; updatedAt: string }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/automations`,
        { token, hostToken },
      ),
    createAutomation: (workspaceId: string, payload: VesloAutomationCreatePayload) =>
      requestJson<{ automation: VesloAutomation }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/automations`,
        { token, hostToken, method: "POST", body: payload },
      ),
    updateAutomation: (workspaceId: string, automationId: string, payload: VesloAutomationUpdatePayload) =>
      requestJson<{ automation: VesloAutomation }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/automations/${encodeURIComponent(automationId)}`,
        { token, hostToken, method: "PATCH", body: payload },
      ),
    deleteAutomation: (workspaceId: string, automationId: string) =>
      requestJson<{ automation: VesloAutomation }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/automations/${encodeURIComponent(automationId)}`,
        { token, hostToken, method: "DELETE" },
      ),
    runAutomation: (workspaceId: string, automationId: string) =>
      requestJson<{ run: VesloAutomationRun }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/automations/${encodeURIComponent(automationId)}/run`,
        { token, hostToken, method: "POST" },
      ),
    listAutomationRuns: (workspaceId: string, automationId: string) =>
      requestJson<{ items: VesloAutomationRun[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/automations/${encodeURIComponent(automationId)}/runs`,
        { token, hostToken },
      ),
    listScheduledJobs: (workspaceId: string) =>
      requestJson<{ items: ScheduledJob[] }>(baseUrl, `/workspace/${workspaceId}/scheduler/jobs`, { token, hostToken }),
    deleteScheduledJob: (workspaceId: string, name: string) =>
      requestJson<{ job: ScheduledJob }>(baseUrl, `/workspace/${workspaceId}/scheduler/jobs/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "DELETE",
        },
      ),
    getSoulOverview: (options?: VesloSoulAuthContext) =>
      requestJson<VesloSoulOverviewResponse>(baseUrl, "/soul", {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
        timeoutMs: timeouts.soulMemory,
      }),
    getOrganizationSoul: (options?: VesloSoulAuthContext) =>
      requestJson<VesloSoulReadResponse>(baseUrl, "/soul/organization", {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
        timeoutMs: timeouts.soulMemory,
      }),
    getUserSoul: (options?: VesloSoulAuthContext) =>
      requestJson<VesloSoulReadResponse>(baseUrl, "/soul/user", {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
        timeoutMs: timeouts.soulMemory,
      }),
    listWorkspaceSouls: (options?: VesloSoulAuthContext) =>
      requestJson<VesloWorkspaceSoulsResponse>(baseUrl, "/soul/workspaces", {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
        timeoutMs: timeouts.soulMemory,
      }),
    getWorkspaceSoul: (workspaceId: string, options?: VesloSoulAuthContext) =>
      requestJson<VesloSoulReadResponse>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/soul`, {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
        timeoutMs: timeouts.soulMemory,
      }),
    listSoulVersions: (scope: VesloSoulScope, options?: VesloSoulVersionListOptions) =>
      requestJson<VesloSoulVersionsResponse>(baseUrl, buildSoulVersionsPath(scope, options), {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
        timeoutMs: timeouts.soulMemory,
      }),
    getSoulVersion: (scope: VesloSoulScope, versionId: string, options?: VesloSoulVersionGetOptions) =>
      requestJson<VesloSoulVersionResponse>(baseUrl, buildSoulVersionPath(scope, versionId, options), {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
        timeoutMs: timeouts.soulMemory,
      }),
    updateOrganizationSoul: (input: VesloSoulUpdateInput) =>
      requestJson<VesloSoulReadResponse>(baseUrl, "/soul/organization", {
        token,
        hostToken,
        method: "PATCH",
        body: {
          content: input.content,
          changeSummary: input.changeSummary,
          baseVersionId: input.baseVersionId,
          ...activeWorkspaceIdsPayload(input),
        },
        extraHeaders: buildDenContextHeaders(input),
        timeoutMs: timeouts.soulMemory,
      }),
    updateUserSoul: (input: VesloSoulUpdateInput) =>
      requestJson<VesloSoulReadResponse>(baseUrl, "/soul/user", {
        token,
        hostToken,
        method: "PATCH",
        body: {
          content: input.content,
          changeSummary: input.changeSummary,
          baseVersionId: input.baseVersionId,
          ...activeWorkspaceIdsPayload(input),
        },
        extraHeaders: buildDenContextHeaders(input),
        timeoutMs: timeouts.soulMemory,
      }),
    restoreOrganizationSoulVersion: (versionId: string, input?: VesloSoulRestoreInput) =>
      requestJson<VesloSoulReadResponse>(
        baseUrl,
        `/soul/organization/versions/${encodeURIComponent(versionId)}/restore`,
        {
          token,
          hostToken,
          method: "POST",
          body: soulRestoreBody(input),
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.soulMemory,
        },
      ),
    restoreUserSoulVersion: (versionId: string, input?: VesloSoulRestoreInput) =>
      requestJson<VesloSoulReadResponse>(
        baseUrl,
        `/soul/user/versions/${encodeURIComponent(versionId)}/restore`,
        {
          token,
          hostToken,
          method: "POST",
          body: soulRestoreBody(input),
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.soulMemory,
        },
      ),
    updateWorkspaceSoul: (workspaceId: string, input: VesloSoulUpdateInput) =>
      requestJson<VesloSoulReadResponse>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/soul`, {
        token,
        hostToken,
        method: "PATCH",
        body: {
          content: input.content,
          changeSummary: input.changeSummary,
          baseVersionId: input.baseVersionId,
          ...activeWorkspaceIdsPayload(input),
        },
        extraHeaders: buildDenContextHeaders(input),
        timeoutMs: timeouts.soulMemory,
      }),
    restoreWorkspaceSoulVersion: (workspaceId: string, versionId: string, input?: VesloSoulRestoreInput) =>
      requestJson<VesloSoulReadResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/soul/versions/${encodeURIComponent(versionId)}/restore`,
        {
          token,
          hostToken,
          method: "POST",
          body: soulRestoreBody(input),
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.soulMemory,
        },
      ),
    syncWorkspaceSoulMaterialization: (workspaceId: string, options?: VesloSoulAuthContext & { activeRun?: boolean }) =>
      requestJson<VesloSoulMaterializationResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/soul/materialization/sync`,
        {
          token,
          hostToken,
          method: "POST",
          body: options?.activeRun === true ? { activeRun: true } : undefined,
          extraHeaders: buildDenContextHeaders(options),
          timeoutMs: timeouts.soulMemory,
        },
      ),
    setWorkspaceSoulHeartbeat: (workspaceId: string, enabled: boolean, options?: VesloSoulAuthContext) =>
      requestJson<VesloSoulReadResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/soul/heartbeat-toggle`,
        {
          token,
          hostToken,
          method: "POST",
          body: { enabled },
          extraHeaders: buildDenContextHeaders(options),
          timeoutMs: timeouts.soulMemory,
        },
      ),
    getSoulStatus: (workspaceId: string) =>
      requestJson<VesloSoulStatus>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/soul/status`, {
        token,
        hostToken,
      }),
    listSoulHeartbeats: (workspaceId: string, limit = 20) =>
      requestJson<{ items: VesloSoulHeartbeatEntry[]; total: number; path: string }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/soul/heartbeats?limit=${encodeURIComponent(String(limit))}`,
        { token, hostToken },
      ),

    uploadInbox: async (workspaceId: string, file: File, options?: { path?: string }) => {
      const id = workspaceId.trim();
      if (!id) throw new Error("workspaceId is required");
      if (!file) throw new Error("file is required");
      const form = new FormData();
      form.append("file", file);
      if (options?.path?.trim()) {
        form.append("path", options.path.trim());
      }

      const result = await requestMultipartRaw(baseUrl, `/workspace/${encodeURIComponent(id)}/inbox`, {
        token,
        hostToken,
        method: "POST",
        body: form,
        timeoutMs: timeouts.binary,
      });

      if (!result.ok) {
        let message = result.text.trim();
        try {
          const json = message ? JSON.parse(message) : null;
          if (json && typeof json.message === "string") {
            message = json.message;
          }
        } catch {
          // ignore
        }
        throw new VesloServerError(result.status, "request_failed", message || "Inbox upload failed");
      }

      const body = result.text.trim();
      if (body) {
        try {
          const parsed = JSON.parse(body) as Partial<VesloInboxUploadResult>;
          if (typeof parsed.path === "string" && parsed.path.trim()) {
            return {
              ok: parsed.ok ?? true,
              path: parsed.path.trim(),
              bytes: typeof parsed.bytes === "number" ? parsed.bytes : file.size,
            } satisfies VesloInboxUploadResult;
          }
        } catch {
          // ignore invalid JSON and fall back
        }
      }

      return {
        ok: true,
        path: options?.path?.trim() || file.name,
        bytes: file.size,
      } satisfies VesloInboxUploadResult;
    },

    listInbox: (workspaceId: string) =>
      requestJson<VesloInboxList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/inbox`, {
        token,
        hostToken,
      }),

    downloadInboxItem: (workspaceId: string, inboxId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/inbox/${encodeURIComponent(inboxId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    createFileSession: (workspaceId: string, options?: { ttlSeconds?: number; write?: boolean }) =>
      requestJson<{ session: VesloFileSession }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/files/sessions`, {
        token,
        hostToken,
        method: "POST",
        body: {
          ...(typeof options?.ttlSeconds === "number" ? { ttlSeconds: options.ttlSeconds } : {}),
          ...(typeof options?.write === "boolean" ? { write: options.write } : {}),
        },
      }),

    renewFileSession: (sessionId: string, options?: { ttlSeconds?: number }) =>
      requestJson<{ session: VesloFileSession }>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/renew`, {
        token,
        hostToken,
        method: "POST",
        body: {
          ...(typeof options?.ttlSeconds === "number" ? { ttlSeconds: options.ttlSeconds } : {}),
        },
      }),

    closeFileSession: (sessionId: string) =>
      requestJson<{ ok: boolean }>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),

    getFileCatalogSnapshot: (
      sessionId: string,
      options?: { prefix?: string; after?: string; includeDirs?: boolean; limit?: number },
    ) => {
      const params = new URLSearchParams();
      if (options?.prefix?.trim()) params.set("prefix", options.prefix.trim());
      if (options?.after?.trim()) params.set("after", options.after.trim());
      if (typeof options?.includeDirs === "boolean") params.set("includeDirs", options.includeDirs ? "true" : "false");
      if (typeof options?.limit === "number") params.set("limit", String(options.limit));
      const query = params.toString();
      return requestJson<{
        sessionId: string;
        workspaceId: string;
        generatedAt: number;
        cursor: number;
        total: number;
        truncated: boolean;
        nextAfter?: string;
        items: VesloFileCatalogEntry[];
      }>(
        baseUrl,
        `/files/sessions/${encodeURIComponent(sessionId)}/catalog/snapshot${query ? `?${query}` : ""}`,
        { token, hostToken },
      );
    },

    listFileSessionEvents: (sessionId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${encodeURIComponent(String(options.since))}` : "";
      return requestJson<{ items: VesloFileSessionEvent[]; cursor: number }>(
        baseUrl,
        `/files/sessions/${encodeURIComponent(sessionId)}/catalog/events${query}`,
        { token, hostToken },
      );
    },

    readFileBatch: (sessionId: string, paths: string[]) =>
      requestJson<VesloFileReadBatchResult>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/read-batch`, {
        token,
        hostToken,
        method: "POST",
        body: { paths },
      }),

    writeFileBatch: (
      sessionId: string,
      writes: Array<{ path: string; contentBase64: string; ifMatchRevision?: string; force?: boolean }>,
    ) =>
      requestJson<VesloFileWriteBatchResult>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/write-batch`, {
        token,
        hostToken,
        method: "POST",
        body: { writes },
      }),

    runFileBatchOps: (
      sessionId: string,
      operations: Array<
        | { type: "mkdir"; path: string }
        | { type: "delete"; path: string; recursive?: boolean }
        | { type: "rename"; from: string; to: string }
      >,
    ) =>
      requestJson<VesloFileOpsBatchResult>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/ops`, {
        token,
        hostToken,
        method: "POST",
        body: { operations },
      }),

    readWorkspaceFile: (workspaceId: string, path: string) =>
      requestJson<VesloWorkspaceFileContent>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`,
        { token, hostToken },
      ),

    writeWorkspaceFile: (
      workspaceId: string,
      payload: { path: string; content: string; baseUpdatedAt?: number | null; force?: boolean },
    ) =>
      requestJson<VesloWorkspaceFileWriteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
        },
      ),

    listArtifacts: (workspaceId: string) =>
      requestJson<VesloArtifactList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/artifacts`, {
        token,
        hostToken,
      }),

    downloadArtifact: (workspaceId: string, artifactId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),
  };
}

export type VesloServerClient = ReturnType<typeof createVesloServerClient>;
