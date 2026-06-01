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
  opencodeUsername?: string;
  opencodePassword?: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  workspaceType: WorkspaceType;
  baseUrl?: string;
  directory?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  opencode?: {
    baseUrl?: string;
    directory?: string;
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
  port: number;
  token: string;
  hostToken: string;
  configPath?: string;
  approval: ApprovalConfig;
  corsOrigins: string[];
  workspaces: WorkspaceInfo[];
  authorizedRoots: string[];
  readOnly: boolean;
  startedAt: number;
  tokenSource: "cli" | "env" | "file" | "generated";
  hostTokenSource: "cli" | "env" | "file" | "generated";
  logFormat: LogFormat;
  logRequests: boolean;
  debugLogs: DebugLogConfig;
  denApiBase?: string;
  skillRegistryBaseUrl?: string;
  skillRegistryToken?: string;
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

export interface PluginItem {
  spec: string;
  source: "config" | "dir.project" | "dir.global";
  scope: "project" | "global";
  path?: string;
}

export interface McpItem {
  name: string;
  config: Record<string, unknown>;
  source: "config.project" | "config.global" | "config.remote";
  disabledByTools?: boolean;
}

export interface SkillItem {
  name: string;
  path: string;
  description: string;
  scope: "project" | "global";
  trigger?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  aliases?: string[];
  whenToUse?: string;
  paths?: string[];
}

export type ManagedSkillSource = "personal" | "workspace" | "organization" | "platform";

export type WorkspaceSkillWorkspaceScope = "personal" | "organization";

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
};

export type WorkspaceSkillMaterialization = {
  installationId: string;
  skillId: string;
  name: string;
  versionId: string;
  packageSha256: string;
  target: "workspace" | "personal-global";
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

export interface HubMcpItem {
  id: string;
  name: string;
  description?: string;
  config: {
    type: "remote" | "local";
    url?: string;
    command?: string[];
    oauth?: boolean;
  };
  source: {
    scope: "org";
    orgId: string;
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
}

export interface Actor {
  type: "remote" | "host";
  clientId?: string;
  tokenHash?: string;
  scope?: TokenScope;
}

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
