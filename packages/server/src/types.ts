export type WorkspaceType = "local" | "remote";

export type ApprovalMode = "manual" | "auto";

export type TokenScope = "owner" | "collaborator" | "viewer";

export type SandboxBackend = "none" | "docker" | "container";

export type ProviderPlacement = "in-sandbox" | "host-machine" | "client-machine" | "external";

export type LogFormat = "pretty" | "json";

export interface WorkspaceConfig {
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
}

export interface Capabilities {
  schemaVersion: number;
  serverVersion: string;
  skills: { read: boolean; write: boolean; source: "veslo" | "opencode" };
  hub: {
    skills: {
      read: boolean;
      install: boolean;
      repo: { owner: string; name: string; ref: string };
    };
  };
  plugins: { read: boolean; write: boolean };
  mcp: { read: boolean; write: boolean };
  commands: { read: boolean; write: boolean };
  config: { read: boolean; write: boolean };

  approvals: { mode: ApprovalMode; timeoutMs: number };
  sandbox: { enabled: boolean; backend: SandboxBackend };
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
