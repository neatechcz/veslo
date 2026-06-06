import type {
  Message,
  Part,
  PermissionRequest as ApiPermissionRequest,
  QuestionRequest,
  ProviderListResponse,
  Session,
} from "@opencode-ai/sdk/v2/client";
import type { createClient } from "./lib/opencode";
import type { OpencodeConfigFile, ScheduledJob as TauriScheduledJob, WorkspaceInfo } from "./lib/tauri";

export type Client = ReturnType<typeof createClient>;

export type ProviderListItem = ProviderListResponse["all"][number];

export type VesloAutomationSchedule =
  | { kind: "oneShot"; runAt: string; timezone?: string }
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "interval"; seconds: number }
  | { kind: "daily"; hour: number; minute: number; timezone?: string }
  | { kind: "weekly"; weekday: number; hour: number; minute: number; timezone?: string };

export type VesloAutomationStatus = "active" | "paused" | "completed" | "failed" | "cancelled";

export type VesloAutomationRunStatus = "queued" | "running" | "success" | "failed" | "skipped";

export type VesloAutomationTarget = {
  preferredSessionId?: string;
  fallbackTitle?: string;
  agent?: string;
  model?: string | null;
  variant?: string | null;
};

export type VesloAutomation = {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  status: VesloAutomationStatus;
  schedule: VesloAutomationSchedule;
  prompt: string;
  target?: VesloAutomationTarget;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string | null;
  completedAt?: string | null;
  lastRunId?: string | null;
};

export type VesloAutomationRun = {
  id: string;
  automationId: string;
  scheduledFor: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  status: VesloAutomationRunStatus;
  sessionId?: string | null;
  createdSession: boolean;
  error?: string | null;
};

export type VesloAutomationCreatePayload = {
  name: string;
  schedule: VesloAutomationSchedule;
  prompt: string;
  target?: VesloAutomationTarget;
  enabled?: boolean;
};

export type VesloAutomationUpdatePayload = Partial<{
  name: string;
  schedule: VesloAutomationSchedule;
  prompt: string;
  target: VesloAutomationTarget | null;
  enabled: boolean;
  status: VesloAutomationStatus;
}>;

export type SidebarSessionItem = {
  id: string;
  title: string;
  slug?: string | null;
  parentID?: string | null;
  time?: {
    updated?: number | null;
    created?: number | null;
  };
  directory?: string | null;
};

export type SidebarSubagentDecoration = {
  label: string;
  color: string;
};

export type LoadedSidebarPrefetchInterest = {
  clickedSessionId: string | null;
  selectedSessionId: string | null;
  loadedTopLevelSessionIds: string[];
  expandedSubagentSessionIds: string[];
};

export type LoadedSessionPrefetchInterestChangeHandler = (
  workspaceId: string,
  interest: LoadedSidebarPrefetchInterest,
) => void;

export type WorkspaceSessionGroup = {
  workspace: WorkspaceInfo;
  sessions: SidebarSessionItem[];
  status: "idle" | "loading" | "ready" | "error";
  error?: string | null;
};

export type SessionArchiveItem = {
  sessionId: string;
  title: string;
  workspaceLabel: string;
  projectLabel?: string | null;
  resolvedDirectory?: string | null;
  archivedAt: number;
  availableOnThisDevice: boolean;
};

export type PlaceholderAssistantMessage = {
  id: string;
  sessionID: string;
  role: "assistant";
  time: {
    created: number;
    completed?: number;
  };
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
};

export type MessageInfo = Message | PlaceholderAssistantMessage;

export type MessageWithParts = {
  info: MessageInfo;
  parts: Part[];
};

export type SessionErrorTurn = {
  id: string;
  text: string;
  afterMessageID: string | null;
  time: number;
};

export const SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX = "session-error:";

export type StepGroupMode = "exploration" | "standalone";

export type MessageGroup =
  | { kind: "text"; part: Part; segment: "intent" | "result" }
  | { kind: "steps"; id: string; parts: Part[]; segment: "execution"; mode: StepGroupMode };

export type PromptMode = "prompt" | "shell";

export type ComposerPart =
  | { type: "text"; text: string }
  | { type: "agent"; name: string }
  | { type: "file"; path: string; label?: string }
  | { type: "paste"; id: string; label: string; text: string; lines: number };

export type ComposerAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  dataUrl: string;
};

export type SlashCommandOption = {
  id: string;
  name: string;
  description?: string;
  source?: "command" | "mcp" | "skill";
};

export type ComposerDraft = {
  mode: PromptMode;
  parts: ComposerPart[];
  attachments: ComposerAttachment[];
  /** Editor-visible text (may include collapsed paste placeholders). */
  text: string;
  /**
   * Resolved text to send to the model.
   * When a paste is collapsed into a placeholder (e.g. "[pasted text 1]"),
   * this includes the full pasted text instead.
   */
  resolvedText?: string;
  /** When set, draft is a slash command invocation */
  command?: { name: string; arguments: string } | undefined;
};

export type ArtifactItem = {
  id: string;
  name: string;
  path?: string;
  kind: "file" | "text";
  size?: string;
  messageId?: string;
  fileInteraction?: "modified" | "opened";
};

export type OpencodeEvent = {
  type: string;
  properties?: unknown;
};

export type View = "onboarding" | "dashboard" | "session" | "proto";

export type StartupPreference = "local" | "server";

export type EngineRuntime = "direct" | "veslo-orchestrator";

export type OnboardingStep = "language" | "auth" | "welcome" | "local" | "server" | "connecting";

export type DashboardTab =
  | "scheduled"
  | "soul"
  | "skills"
  | "plugins"
  | "mcp"
  | "config"
  | "settings";

export type SettingsTab = "general" | "archived" | "advanced" | "debug";

export type WorkspacePreset = "starter" | "automation" | "minimal";

export type WorkspaceConnectionStatus = "idle" | "connecting" | "connected" | "error";

export type WorkspaceConnectionState = {
  status: WorkspaceConnectionStatus;
  message?: string | null;
  checkedAt?: number | null;
};

export type ResetVesloMode = "onboarding" | "all";

export type WorkspaceVesloConfig = {
  version: number;
  workspace?: {
    name?: string | null;
    createdAt?: number | null;
    preset?: string | null;
  } | null;
  authorizedRoots: string[];
  reload?: {
    auto?: boolean;
    resume?: boolean;
  } | null;
};

export type SkillCard = {
  name: string;
  path: string;
  description?: string;
  trigger?: string;
};

export type SkillSaveResult = {
  ok: boolean;
  message?: string;
};

export type SkillPackageFile = {
  path: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  executable?: boolean;
  text?: string;
};

export type SkillPackageManifest = {
  schemaVersion: 1;
  entrypoint: "SKILL.md";
  files: SkillPackageFile[];
  packageSha256: string;
  metadata: {
    name: string;
    description?: string;
    trigger?: string;
    tags?: string[];
    language?: string;
  };
};

export type HubSkillCard = {
  name: string;
  description?: string;
  trigger?: string;
  source: {
    owner: string;
    repo: string;
    ref: string;
    path: string;
  };
};

export type HubSkillInstallTarget =
  | { scope: "global" }
  | { scope: "workspace"; workspaceId: string };

export type ManagedSkillSource = "personal" | "workspace" | "organization" | "platform";
export type WorkspaceSkillRolloutRemovalPolicy = "user_removable" | "admin_removable" | "locked";

export type SkillInventoryLifecycle = "active" | "removed";

export type SkillInventoryRegistryMetadata = {
  skillId?: string;
  installationId?: string;
  policyId?: string;
  versionId?: string;
  packageSha256?: string;
  source?: ManagedSkillSource;
  removalPolicy?: WorkspaceSkillRolloutRemovalPolicy;
};

export type SkillInventoryScope = "workspace" | "user-global" | "organization";

export type SkillInventoryStatus = "global" | "workspace-only" | "mixed" | "hub-only";

export type SkillInventoryWorkspace = {
  id: string;
  label: string;
  path?: string;
  kind: "local" | "remote";
};

export type SkillInstance = {
  id: string;
  name: string;
  scope: SkillInventoryScope;
  workspaceId?: string;
  workspaceLabel?: string;
  path: string;
  description?: string;
  trigger?: string;
  source: "opencode" | "claude" | "agents" | "hub" | "unknown";
  lifecycle?: SkillInventoryLifecycle;
  removedAt?: string;
  removedBy?: string;
  removeReason?: string;
  registry?: SkillInventoryRegistryMetadata;
  restoreTarget?: {
    scope: SkillInventoryScope;
    workspaceId?: string;
    orgId?: string;
    removalId?: string;
  };
  readable: boolean;
  writable: boolean;
};

export type SkillInventoryItem = {
  name: string;
  description?: string;
  trigger?: string;
  globalInstance?: SkillInstance;
  workspaceInstances: SkillInstance[];
  hubItem?: HubSkillCard;
  status: SkillInventoryStatus;
};

export type WorkspaceSkillSetUpdatePolicy = "pinned" | "latest_user" | "latest_approved" | "release_channel";

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
  source: ManagedSkillSource;
  removalPolicy: WorkspaceSkillRolloutRemovalPolicy;
  target: "workspace" | "personal-global";
};

export type WorkspaceSkillConflict = {
  code: "personal-global-shadowed" | "unmanaged-local-shadowed";
  name: string;
  message: string;
  blockingInstallationId?: string;
  blockedInstallationId?: string;
  localPath?: string;
};

export type WorkspaceSkillSetResolution = {
  effectiveManagedSkills: ResolvedWorkspaceSkill[];
  requiredMaterializations: WorkspaceSkillMaterialization[];
  conflicts: WorkspaceSkillConflict[];
  blockedInstallations: Array<{
    installationId: string;
    skillId: string;
    name: string;
    reason: "disabled" | "not-approved" | "out-of-scope" | "shadowed";
  }>;
  reloadRequired: boolean;
};

export type HubMcpItem = {
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
};

export type HubMcpCard = {
  id: string;
  name: string;
  description?: string;
  type: "remote" | "local";
  url?: string;
  command?: string[];
  oauth: boolean;
};

export type PluginInstallStep = {
  title: string;
  titleKey?: string;
  description: string;
  descriptionKey?: string;
  command?: string;
  url?: string;
  path?: string;
  note?: string;
  noteKey?: string;
};

export type SuggestedPlugin = {
  name: string;
  packageName: string;
  description: string;
  descriptionKey?: string;
  tags: string[];
  tagKeys?: string[];
  aliases?: string[];
  installMode?: "simple" | "guided";
  steps?: PluginInstallStep[];
};

export type PluginScope = "project" | "global";

export type McpServerConfig = {
  type: "remote" | "local";
  url?: string;
  command?: string[];
  enabled?: boolean;
  headers?: Record<string, string>;
  environment?: Record<string, string>;
  oauth?: Record<string, string> | false;
  timeout?: number;
};

export type McpServerEntry = {
  name: string;
  config: McpServerConfig;
  source?: "config.project" | "config.global" | "config.remote";
  disabledByTools?: boolean;
};

export type McpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string };

export type McpStatusMap = Record<string, McpStatus>;

export type ReloadReason = "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";

export type OpencodeConnectStatus = {
  at: number;
  baseUrl: string;
  directory?: string | null;
  reason?: string | null;
  status: "connecting" | "connected" | "error";
  error?: string | null;
  metrics?: {
    healthyMs?: number;
    loadSessionsMs?: number;
    pendingPermissionsMs?: number;
    providersMs?: number;
    totalMs?: number;
  };
};

export type ReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp" | "agent" | "command";
  name?: string;
  action?: "added" | "removed" | "updated";
  path?: string;
};

export type PendingPermission = ApiPermissionRequest & {
  receivedAt: number;
};

export type PendingQuestion = QuestionRequest & {
  receivedAt: number;
};

export type TodoItem = {
  id: string;
  content: string;
  status: string;
  priority: string;
};

export type ModelRef = {
  providerID: string;
  modelID: string;
};

export type ModelOption = {
  providerID: string;
  modelID: string;
  title: string;
  description?: string;
  footer?: string;
  disabled?: boolean;
  isFree: boolean;
  isConnected: boolean;
  keepVisibleWhenDisconnected?: boolean;
};

export type SelectedSessionSnapshot = {
  session: Session | null;
  status: string;
  modelLabel: string;
};

export type WorkspaceState = {
  active: WorkspaceInfo | null;
  path: string;
  root: string;
};

export type ScheduledJob = TauriScheduledJob;

export type PluginState = {
  scope: PluginScope;
  config: OpencodeConfigFile | null;
  list: string[];
};

export type WorkspaceDisplay = WorkspaceInfo & {
  name: string;
};

export type UpdateHandle = {
  available: boolean;
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  rawJson: Record<string, unknown>;
  close: () => Promise<void>;
  download: (onEvent?: (event: any) => void) => Promise<void>;
  install: () => Promise<void>;
  downloadAndInstall: (onEvent?: (event: any) => void) => Promise<void>;
};
