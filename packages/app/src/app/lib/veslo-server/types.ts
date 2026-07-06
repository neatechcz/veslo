import type { Part, Session } from "@opencode-ai/sdk/v2/client";
import type {
  MessageInfo,
  ModelRef,
  SkillInventoryRegistryMetadata,
  VesloAutomation,
  VesloAutomationCreatePayload,
  VesloAutomationRun,
  VesloAutomationUpdatePayload,
} from "../../types";
import type { SessionSendOrigin } from "../session-send-contract";
import type { ScheduledJob } from "../tauri";

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

export type VesloServerStatus = "connected" | "disconnected" | "limited" | "auth_desync";

export type VesloRuntimeChainStatus =
  | "server_running"
  | "runtime_chain_ready"
  | "orchestrator_unavailable"
  | "shared_engine_unhealthy"
  | "proxy_unreachable";

export type VesloRuntimeChainPayload = {
  status: VesloRuntimeChainStatus;
  checkedAt: number;
  orchestrator: {
    configured: boolean;
    daemonUrl: string | null;
    ok: boolean | null;
    engineTopology: string | null;
    error: string | null;
  };
  sharedEngine: {
    running: boolean | null;
    pending: boolean | null;
    engineState: string | null;
    baseUrl: string | null;
  };
  proxy: {
    workspaceId: string | null;
    ok: boolean | null;
    status: number | null;
    error: string | null;
  };
};

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
  runtimeChain?: VesloRuntimeChainPayload;
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

export type VesloPluginTarget = "user" | "project";
export type VesloPluginLifecycle = "active" | "disabled" | "removed" | "conflict";
export type VesloPluginInventoryScope = "platform" | "organization" | "user" | "project";
export type VesloPluginVisibility = "visible" | "hidden-debug-only";
export type VesloPluginEnabledPolicy = "locked-on" | "user-toggleable" | "admin-toggleable";
export type VesloPluginRemovalPolicy = "locked" | "admin-removable" | "user-removable";
export type VesloPluginActivationPhase = "startup" | "post-ready" | "on-demand" | "background-runtime";
export type VesloPluginPolicySource =
  | "policy.platform"
  | "policy.organization"
  | "policy.user"
  | "policy.project"
  | "config.unmanaged";

export type VesloPluginItem = {
  spec: string;
  source: "config" | "dir.project" | "dir.global";
  scope: "project" | "global";
  owner?: VesloResourceOwner;
  path?: string;
  managed?: boolean;
  policyId?: string;
  displayName?: string;
  target?: VesloPluginTarget;
  lifecycle?: VesloPluginLifecycle;
  conflict?: string;
};

export type VesloPluginInventoryItem = {
  id: string;
  spec: string;
  displayName: string;
  owner: VesloResourceOwner;
  scope: VesloPluginInventoryScope;
  target: VesloPluginTarget;
  source: VesloPluginPolicySource;
  visibility: VesloPluginVisibility;
  enabled: boolean;
  lifecycle: VesloPluginLifecycle;
  removalPolicy: VesloPluginRemovalPolicy;
  enabledPolicy: VesloPluginEnabledPolicy;
  activationPhase?: VesloPluginActivationPhase;
  coldStartCritical?: boolean;
  requiresEngineRestart?: boolean;
  managed: boolean;
  debugOnly?: boolean;
  conflict?: string;
};

export type VesloPluginListWarning = {
  code: "managed_plugin_manifest_invalid";
  path: string;
  source: "config.project" | "config.global" | "dir.project" | "dir.global";
  message: string;
};

export type VesloPluginListResponse = {
  items: VesloPluginItem[];
  inventory?: VesloPluginInventoryItem[];
  loadOrder: string[];
  warnings?: VesloPluginListWarning[];
};

export type VesloPluginMutationResponse = {
  item: VesloPluginInventoryItem;
};

export type VesloPluginMaterializationTargetResult = {
  config: {
    manifestPath: string;
    addedSpecs: string[];
    removedSpecs: string[];
    desiredSpecs: string[];
  };
  files: {
    rootDir: string;
    materializedPolicyIds: string[];
    removedPolicyIds: string[];
  };
};

export type VesloPluginMaterializationConflict = {
  code:
    | "unmanaged_config_spec_conflict"
    | "unmanaged_file_plugin_conflict"
    | "stale_file_plugin_unmarked";
  policyId: string;
  spec: string;
  target: VesloPluginTarget;
  message: string;
  path?: string;
};

export type VesloPluginMaterializationSyncResult =
  | {
    ok: true;
    phase?: VesloPluginActivationPhase;
    conflicts: [];
    project: VesloPluginMaterializationTargetResult;
    user: VesloPluginMaterializationTargetResult;
    reloadRequired: boolean;
  }
  | {
    ok: false;
    phase?: VesloPluginActivationPhase;
    conflicts: VesloPluginMaterializationConflict[];
    project: VesloPluginMaterializationTargetResult;
    user: VesloPluginMaterializationTargetResult;
    reloadRequired: false;
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

export type VesloSkillFileEntry = {
  path: string;
  sizeBytes: number;
  mediaType: string;
  executable?: boolean;
  text?: string;
};

export type VesloSkillFilesContent = {
  item: VesloSkillItem | VesloUserGlobalSkillStoreItem;
  files: VesloSkillFileEntry[];
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

export type VesloSkillImportSourceAgent = "codex" | "claude" | "opencode" | "agents";
export type VesloSkillImportSourceLocation = "user-global" | "workspace";
export type VesloSkillImportStatus = "ready" | "needs-review" | "invalid" | "conflict";

export type VesloSkillImportTarget =
  | { scope: "user-global" }
  | { scope: "workspace"; workspaceId: string; workspaceName: string };

export type VesloSkillImportCandidate = {
  id: string;
  name: string;
  description: string;
  trigger?: string;
  sourceAgent: VesloSkillImportSourceAgent;
  sourceLocation: VesloSkillImportSourceLocation;
  sourcePath: string;
  sourceRoot: string;
  target: VesloSkillImportTarget;
  status: VesloSkillImportStatus;
  warnings: string[];
  conflict?: {
    code: "target-exists" | "duplicate-candidate";
    message: string;
    path?: string;
  };
  fileCount: number;
};

export type VesloSkillImportCandidatesResponse = {
  items: VesloSkillImportCandidate[];
};

export type VesloSkillImportResultItem = {
  candidateId: string;
  name?: string;
  ok: boolean;
  code?: string;
  message?: string;
  path?: string;
  target?: VesloSkillImportTarget;
};

export type VesloSkillImportResult = {
  ok: boolean;
  reloadRequired?: boolean;
  results: VesloSkillImportResultItem[];
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
  reason?: string;
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
export type VesloConversationRunLifecycleStatus =
  | "submitted"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "aborted";

export type VesloConversationSubmitAttachment = {
  name: string;
  kind: string;
  mimeType: string;
  dataUrl?: string | null;
  contentBase64?: string | null;
  fileSessionPath?: string | null;
};

export type VesloConversationSubmitRequest = {
  clientMessageId: string;
  origin: SessionSendOrigin | string;
  source?: "button" | "enter" | "ctrl-enter" | string | null;
  target?: {
    conversationId?: string | null;
    opencodeSessionId?: string | null;
    directory?: string | null;
    pendingClientSessionId?: string | null;
  };
  draft: {
    mode: "prompt" | "shell";
    text: string;
    resolvedText?: string | null;
    parts: unknown[];
    command?: { name: string; arguments: string } | null;
    attachments?: VesloConversationSubmitAttachment[];
  };
  options?: {
    sendNow?: boolean;
    replaceMessageId?: string | null;
    submitQueuePolicy?: "normal" | "send-now" | "server-queue-only";
    model?: unknown;
    agent?: string | null;
    variant?: string | null;
    expectAiGatewayStart?: boolean;
    dryRun?: boolean;
  };
};

export type VesloConversationSubmitDebugTraceEntry = {
  source?: string;
  event: string;
  [key: string]: unknown;
};

export type VesloConversationSubmitResult =
  | {
      status: "dry_run";
      workspaceId: string;
      clientMessageId: string;
      requestHash: string;
      draftDisposition: "keep";
      target: {
        directory: string | null;
        conversationId?: string | null;
        opencodeSessionId?: string | null;
        pendingClientSessionId?: string | null;
      };
    }
  | {
      status: "submitted";
      workspaceId: string;
      conversationId: string;
      opencodeSessionId: string;
      runId: string;
      clientMessageId: string;
      materializedSession?: unknown | null;
      draftDisposition: "clear";
    }
  | {
      status: "queued";
      workspaceId: string;
      conversationId: string;
      opencodeSessionId: string;
      queueItemId: string;
      reservedRunId: string;
      queuePosition: number;
      clientMessageId: string;
      materializedSession?: unknown | null;
      draftDisposition: "clear";
    }
  | {
      status: "blocked";
      code: string;
      message: string;
      draftDisposition: "restore" | "keep";
      recoverable: boolean;
    }
  | {
      status: "failed";
      code: string;
      message: string;
      draftDisposition: "restore" | "mark-failed";
      debugTrace?: VesloConversationSubmitDebugTraceEntry[];
    };

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

export type VesloConversationRunActivityKind =
  | "local_tool"
  | "assistant_output"
  | "model_retry"
  | "idle"
  | "unknown";

export type VesloConversationRunWaitReason =
  | "running_tool"
  | "model_retry_no_output"
  | "assistant_message_open"
  | "session_idle"
  | "engine_unreachable"
  | "none";

export type VesloConversationRunStatusResult = {
  ok: boolean;
  workspaceId: string;
  conversationId: string;
  runId: string;
  status: VesloConversationRunLifecycleStatus;
  stale: boolean;
  activityKind?: VesloConversationRunActivityKind | null;
  waitReason?: VesloConversationRunWaitReason | null;
  lastUsefulProgressAt?: number | null;
  retrySince?: number | null;
  noProgressSeconds?: number | null;
};

export type VesloConversationAbortInput = {
  directory?: string | null;
  runId?: string | null;
  mode?: "active" | "run" | null;
};

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
  activeRun?: boolean;
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
  soulMaterialization?: VesloSoulMaterializationResult | null;
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
