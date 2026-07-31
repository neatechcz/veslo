import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { validateMcpServerName } from "../mcp-validation";
import { isTauriRuntime } from "../utils/paths";
import { wrapStartupRequestAuditFetch } from "./startup-request-audit";
import { createEngineInfoLoader } from "./engine-info-loader";
import type { ComposerAttachment, ComposerDraft, ComposerPart, ModelRef, SkillInventoryRegistryMetadata } from "../types";
import type { OpencodeConfigFile, ScheduledJob, WorkspaceInfo } from "./tauri-types";

export type { OpencodeConfigFile, ScheduledJob, ScheduledJobRun, WorkspaceInfo } from "./tauri-types";

export const VESLO_SERVER_STATE_EVENT = "veslo://server-state";

export const RUNTIME_ENGINE_STATES = [
  "absent",
  "starting",
  "process_ready",
  "workspace_api_waiting",
  "ready",
  "stopped",
  "failed",
] as const;

export type RuntimeEngineState = (typeof RUNTIME_ENGINE_STATES)[number];

export type RuntimeSkillBinding = {
  revision: string;
  authorizationRevision: string;
};

export type EngineInfo = {
  running: boolean;
  runtime: "direct" | "veslo-orchestrator";
  engineState?: RuntimeEngineState | null;
  childKind?: "direct" | "wsl" | null;
  baseUrl: string | null;
  projectDir: string | null;
  hostname: string | null;
  port: number | null;
  opencodeUsername: string | null;
  opencodePassword: string | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
};

export type VesloServerLifecycleStatus =
  | "stopped"
  | "starting"
  | "waiting_ready"
  | "running"
  | "exited"
  | "blocked";

export type VesloServerLifecycleReason =
  | "none"
  | "spawn_pending"
  | "port_unavailable"
  | "spawn_failed"
  | "child_exited"
  | "health_unreachable"
  | "token_missing"
  | "identity_mismatch";

export type VesloServerInfo = {
  running: boolean;
  lifecycleStatus?: VesloServerLifecycleStatus;
  lifecycleReason?: VesloServerLifecycleReason;
  host: string | null;
  port: number | null;
  instanceId: string | null;
  baseUrl: string | null;
  connectUrl: string | null;
  mdnsUrl: string | null;
  lanUrl: string | null;
  engineUrl: string | null;
  clientToken: string | null;
  hostToken: string | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
};

type ManagedAiAccessProofCommandModelRef = {
  providerId: string;
  modelId: string;
};

type ManagedAiAccessProofCommandRead = {
  fetchedAt: number;
  providerId: string;
  effectiveModel: ManagedAiAccessProofCommandModelRef;
  updatedAt: string | null;
  runtimeConfigFingerprint?: string | null;
};

export type ManagedAiAccessProofRead = {
  fetchedAt: number;
  providerId: string;
  effectiveModel: ModelRef;
  updatedAt: string | null;
  runtimeConfigFingerprint?: string | null;
};

export type ManagedAiAccessProofWrite = {
  providerId: string;
  effectiveModel: ModelRef;
  updatedAt: string | null;
  runtimeConfigFingerprint?: string | null;
};

export type OrchestratorDaemonState = {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: number;
};

export type OrchestratorOpencodeState = {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: number;
};

export type OrchestratorBinaryInfo = {
  path: string;
  source: string;
  expectedVersion?: string | null;
  actualVersion?: string | null;
};

export type OrchestratorBinaryState = {
  opencode?: OrchestratorBinaryInfo | null;
};

export type OrchestratorSidecarInfo = {
  dir?: string | null;
  baseUrl?: string | null;
  manifestUrl?: string | null;
  target?: string | null;
  source?: string | null;
  opencodeSource?: string | null;
  allowExternal?: boolean | null;
};

export type OrchestratorWorkspace = {
  id: string;
  name: string;
  path: string;
  workspaceType: string;
  baseUrl?: string | null;
  directory?: string | null;
  createdAt?: number | null;
  lastUsedAt?: number | null;
};

export type OrchestratorStatus = {
  running: boolean;
  dataDir: string;
  daemon: OrchestratorDaemonState | null;
  opencode: OrchestratorOpencodeState | null;
  engineTopology?: string | null;
  cliVersion?: string | null;
  sidecar?: OrchestratorSidecarInfo | null;
  binaries?: OrchestratorBinaryState | null;
  activeId: string | null;
  workspaceCount: number;
  workspaces: OrchestratorWorkspace[];
  engines?: OrchestratorEngineSnapshot[];
  lastError: string | null;
};

export type EngineDoctorResult = {
  found: boolean;
  inPath: boolean;
  resolvedPath: string | null;
  version: string | null;
  supportsServe: boolean;
  notes: string[];
  serveHelpStatus: number | null;
  serveHelpStdout: string | null;
  serveHelpStderr: string | null;
};

export type WorkspaceList = {
  activeId: string;
  workspaces: WorkspaceInfo[];
};

export type WorkspaceFolderTransferResult = {
  kind: "ok" | "conflict";
  conflicts: string[];
};

export type WorkspaceExportSummary = {
  outputPath: string;
  included: number;
  excluded: string[];
};

export type PendingSessionDraftKind = "new-private" | "directory";

export type PendingSessionDraftCommand = NonNullable<ComposerDraft["command"]>;

export type PendingSessionDraftAttachmentSummary = Omit<ComposerAttachment, "dataUrl">;

export type PendingSessionDraftSummary = {
  id: string;
  kind: PendingSessionDraftKind;
  workspaceId: string;
  directory?: string | null;
  privateWorkspaceId?: string | null;
  createdAt: number;
  updatedAt: number;
  composer: {
    mode: ComposerDraft["mode"];
    parts: ComposerPart[];
    attachments: PendingSessionDraftAttachmentSummary[];
    text: string;
    resolvedText?: string | null;
    command?: PendingSessionDraftCommand | null;
  };
};

export type PendingSessionDraft = {
  id: string;
  kind: PendingSessionDraftKind;
  workspaceId: string;
  directory?: string | null;
  privateWorkspaceId?: string | null;
  createdAt: number;
  updatedAt: number;
  composer: ComposerDraft;
};

export type PendingSessionDraftAttachmentFailure = {
  attachmentId: string;
  name: string;
  message: string;
};

export type PendingSessionDraftGetResult = {
  draft: PendingSessionDraft;
  attachmentFailures: PendingSessionDraftAttachmentFailure[];
};

type RawPendingSessionDraftAttachmentSummary = PendingSessionDraftAttachmentSummary;

type RawPendingSessionDraftAttachmentPayload = PendingSessionDraftAttachmentSummary & {
  bytes: number[];
};

type RawPendingSessionDraftComposerSummary = {
  mode: ComposerDraft["mode"];
  parts: ComposerPart[];
  attachments: PendingSessionDraftAttachmentSummary[];
  text: string;
  resolvedText?: string | null;
  command?: PendingSessionDraftCommand | null;
};

type RawPendingSessionDraftComposerPayload = {
  mode: ComposerDraft["mode"];
  parts: ComposerPart[];
  attachments: RawPendingSessionDraftAttachmentPayload[];
  text: string;
  resolvedText?: string | null;
  command?: PendingSessionDraftCommand | null;
};

type RawPendingSessionDraftSummary = PendingSessionDraftSummary;

type RawPendingSessionDraft = Omit<PendingSessionDraft, "composer"> & {
  composer: RawPendingSessionDraftComposerPayload;
};

type RawPendingSessionDraftGetResult = {
  draft: RawPendingSessionDraft;
  attachmentFailures: PendingSessionDraftAttachmentFailure[];
};

type RawPendingSessionDraftAttachmentInput = RawPendingSessionDraftAttachmentSummary & {
  bytes: number[];
};

const auditedTauriFetch = wrapStartupRequestAuditFetch(
  tauriFetch as unknown as typeof globalThis.fetch,
  "tauri.command-http",
);

type RawPendingSessionDraftComposerInput = Omit<
  RawPendingSessionDraftComposerSummary,
  "attachments"
> & {
  attachments: RawPendingSessionDraftAttachmentInput[];
};

export type PendingSessionDraftPutInput = Omit<PendingSessionDraft, "composer"> & {
  composer: ComposerDraft;
};

const dataUrlToBytes = async (dataUrl: string, attachmentName: string): Promise<number[]> => {
  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error(`Failed to read attachment ${attachmentName}.`);
  }
  return Array.from(new Uint8Array(await response.arrayBuffer()));
};

const bytesToDataUrl = (bytes: number[], mimeType: string): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === "string") {
      resolve(reader.result);
      return;
    }
    reject(new Error("Failed to rebuild pending draft attachment data URL."));
  };
  reader.onerror = () => {
    reject(new Error("Failed to rebuild pending draft attachment data URL."));
  };
  reader.readAsDataURL(new Blob([new Uint8Array(bytes)], { type: mimeType || "application/octet-stream" }));
});

const serializePendingSessionDraftComposer = async (
  composer: ComposerDraft,
): Promise<RawPendingSessionDraftComposerInput> => ({
  mode: composer.mode,
  parts: composer.parts,
  attachments: await Promise.all(
    composer.attachments.map(async (attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      kind: attachment.kind,
      bytes: await dataUrlToBytes(attachment.dataUrl, attachment.name),
    })),
  ),
  text: composer.text,
  resolvedText: composer.resolvedText ?? null,
  command: composer.command ?? null,
});

const deserializePendingSessionDraft = async (
  draft: RawPendingSessionDraft,
): Promise<PendingSessionDraft> => ({
  id: draft.id,
  kind: draft.kind,
  workspaceId: draft.workspaceId,
  directory: draft.directory ?? null,
  privateWorkspaceId: draft.privateWorkspaceId ?? null,
  createdAt: draft.createdAt,
  updatedAt: draft.updatedAt,
  composer: {
    mode: draft.composer.mode,
    parts: draft.composer.parts,
    attachments: await Promise.all(
      draft.composer.attachments.map(async (attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        kind: attachment.kind,
        dataUrl: await bytesToDataUrl(attachment.bytes, attachment.mimeType),
      })),
    ),
    text: draft.composer.text,
    resolvedText: draft.composer.resolvedText ?? undefined,
    command: draft.composer.command ?? undefined,
  },
});

export async function readClipboardFilePaths(): Promise<string[]> {
  if (!isTauriRuntime()) return [];
  try {
    const paths = await invoke<string[]>("clipboard_file_paths");
    return paths.map((path) => path.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const toCommandModelRef = (model: ModelRef): ManagedAiAccessProofCommandModelRef => ({
  providerId: model.providerID,
  modelId: model.modelID,
});

const fromCommandModelRef = (model: ManagedAiAccessProofCommandModelRef): ModelRef => ({
  providerID: model.providerId,
  modelID: model.modelId,
});

export async function accessProofAiRead(input: {
  cacheKey: string;
  maxAgeMs: number;
}): Promise<ManagedAiAccessProofRead | null> {
  if (!isTauriRuntime()) return null;
  const result = await invoke<ManagedAiAccessProofCommandRead | null>("access_proof_ai_read", {
    cacheKey: input.cacheKey,
    maxAgeMs: input.maxAgeMs,
  });
  if (!result) return null;
  return {
    fetchedAt: result.fetchedAt,
    providerId: result.providerId,
    effectiveModel: fromCommandModelRef(result.effectiveModel),
    updatedAt: result.updatedAt ?? null,
    runtimeConfigFingerprint: result.runtimeConfigFingerprint ?? null,
  };
}

export async function accessProofAiWrite(input: {
  cacheKey: string;
  proof: ManagedAiAccessProofWrite;
}): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("access_proof_ai_write", {
    cacheKey: input.cacheKey,
    proof: {
      providerId: input.proof.providerId,
      effectiveModel: toCommandModelRef(input.proof.effectiveModel),
      updatedAt: input.proof.updatedAt,
      runtimeConfigFingerprint: input.proof.runtimeConfigFingerprint ?? null,
    },
  });
}

export async function accessProofAiClear(cacheKey?: string | null): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("access_proof_ai_clear", {
    cacheKey: cacheKey?.trim() || null,
  });
}

export async function pendingSessionDraftsList(): Promise<PendingSessionDraftSummary[]> {
  return invoke<RawPendingSessionDraftSummary[]>("pending_session_drafts_list");
}

export async function pendingSessionDraftsGet(
  draftId: string,
): Promise<PendingSessionDraftGetResult | null> {
  const safeDraftId = draftId.trim();
  if (!safeDraftId) {
    throw new Error("draftId is required");
  }

  const result = await invoke<RawPendingSessionDraftGetResult | null>("pending_session_drafts_get", {
    draftId: safeDraftId,
  });
  if (!result) {
    return null;
  }

  return {
    draft: await deserializePendingSessionDraft(result.draft),
    attachmentFailures: result.attachmentFailures,
  };
}

export async function pendingSessionDraftsPut(
  draft: PendingSessionDraftPutInput,
): Promise<PendingSessionDraftSummary> {
  return invoke<RawPendingSessionDraftSummary>("pending_session_drafts_put", {
    draft: {
      id: draft.id,
      kind: draft.kind,
      workspaceId: draft.workspaceId,
      directory: draft.directory ?? null,
      privateWorkspaceId: draft.privateWorkspaceId ?? null,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      composer: await serializePendingSessionDraftComposer(draft.composer),
    },
  });
}

export async function pendingSessionDraftsDelete(draftId: string): Promise<boolean> {
  const safeDraftId = draftId.trim();
  if (!safeDraftId) {
    throw new Error("draftId is required");
  }

  return invoke<boolean>("pending_session_drafts_delete", { draftId: safeDraftId });
}

export async function engineStart(
  projectDir: string,
  options?: {
    preferSidecar?: boolean;
    runtime?: "direct" | "veslo-orchestrator";
    workspacePaths?: string[];
    opencodeBinPath?: string | null;
    // VSLO-171 F3Ú9: Performance settings forwarded to orchestrator daemon.
    maxEngines?: number | null;
    idleSuspendMs?: number | null;
  },
): Promise<EngineInfo> {
  return invoke<EngineInfo>("engine_start", {
    projectDir,
    preferSidecar: options?.preferSidecar ?? false,
    opencodeBinPath: options?.opencodeBinPath ?? null,
    runtime: options?.runtime ?? null,
    workspacePaths: options?.workspacePaths ?? null,
    maxEngines: options?.maxEngines ?? null,
    idleSuspendMs: options?.idleSuspendMs ?? null,
  });
}

export type WorkspaceRuntimePrepareAction = "fresh_start" | "orchestrator_activate";

export type WorkspaceRuntimePrepareResult = {
  ok: boolean;
  action: WorkspaceRuntimePrepareAction;
  reason: string;
  engine: EngineInfo;
};

const loadEngineInfo = createEngineInfoLoader<EngineInfo>((input) =>
  invoke<EngineInfo>("engine_info", input),
);

/**
 * Starts only the local orchestrator control plane needed by a server-owned
 * submit. It never activates the target workspace engine.
 */
export async function runtimeEnsureAdmissionTransport(input: {
  workspaceId?: string | null;
  workspacePath: string;
}): Promise<EngineInfo> {
  return invoke<EngineInfo>("runtime_ensure_admission_transport", {
    workspaceId: input.workspaceId ?? null,
    workspacePath: input.workspacePath,
  });
}

export async function runtimePrepareWorkspace(input: {
  projectDir: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
  traceId?: string | null;
  skillBinding?: RuntimeSkillBinding | null;
  reason?: string | null;
  forceFreshRuntime?: boolean;
  preferSidecar?: boolean;
  runtime?: "direct" | "veslo-orchestrator";
  workspacePaths?: string[];
  opencodeBinPath?: string | null;
  maxEngines?: number | null;
  idleSuspendMs?: number | null;
}): Promise<WorkspaceRuntimePrepareResult> {
  return invoke<WorkspaceRuntimePrepareResult>("runtime_prepare_workspace", {
    projectDir: input.projectDir,
    workspaceId: input.workspaceId ?? null,
    workspaceName: input.workspaceName ?? null,
    traceId: input.traceId ?? null,
    skillBinding: input.skillBinding ?? null,
    reason: input.reason ?? null,
    forceFreshRuntime: input.forceFreshRuntime ?? false,
    preferSidecar: input.preferSidecar ?? false,
    opencodeBinPath: input.opencodeBinPath ?? null,
    runtime: input.runtime ?? null,
    workspacePaths: input.workspacePaths ?? null,
    maxEngines: input.maxEngines ?? null,
    idleSuspendMs: input.idleSuspendMs ?? null,
  });
}

export async function workspaceBootstrap(): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_bootstrap");
}

export async function workspaceSetActive(
  workspaceId: string,
  options?: { promoteToFront?: boolean },
): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_set_active", {
    workspaceId,
    promoteToFront: options?.promoteToFront ?? false,
  });
}

export async function workspaceCreate(input: {
  folderPath: string;
  name: string;
  preset: string;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_create", {
    folderPath: input.folderPath,
    name: input.name,
    preset: input.preset,
  });
}

export async function workspacePrivateRoot(): Promise<string> {
  return invoke<string>("workspace_private_root");
}

export async function workspaceCopyIntoFolder(input: {
  sourcePath: string;
  targetPath: string;
  overwrite?: boolean;
}): Promise<WorkspaceFolderTransferResult> {
  return invoke<WorkspaceFolderTransferResult>("workspace_copy_into_folder", {
    sourcePath: input.sourcePath,
    targetPath: input.targetPath,
    overwrite: input.overwrite ?? false,
  });
}

export async function workspaceCreateRemote(input: {
  baseUrl: string;
  directory?: string | null;
  displayName?: string | null;
  remoteType?: "veslo" | "opencode" | null;
  vesloHostUrl?: string | null;
  vesloToken?: string | null;
  vesloWorkspaceId?: string | null;
  vesloWorkspaceName?: string | null;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_create_remote", {
    baseUrl: input.baseUrl,
    directory: input.directory ?? null,
    displayName: input.displayName ?? null,
    remoteType: input.remoteType ?? null,
    vesloHostUrl: input.vesloHostUrl ?? null,
    vesloToken: input.vesloToken ?? null,
    vesloWorkspaceId: input.vesloWorkspaceId ?? null,
    vesloWorkspaceName: input.vesloWorkspaceName ?? null,
  });
}

export async function workspaceUpdateRemote(input: {
  workspaceId: string;
  baseUrl?: string | null;
  directory?: string | null;
  displayName?: string | null;
  remoteType?: "veslo" | "opencode" | null;
  vesloHostUrl?: string | null;
  vesloToken?: string | null;
  vesloWorkspaceId?: string | null;
  vesloWorkspaceName?: string | null;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_update_remote", {
    workspaceId: input.workspaceId,
    baseUrl: input.baseUrl ?? null,
    directory: input.directory ?? null,
    displayName: input.displayName ?? null,
    remoteType: input.remoteType ?? null,
    vesloHostUrl: input.vesloHostUrl ?? null,
    vesloToken: input.vesloToken ?? null,
    vesloWorkspaceId: input.vesloWorkspaceId ?? null,
    vesloWorkspaceName: input.vesloWorkspaceName ?? null,
  });
}

export async function workspaceUpdateDisplayName(input: {
  workspaceId: string;
  displayName?: string | null;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_update_display_name", {
    workspaceId: input.workspaceId,
    displayName: input.displayName ?? null,
  });
}

export type WorkspaceForgetMode = "detach_only" | "delete_local_data";

export async function workspaceForget(
  workspaceId: string,
  mode: WorkspaceForgetMode = "detach_only",
): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_forget", { workspaceId, mode });
}

export async function workspaceAddAuthorizedRoot(input: {
  workspacePath: string;
  folderPath: string;
}): Promise<ExecResult> {
  return invoke<ExecResult>("workspace_add_authorized_root", {
    workspacePath: input.workspacePath,
    folderPath: input.folderPath,
  });
}

export async function workspaceGrantFolderAccess(input: {
  workspacePath: string;
  requestedPath: string;
  selectedFolderPath: string;
  accessMode: "read";
}): Promise<ExecResult> {
  return invoke<ExecResult>("workspace_grant_folder_access", {
    workspacePath: input.workspacePath,
    requestedPath: input.requestedPath,
    selectedFolderPath: input.selectedFolderPath,
    accessMode: input.accessMode,
  });
}

export async function workspaceExportConfig(input: {
  workspaceId: string;
  outputPath: string;
}): Promise<WorkspaceExportSummary> {
  return invoke<WorkspaceExportSummary>("workspace_export_config", {
    workspaceId: input.workspaceId,
    outputPath: input.outputPath,
  });
}

export async function workspaceImportConfig(input: {
  archivePath: string;
  targetDir: string;
  name?: string | null;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_import_config", {
    archivePath: input.archivePath,
    targetDir: input.targetDir,
    name: input.name ?? null,
  });
}

export type OpencodeCommandDraft = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
};

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

export async function workspaceVesloRead(input: {
  workspacePath: string;
}): Promise<WorkspaceVesloConfig> {
  return invoke<WorkspaceVesloConfig>("workspace_veslo_read", {
    workspacePath: input.workspacePath,
  });
}

export async function workspaceVesloWrite(input: {
  workspacePath: string;
  config: WorkspaceVesloConfig;
}): Promise<ExecResult> {
  return invoke<ExecResult>("workspace_veslo_write", {
    workspacePath: input.workspacePath,
    config: input.config,
  });
}

export async function opencodeCommandList(input: {
  scope: "workspace" | "global";
  projectDir: string;
}): Promise<string[]> {
  return invoke<string[]>("opencode_command_list", {
    scope: input.scope,
    projectDir: input.projectDir,
  });
}

export async function opencodeCommandWrite(input: {
  scope: "workspace" | "global";
  projectDir: string;
  command: OpencodeCommandDraft;
}): Promise<ExecResult> {
  return invoke<ExecResult>("opencode_command_write", {
    scope: input.scope,
    projectDir: input.projectDir,
    command: input.command,
  });
}

export async function opencodeCommandDelete(input: {
  scope: "workspace" | "global";
  projectDir: string;
  name: string;
}): Promise<ExecResult> {
  return invoke<ExecResult>("opencode_command_delete", {
    scope: input.scope,
    projectDir: input.projectDir,
    name: input.name,
  });
}

export async function engineStop(): Promise<EngineInfo> {
  return invoke<EngineInfo>("engine_stop");
}

export async function engineRestart(): Promise<EngineInfo> {
  return invoke<EngineInfo>("engine_restart");
}

export async function orchestratorStatus(): Promise<OrchestratorStatus> {
  return invoke<OrchestratorStatus>("orchestrator_status");
}

export async function orchestratorWorkspaceActivate(input: {
  workspacePath: string;
  workspaceId?: string | null;
  name?: string | null;
  skillBinding?: RuntimeSkillBinding | null;
}): Promise<OrchestratorWorkspace> {
  return invoke<OrchestratorWorkspace>("orchestrator_workspace_activate", {
    workspacePath: input.workspacePath,
    workspaceId: input.workspaceId ?? null,
    name: input.name ?? null,
    skillBinding: input.skillBinding ?? null,
  });
}

export async function orchestratorInstanceDispose(workspacePath: string): Promise<boolean> {
  return invoke<boolean>("orchestrator_instance_dispose", { workspacePath });
}

export type AppBuildInfo = {
  version: string;
  gitSha?: string | null;
  buildEpoch?: string | null;
};

export async function appBuildInfo(): Promise<AppBuildInfo> {
  return invoke<AppBuildInfo>("app_build_info");
}

export type OrchestratorDetachedHost = {
  vesloUrl: string;
  token: string;
  hostToken: string;
  port: number;
};

export async function orchestratorStartDetached(input: {
  workspacePath: string;
  runId?: string | null;
  vesloToken?: string | null;
  vesloHostToken?: string | null;
}): Promise<OrchestratorDetachedHost> {
  return invoke<OrchestratorDetachedHost>("orchestrator_start_detached", {
    workspacePath: input.workspacePath,
    runId: input.runId ?? null,
    vesloToken: input.vesloToken ?? null,
    vesloHostToken: input.vesloHostToken ?? null,
  });
}

export async function vesloServerInfo(): Promise<VesloServerInfo> {
  return invoke<VesloServerInfo>("veslo_server_info");
}

export async function vesloServerRestart(): Promise<VesloServerInfo> {
  return invoke<VesloServerInfo>("veslo_server_restart");
}

export async function engineInfo(
  workspaceId?: string,
  workspacePath?: string,
): Promise<EngineInfo> {
  return loadEngineInfo(workspaceId, workspacePath);
}

export type OrchestratorEngineSnapshot = {
  workspaceId: string;
  pid: number;
  port: number;
  baseUrl: string;
  workdir: string;
  configDir: string;
  childKind?: "direct" | "wsl" | null;
  sandboxed?: boolean | null;
  configuredSandboxBackend?: string | null;
  effectiveSandboxBackend?: string | null;
  sandboxMode?: "resolved" | "explicit-none" | "disabled-by-env" | "unavailable" | "launch-fallback" | string | null;
  sandboxFallbackReason?: string | null;
  state: "spawning" | "ready" | "idle" | "suspended" | "crashed" | string;
  spawnedAt: number;
  lastActivityAt: number;
};

export async function orchestratorEnginesList(): Promise<OrchestratorEngineSnapshot[]> {
  return invoke<OrchestratorEngineSnapshot[]>("orchestrator_engines_list");
}

export async function engineDoctor(options?: {
  preferSidecar?: boolean;
  opencodeBinPath?: string | null;
}): Promise<EngineDoctorResult> {
  return invoke<EngineDoctorResult>("engine_doctor", {
    preferSidecar: options?.preferSidecar ?? false,
    opencodeBinPath: options?.opencodeBinPath ?? null,
  });
}

export async function pickDirectory(options?: {
  title?: string;
  defaultPath?: string;
  multiple?: boolean;
}): Promise<string | string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open({
    title: options?.title,
    defaultPath: options?.defaultPath,
    directory: true,
    multiple: options?.multiple,
  });
}

export async function pickFile(options?: {
  title?: string;
  defaultPath?: string;
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<string | string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open({
    title: options?.title,
    defaultPath: options?.defaultPath,
    directory: false,
    multiple: options?.multiple,
    filters: options?.filters,
  });
}

export async function saveFile(options?: {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    title: options?.title,
    defaultPath: options?.defaultPath,
    filters: options?.filters,
  });
}

export type ExecResult = {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
};

export type DesktopSandboxEnvironment = {
  backend: string;
  enabled: boolean;
};

export type DesktopRuntimePreferences = {
  sharedUnsandboxedEngine: boolean;
  topologySource?: "default" | "migrated" | "explicit-diagnostic";
  supportDiagnostics: boolean;
};

export type UserDiagnosticCaptureStatus = {
  available: boolean;
  canStart: boolean;
  captureId: string | null;
  state: string;
  startedAt: number | null;
  endsAt: number | null;
  capturedEvents: number;
  capturedBytes: number;
  pendingEvents: number;
  acceptedEvents: number;
  droppedRetention: number;
  droppedBudget: number;
  droppedDelivery: number;
  droppedIdentity: number;
  terminalReason: string | null;
};

export async function userDiagnosticCaptureStatus(): Promise<UserDiagnosticCaptureStatus> {
  return invoke<UserDiagnosticCaptureStatus>("user_diagnostic_capture_status");
}

export async function startUserDiagnosticCapture(): Promise<UserDiagnosticCaptureStatus> {
  return invoke<UserDiagnosticCaptureStatus>("start_user_diagnostic_capture");
}

export async function stopUserDiagnosticCapture(): Promise<UserDiagnosticCaptureStatus> {
  return invoke<UserDiagnosticCaptureStatus>("stop_user_diagnostic_capture");
}

export async function createFeedbackDiagnosticSnapshot(): Promise<UserDiagnosticCaptureStatus> {
  return invoke<UserDiagnosticCaptureStatus>("create_feedback_diagnostic_snapshot");
}

export async function queueFeedbackDiagnosticSnapshotForDelivery(captureId: string): Promise<UserDiagnosticCaptureStatus> {
  return invoke<UserDiagnosticCaptureStatus>("queue_feedback_diagnostic_snapshot_for_delivery", { captureId });
}

export async function engineInstall(): Promise<ExecResult> {
  return invoke<ExecResult>("engine_install");
}

export async function wslSandboxRepair(options?: {
  checkOnly?: boolean;
  force?: boolean;
}): Promise<ExecResult> {
  return invoke<ExecResult>("wsl_sandbox_repair", {
    checkOnly: options?.checkOnly ?? false,
    force: options?.force ?? false,
  });
}

export async function wslPrerequisitesRepair(options?: {
  checkOnly?: boolean;
}): Promise<ExecResult> {
  return invoke<ExecResult>("wsl_prerequisites_repair", {
    checkOnly: options?.checkOnly ?? false,
  });
}

export async function desktopSandboxEnvironment(): Promise<DesktopSandboxEnvironment> {
  return invoke<DesktopSandboxEnvironment>("desktop_sandbox_environment");
}

export async function desktopRuntimePreferencesRead(): Promise<DesktopRuntimePreferences> {
  return invoke<DesktopRuntimePreferences>("desktop_runtime_preferences_read");
}

export async function desktopRuntimePreferencesWrite(
  preferences: DesktopRuntimePreferences,
): Promise<DesktopRuntimePreferences> {
  return invoke<DesktopRuntimePreferences>("desktop_runtime_preferences_write", { preferences });
}

export async function opkgInstall(projectDir: string, pkg: string): Promise<ExecResult> {
  return invoke<ExecResult>("opkg_install", { projectDir, package: pkg });
}

export async function importSkill(
  projectDir: string,
  sourceDir: string,
  options?: { overwrite?: boolean },
): Promise<ExecResult> {
  return invoke<ExecResult>("import_skill", {
    projectDir,
    sourceDir,
    overwrite: options?.overwrite ?? false,
  });
}

export async function installSkillTemplate(
  projectDir: string,
  name: string,
  content: string,
  options?: { overwrite?: boolean },
): Promise<ExecResult> {
  return invoke<ExecResult>("install_skill_template", {
    projectDir,
    name,
    content,
    overwrite: options?.overwrite ?? false,
  });
}

export async function installGlobalSkillTemplate(
  name: string,
  content: string,
  options?: { overwrite?: boolean },
): Promise<ExecResult> {
  return invoke<ExecResult>("install_global_skill_template", {
    name,
    content,
    overwrite: options?.overwrite ?? false,
  });
}

export type LocalSkillCard = {
  name: string;
  path: string;
  description?: string;
  trigger?: string;
  registry?: SkillInventoryRegistryMetadata;
};

export type LocalSkillContent = {
  path: string;
  content: string;
};

export type LocalSkillFile = {
  path: string;
  sizeBytes: number;
  mediaType: string;
  executable?: boolean;
  text?: string;
};

export type LocalSkillListScope = "workspace" | "global" | "effective";

export async function listLocalSkills(projectDir: string): Promise<LocalSkillCard[]> {
  return invoke<LocalSkillCard[]>("list_local_skills", { projectDir });
}

export async function listLocalSkillsScoped(
  projectDir: string,
  scope: LocalSkillListScope,
): Promise<LocalSkillCard[]> {
  return invoke<LocalSkillCard[]>("list_local_skills_scoped", { projectDir, scope });
}

export async function readLocalSkill(projectDir: string, name: string): Promise<LocalSkillContent> {
  return invoke<LocalSkillContent>("read_local_skill", { projectDir, name });
}

export async function readLocalSkillAtPath(projectDir: string, name: string, path: string): Promise<LocalSkillContent> {
  return invoke<LocalSkillContent>("read_local_skill_at_path", { projectDir, name, path });
}

export async function readLocalSkillFilesAtPath(projectDir: string, name: string, path: string): Promise<LocalSkillFile[]> {
  return invoke<LocalSkillFile[]>("read_local_skill_files_at_path", { projectDir, name, path });
}

export async function writeLocalSkill(projectDir: string, name: string, content: string): Promise<ExecResult> {
  return invoke<ExecResult>("write_local_skill", { projectDir, name, content });
}

export async function writeLocalSkillAtPath(projectDir: string, name: string, path: string, content: string): Promise<ExecResult> {
  return invoke<ExecResult>("write_local_skill_at_path", { projectDir, name, path, content });
}

export async function uninstallSkill(projectDir: string, name: string): Promise<ExecResult> {
  return invoke<ExecResult>("uninstall_skill", { projectDir, name });
}

export async function uninstallSkillAtPath(projectDir: string, name: string, path: string): Promise<ExecResult> {
  return invoke<ExecResult>("uninstall_skill_at_path", { projectDir, name, path });
}

export type UpdaterEnvironment = {
  supported: boolean;
  reason: string | null;
  executablePath: string | null;
  appBundlePath: string | null;
};

export async function updaterEnvironment(): Promise<UpdaterEnvironment> {
  return invoke<UpdaterEnvironment>("updater_environment");
}

export async function updaterPrepareInstall(): Promise<void> {
  return invoke<void>("updater_prepare_install");
}

export async function updaterRelaunchAfterInstall(): Promise<void> {
  return invoke<void>("updater_relaunch_after_install");
}

export async function readOpencodeConfig(
  scope: "project" | "global",
  projectDir: string,
): Promise<OpencodeConfigFile> {
  return invoke<OpencodeConfigFile>("read_opencode_config", { scope, projectDir });
}

export async function writeOpencodeConfig(
  scope: "project" | "global",
  projectDir: string,
  content: string,
): Promise<ExecResult> {
  return invoke<ExecResult>("write_opencode_config", { scope, projectDir, content });
}

export async function resetVesloState(mode: "onboarding" | "all"): Promise<void> {
  return invoke<void>("reset_veslo_state", { mode });
}

export type CacheResetResult = {
  removed: string[];
  missing: string[];
  errors: string[];
};

export async function resetOpencodeCache(): Promise<CacheResetResult> {
  return invoke<CacheResetResult>("reset_opencode_cache");
}

export async function obsidianIsAvailable(): Promise<boolean> {
  return invoke<boolean>("obsidian_is_available");
}

export async function openInObsidian(filePath: string): Promise<void> {
  const safePath = filePath.trim();
  if (!safePath) {
    throw new Error("filePath is required");
  }
  return invoke<void>("open_in_obsidian", { filePath: safePath });
}

export async function writeObsidianMirrorFile(
  workspaceId: string,
  filePath: string,
  content: string,
): Promise<string> {
  const safeWorkspaceId = workspaceId.trim();
  const safePath = filePath.trim();
  if (!safeWorkspaceId) {
    throw new Error("workspaceId is required");
  }
  if (!safePath) {
    throw new Error("filePath is required");
  }
  return invoke<string>("write_obsidian_mirror_file", {
    workspaceId: safeWorkspaceId,
    filePath: safePath,
    content,
  });
}

export type ObsidianMirrorFileContent = {
  exists: boolean;
  path: string;
  content: string | null;
  updatedAtMs: number | null;
};

export async function readObsidianMirrorFile(
  workspaceId: string,
  filePath: string,
): Promise<ObsidianMirrorFileContent> {
  const safeWorkspaceId = workspaceId.trim();
  const safePath = filePath.trim();
  if (!safeWorkspaceId) {
    throw new Error("workspaceId is required");
  }
  if (!safePath) {
    throw new Error("filePath is required");
  }
  return invoke<ObsidianMirrorFileContent>("read_obsidian_mirror_file", {
    workspaceId: safeWorkspaceId,
    filePath: safePath,
  });
}

export async function schedulerListJobs(scopeRoot?: string): Promise<ScheduledJob[]> {
  return invoke<ScheduledJob[]>("scheduler_list_jobs", { scopeRoot });
}

export async function schedulerDeleteJob(name: string, scopeRoot?: string): Promise<ScheduledJob> {
  return invoke<ScheduledJob>("scheduler_delete_job", { name, scopeRoot });
}

// OpenCodeRouter types
export type OpenCodeRouterIdentityItem = {
  id: string;
  enabled: boolean;
  running?: boolean;
};

export type OpenCodeRouterChannelStatus = {
  items: OpenCodeRouterIdentityItem[];
};

export type OpenCodeRouterStatus = {
  running: boolean;
  config: string;
  healthPort?: number | null;
  telegram: OpenCodeRouterChannelStatus;
  slack: OpenCodeRouterChannelStatus;
  opencode: { url: string; directory?: string };
};

export type OpenCodeRouterStatusResult =
  | { ok: true; status: OpenCodeRouterStatus }
  | { ok: false; error: string };

export type OpenCodeRouterInfo = {
  running: boolean;
  version: string | null;
  workspacePath: string | null;
  opencodeUrl: string | null;
  healthPort: number | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
};

// OpenCodeRouter functions - call Tauri commands that wrap opencodeRouter CLI
export async function getOpenCodeRouterStatus(): Promise<OpenCodeRouterStatus | null> {
  try {
    return await invoke<OpenCodeRouterStatus>("opencodeRouter_status");
  } catch {
    return null;
  }
}

export async function getOpenCodeRouterStatusDetailed(): Promise<OpenCodeRouterStatusResult> {
  try {
    const status = await invoke<OpenCodeRouterStatus>("opencodeRouter_status");
    return { ok: true, status };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function opencodeRouterInfo(): Promise<OpenCodeRouterInfo> {
  return invoke<OpenCodeRouterInfo>("opencodeRouter_info");
}

export async function getOpenCodeRouterGroupsEnabled(): Promise<boolean | null> {
  try {
    const status = await getOpenCodeRouterStatus();
    const healthPort = status?.healthPort ?? 3005;
    const response = await (isTauriRuntime() ? auditedTauriFetch : fetch)(`http://127.0.0.1:${healthPort}/config/groups`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return data?.groupsEnabled ?? null;
  } catch {
    return null;
  }
}

export async function setOpenCodeRouterGroupsEnabled(enabled: boolean): Promise<ExecResult> {
  try {
    const status = await getOpenCodeRouterStatus();
    const healthPort = status?.healthPort ?? 3005;
    const response = await (isTauriRuntime() ? auditedTauriFetch : fetch)(`http://127.0.0.1:${healthPort}/config/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!response.ok) {
      const message = await response.text();
      return { ok: false, status: response.status, stdout: "", stderr: message };
    }
    return { ok: true, status: 0, stdout: "", stderr: "" };
  } catch (e) {
    return { ok: false, status: 1, stdout: "", stderr: String(e) };
  }
}

export async function opencodeDbMigrate(input: {
  projectDir: string;
  preferSidecar?: boolean;
  opencodeBinPath?: string | null;
}): Promise<ExecResult> {
  const safeProjectDir = input.projectDir.trim();
  if (!safeProjectDir) {
    throw new Error("project_dir is required");
  }

  return invoke<ExecResult>("opencode_db_migrate", {
    projectDir: safeProjectDir,
    preferSidecar: input.preferSidecar ?? false,
    opencodeBinPath: input.opencodeBinPath ?? null,
  });
}

export async function opencodeMcpAuth(
  projectDir: string,
  serverName: string,
): Promise<ExecResult> {
  const safeProjectDir = projectDir.trim();
  if (!safeProjectDir) {
    throw new Error("project_dir is required");
  }

  const safeServerName = validateMcpServerName(serverName);

  return invoke<ExecResult>("opencode_mcp_auth", {
    projectDir: safeProjectDir,
    serverName: safeServerName,
  });
}

export async function opencodeDbUpdateSessionDirectory(input: {
  sessionId: string;
  oldDirectory: string;
  directory: string;
}): Promise<ExecResult> {
  return invoke<ExecResult>("opencode_db_update_session_directory", {
    sessionId: input.sessionId,
    oldDirectory: input.oldDirectory,
    directory: input.directory,
  });
}

export async function opencodeRouterStop(): Promise<OpenCodeRouterInfo> {
  return invoke<OpenCodeRouterInfo>("opencodeRouter_stop");
}

export async function opencodeRouterStart(options: {
  workspacePath: string;
  opencodeUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  healthPort?: number;
}): Promise<OpenCodeRouterInfo> {
  return invoke<OpenCodeRouterInfo>("opencodeRouter_start", {
    workspacePath: options.workspacePath,
    opencodeUrl: options.opencodeUrl ?? null,
    opencodeUsername: options.opencodeUsername ?? null,
    opencodePassword: options.opencodePassword ?? null,
    healthPort: options.healthPort ?? null,
  });
}

export async function opencodeRouterRestart(options: {
  workspacePath: string;
  opencodeUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  healthPort?: number;
}): Promise<OpenCodeRouterInfo> {
  await opencodeRouterStop();
  return opencodeRouterStart(options);
}

/**
 * Set window decorations (titlebar) visibility.
 * When `decorations` is false, the native titlebar is hidden.
 * Useful for tiling window managers on Linux (e.g., Hyprland, i3, sway).
 */
export async function setWindowDecorations(decorations: boolean): Promise<void> {
  return invoke<void>("set_window_decorations", { decorations });
}

/**
 * Set current window title bar style.
 * Note: Tauri supports this on macOS only.
 */
export async function setWindowTitleBarStyle(
  style: "visible" | "transparent" | "overlay",
): Promise<void> {
  if (!isTauriRuntime()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  try {
    await getCurrentWindow().setTitleBarStyle(style);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[tauri.setWindowTitleBarStyle] Failed to set title bar style "${style}": ${message}`);
  }
}

/**
 * Set the current native window title.
 */
export async function setWindowTitle(title: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  try {
    await getCurrentWindow().setTitle(title);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[tauri.setWindowTitle] Failed to set window title "${title}": ${message}`);
  }
}

export async function minimizeCurrentWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  try {
    await getCurrentWindow().minimize();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[tauri.minimizeCurrentWindow] Failed to minimize window: ${message}`);
  }
}

export async function toggleMaximizeCurrentWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  try {
    await getCurrentWindow().toggleMaximize();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[tauri.toggleMaximizeCurrentWindow] Failed to toggle maximize: ${message}`);
  }
}

export async function closeCurrentWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  try {
    await getCurrentWindow().close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[tauri.closeCurrentWindow] Failed to close window: ${message}`);
  }
}

/**
 * Start dragging the current native window.
 * Intended as a reliability fallback for custom drag regions.
 */
export async function startWindowDragging(): Promise<void> {
  if (!isTauriRuntime()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  try {
    await getCurrentWindow().startDragging();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[tauri.startWindowDragging] Failed to start drag: ${message}`);
  }
}

/**
 * VSLO-86 — forward a webview log line to the Tauri stderr (and thus to
 * /tmp/veslo.log) so workspace activation, ensureEngine, SSE, and message-send
 * diagnostics survive without opening DevTools. Fire-and-forget; silently
 * drops outside the Tauri runtime.
 */
export function logUiEvent(scope: string, message: string, payload?: unknown): void {
  if (!isTauriRuntime()) return;
  let serialized: string | undefined;
  if (payload !== undefined) {
    try {
      serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
    } catch {
      serialized = String(payload);
    }
  }
  void invoke("log_ui_event", { scope, message, payload: serialized }).catch(() => {});
}
