import type {
  PluginEnabledPolicy,
  PluginLifecycle,
  PluginPolicy,
  PluginRemovalPolicy,
  PluginVisibility,
} from "./plugin-policy.js";

export type WorkspaceType = "local" | "remote";

export type ApprovalMode = "manual" | "auto";

export type TokenScope = "owner" | "collaborator" | "viewer";

export type ProviderPlacement = "in-sandbox" | "host-machine" | "client-machine" | "external";

export type LogFormat = "pretty" | "json";

export type SandboxBackend =
  | "none"
  | "docker"
  | "container"
  | "mac-sandbox-exec"
  | "windows-wsl2"
  | "windows-job-object"
  | "stub";

export interface WorkspaceConfig {
  id?: string;
  path: string;
  name?: string;
  workspaceType?: WorkspaceType;
  baseUrl?: string;
  directory?: string;
  opencodeDbPath?: string;
  opencodeDataDir?: string;
  opencodeDataHome?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
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
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  workspaceType: WorkspaceType;
  baseUrl?: string;
  directory?: string;
  opencodeDbPath?: string;
  opencodeDataDir?: string;
  opencodeDataHome?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
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
}

export interface ApprovalConfig {
  mode: ApprovalMode;
  timeoutMs: number;
}

export interface DebugLogConfig {
  enabled: boolean;
  ingestUrl: string | null;
  ingestToken: string | null;
  batchMaxEvents: number;
  batchMaxBytes: number;
  spoolMaxBytes: number;
  flushIntervalMs: number;
}

export interface ServerConfig {
  host: string;
  /**
   * Optional second bind address served with the same fetch handler and auth.
   * Used by the desktop shell to expose a WSL-reachable bridge listener (e.g.
   * the WSL virtual adapter IP) without binding the primary listener to
   * 0.0.0.0. Unset means single-listener loopback behavior. See VSLO-250.
   */
  bridgeHost?: string;
  port: number;
  instanceId?: string;
  token: string;
  hostToken: string;
  runtimeDescriptorPath?: string;
  configPath?: string;
  approval: ApprovalConfig;
  corsOrigins: string[];
  workspaces: WorkspaceInfo[];
  authorizedRoots: string[];
  readOnly: boolean;
  startedAt: number;
  tokenSource: "cli" | "secrets-file" | "env" | "file" | "generated";
  hostTokenSource: "cli" | "secrets-file" | "env" | "file" | "generated";
  logFormat: LogFormat;
  logRequests: boolean;
  debugLogs: DebugLogConfig;
  denApiBase?: string;
  skillRegistryBaseUrl?: string;
  skillRegistryToken?: string;
  orchestratorDaemonUrl?: string;
  orchestratorLifecycleToken?: string;
}

export interface Capabilities {
  schemaVersion: number;
  serverVersion: string;
  skills: { read: boolean; write: boolean; source: "veslo" | "opencode" };
  hub: {
    skills: {
      read: boolean;
      install: boolean;
    };
    mcp: {
      read: boolean;
      install: boolean;
    };
  };
  plugins: { read: boolean; write: boolean };
  mcp: { read: boolean; write: boolean };
  commands: { read: boolean; write: boolean };
  config: { read: boolean; write: boolean };
  sandbox?: { enabled: boolean; backend: SandboxBackend };

  approvals: { mode: ApprovalMode; timeoutMs: number };
  ui: { toy: boolean };
  tokens: { scoped: boolean; scopes: TokenScope[] };
  proxy: {
    opencode: boolean;
    opencodeRouter: boolean;
  };
  toolProviders: {
    browser: {
      enabled: boolean;
      placement: ProviderPlacement;
      mode: "none" | "headless" | "interactive";
    };
    files: {
      injection: boolean;
      outbox: boolean;
      inboxPath: string;
      outboxPath: string;
      maxBytes: number;
    };
  };
}

export type ReloadReason = "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";

export type ReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp" | "agent" | "command";
  name?: string;
  action?: "added" | "removed" | "updated";
  path?: string;
};

export interface ReloadEvent {
  id: string;
  seq: number;
  workspaceId: string;
  reason: ReloadReason;
  trigger?: ReloadTrigger;
  timestamp: number;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export type ResourceOwnerKind = "workspace" | "user" | "organization" | "platform";

export interface ResourceOwner {
  kind: ResourceOwnerKind;
  id: string;
  label?: string;
  root?: string;
}

export interface PluginItem {
  spec: string;
  source: "config" | "dir.project" | "dir.global";
  scope: "project" | "global";
  owner?: ResourceOwner;
  path?: string;
  managed?: boolean;
  policyId?: string;
  displayName?: string;
  target?: "user" | "project";
  lifecycle?: "active" | "disabled" | "removed" | "conflict";
  conflict?: string;
}

export type PluginInventoryItem = {
  id: string;
  spec: string;
  displayName: string;
  owner: ResourceOwner;
  scope: "platform" | "organization" | "user" | "project";
  target: "user" | "project";
  source: PluginPolicy["source"];
  visibility: PluginVisibility;
  enabled: boolean;
  lifecycle: PluginLifecycle;
  removalPolicy: PluginRemovalPolicy;
  enabledPolicy: PluginEnabledPolicy;
  managed: boolean;
  debugOnly?: boolean;
  conflict?: string;
};

export interface McpItem {
  name: string;
  config: Record<string, unknown>;
  source: "config.project" | "config.global" | "config.remote";
  owner?: ResourceOwner;
  disabledByTools?: boolean;
}

export interface SkillItem {
  name: string;
  path: string;
  description: string;
  scope: "project" | "global";
  enabled?: boolean;
  disabledReason?: "user";
  owner?: ResourceOwner;
  trigger?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  aliases?: string[];
  whenToUse?: string;
  paths?: string[];
  registry?: SkillItemRegistryMetadata;
}

export type ManagedSkillSource = "personal" | "workspace" | "organization" | "platform";

export type WorkspaceSkillWorkspaceScope = "personal" | "organization";

export type SkillItemRegistryMetadata = {
  skillId?: string;
  installationId?: string;
  policyId?: string;
  versionId?: string;
  packageSha256?: string;
  source?: ManagedSkillSource;
  removalPolicy?: WorkspaceSkillRolloutRemovalPolicy;
};

export type WorkspaceSkillSetWorkspace = {
  id: string;
  scope: WorkspaceSkillWorkspaceScope;
  orgId?: string | null;
  releaseChannel?: string | null;
};

export type WorkspaceSkillSetUser = {
  id: string;
  orgId?: string | null;
};

export type WorkspaceSkillSetUpdatePolicy = "pinned" | "latest_user" | "latest_approved" | "release_channel";

export type WorkspaceSkillRolloutRemovalPolicy = "user_removable" | "admin_removable" | "locked";

export type WorkspaceSkillRolloutPolicy = {
  id: string;
  skillId: string;
  name: string;
  versionId: string;
  packageSha256: string;
  enabled: boolean;
  source: Extract<ManagedSkillSource, "organization" | "platform">;
  target: "workspace" | "personal-global";
  audience: "user" | "selected-workspaces" | "all-org-users" | "all-platform-users";
  orgId?: string | null;
  userId?: string | null;
  workspaceId?: string | null;
  removalPolicy: WorkspaceSkillRolloutRemovalPolicy;
  updatePolicy?: WorkspaceSkillSetUpdatePolicy;
  releaseChannel?: string | null;
};

export type WorkspaceSkillRegistryInstallation = {
  installationId: string;
  skillId: string;
  name: string;
  versionId: string;
  packageSha256: string;
  enabled: boolean;
  source: ManagedSkillSource;
  installedAt: string;
  ownerUserId?: string | null;
  orgId?: string | null;
  workspaceId?: string | null;
  approved?: boolean;
  updatePolicy?: WorkspaceSkillSetUpdatePolicy;
  releaseChannel?: string | null;
  desiredVersionId?: string | null;
  desiredPackageSha256?: string | null;
};

export type WorkspaceSkillSetLocalUnmanagedSkill = {
  name: string;
  path: string;
  scope: "workspace" | "user-global";
};

export type WorkspaceSkillSetPolicy = {
  allowPersonalGlobalInOrgWorkspace?: boolean;
  allowPersonalGlobalShadowOrgManaged?: boolean;
};

export type ResolvedWorkspaceSkill = {
  installationId: string;
  skillId: string;
  name: string;
  versionId: string;
  packageSha256: string;
  source: ManagedSkillSource;
  target: "workspace" | "personal-global";
  removalPolicy: WorkspaceSkillRolloutRemovalPolicy;
  owner?: ResourceOwner;
};

export type WorkspaceSkillMaterialization = {
  installationId: string;
  skillId: string;
  name: string;
  versionId: string;
  packageSha256: string;
  source: ManagedSkillSource;
  target: "workspace" | "personal-global";
  removalPolicy: WorkspaceSkillRolloutRemovalPolicy;
  owner?: ResourceOwner;
};

export type WorkspaceSkillConflict = {
  code: "personal-global-shadowed" | "unmanaged-local-shadowed" | "target-conflict";
  name: string;
  message: string;
  blockingInstallationId?: string;
  blockedInstallationId?: string;
  localPath?: string;
};

export type BlockedWorkspaceSkillInstallation = {
  installationId: string;
  skillId: string;
  name: string;
  reason: "disabled" | "not-approved" | "out-of-scope" | "shadowed";
};

export type WorkspaceSkillSetResolution = {
  effectiveManagedSkills: ResolvedWorkspaceSkill[];
  requiredMaterializations: WorkspaceSkillMaterialization[];
  conflicts: WorkspaceSkillConflict[];
  blockedInstallations: BlockedWorkspaceSkillInstallation[];
  reloadRequired: boolean;
};

export interface SkillResolveCandidate {
  name: string;
  score: number;
  reasons: string[];
  description?: string;
  trigger?: string;
}

export interface SkillResolveResult {
  text: string;
  match: SkillResolveCandidate | null;
  candidates: SkillResolveCandidate[];
}

export interface HubSkillItem {
  name: string;
  description: string;
  trigger?: string;
  source: {
    owner: string;
    repo: string;
    ref: string;
    path: string;
  };
}

export type HubMcpOAuthConfig =
  | boolean
  | {
      clientId: string;
      clientSecret?: string;
      scope?: string;
    };

export type HubMcpAuthorization = {
  type: "veslo-server-oauth";
  provider: string;
  connectorId: string;
  scopes: string[];
  startPath: string;
  runtimeTokenPath: string;
  statusPath: string;
  disconnectPath: string;
};

export interface HubMcpItem {
  id: string;
  name: string;
  description?: string;
  config: {
    type: "remote" | "local";
    url?: string;
    command?: string[];
    oauth?: HubMcpOAuthConfig;
    headers?: Record<string, string>;
  };
  authorization?: HubMcpAuthorization;
  source:
    | { scope: "org"; orgId: string }
    | { scope: "platform" };
  provider?: {
    id: string;
    group?: string;
  };
}

export interface CommandItem {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string | null;
  subtask?: boolean;
  scope: "workspace" | "global";
  owner?: ResourceOwner;
}

export interface Actor {
  type: "remote" | "host";
  clientId?: string;
  tokenHash?: string;
  scope?: TokenScope;
}

export type SkillEnabledScope = "workspace" | "user-global" | "organization" | "platform";

export type SkillEnabledRegistryIdentity = {
  skillId?: string;
  installationId?: string;
  policyId?: string;
  versionId?: string;
  source?: ManagedSkillSource;
};

export type DisabledSkillTarget = {
  name: string;
  scope: SkillEnabledScope;
  workspaceId?: string;
  path?: string;
  registry?: SkillEnabledRegistryIdentity;
};

export type DisabledSkillRecord = DisabledSkillTarget & {
  id: string;
  disabledAt: string;
  disabledBy?: string;
};

export type SkillEnabledOverridesDocument = {
  schemaVersion: 1;
  disabled: DisabledSkillRecord[];
};

export type PluginPolicyOverrideAction = "disabled" | "removed";

export type PluginPolicyOverrideScope = "user" | "project" | "organization";

export type PluginPolicyOverride = {
  id: string;
  pluginId: string;
  action: PluginPolicyOverrideAction;
  scope: PluginPolicyOverrideScope;
  workspaceId?: string;
  orgId?: string;
  actor?: string;
  createdAt: string;
};

export type PluginPolicyOverridesDocument = {
  schemaVersion: 1;
  overrides: PluginPolicyOverride[];
};

export interface ApprovalRequest {
  id: string;
  workspaceId: string;
  action: string;
  summary: string;
  paths: string[];
  createdAt: number;
  actor: Actor;
}

export interface AuditEntry {
  id: string;
  workspaceId: string;
  actor: Actor;
  action: string;
  target: string;
  summary: string;
  timestamp: number;
}

export type SessionArtifactFamily = "files" | "skills" | "mcp" | "soul";

export type SessionArtifactKind =
  | "file_output"
  | "file_discovered"
  | "skill_used"
  | "mcp_used"
  | "soul_memory_used"
  | "heartbeat_used";

export type SessionArtifactStatus = "scanned" | "updated" | "created" | "exported" | "used" | "active";

export interface SessionArtifactItem {
  id: string;
  sessionId: string;
  workspaceId: string;
  runId: string;
  family: SessionArtifactFamily;
  kind: SessionArtifactKind;
  status: SessionArtifactStatus;
  title: string;
  subtitle?: string;
  path?: string;
  sourceName?: string;
  messageId?: string;
  partId?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface SessionLatestRunArtifactsResponse {
  sessionId: string;
  workspaceId: string;
  runId: string | null;
  items: SessionArtifactItem[];
}
