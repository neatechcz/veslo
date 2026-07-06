import type {
  AgentPartInput,
  FilePartInput,
  SubtaskPartInput,
  TextPartInput,
} from "@opencode-ai/sdk/v2/client";

import {
  parseVesloWorkspaceIdFromUrl,
  VesloServerError,
} from "../lib/veslo-server";
import { resolveRunningVesloServerHostInfo } from "../lib/veslo-server-host";
import {
  pickCollisionSafeName,
  toWorkspaceRelativeFromSessionDir,
} from "../lib/session-attachment-staging";
import type { StagedSessionAttachment } from "../lib/attachment-prompt-routing";
import { messageFromUnknownError } from "../context/send-runtime-readiness";
import type { ComposerAttachment, ComposerDraft, StartupPreference } from "../types";
import { normalizeDirectoryPath } from "../utils";

export type SessionAttachmentPartInput =
  | TextPartInput
  | FilePartInput
  | AgentPartInput
  | SubtaskPartInput;

export type SessionAttachmentWorkspaceEntry = {
  id: string;
  path?: string | null;
  directory?: string | null;
  opencode?: {
    directory?: string | null;
  } | null;
};

export type SessionAttachmentStagingClient = {
  listWorkspaces: () => Promise<{
    activeId?: string | null;
    items?: SessionAttachmentWorkspaceEntry[] | null;
  }>;
  createFileSession: (
    workspaceId: string,
    options: { ttlSeconds: number; write: true },
  ) => Promise<{ session: { id: string } }>;
  readFileBatch: (
    fileSessionId: string,
    paths: string[],
  ) => Promise<{
    items: Array<{ ok?: boolean; code?: string | null; message?: string | null }>;
  }>;
  writeFileBatch: (
    fileSessionId: string,
    items: Array<{ path: string; contentBase64: string }>,
  ) => Promise<{
    items: Array<{ ok?: boolean; message?: string | null }>;
  }>;
  closeFileSession: (fileSessionId: string) => Promise<unknown>;
};

export type SessionAttachmentWorkspaceDisplay = {
  workspaceType?: string | null;
  remoteType?: string | null;
  path?: string | null;
  directory?: string | null;
  baseUrl?: string | null;
  vesloHostUrl?: string | null;
  vesloWorkspaceId?: string | null;
};

export type SessionAttachmentBrowseScope = {
  workspaceId?: string | null;
  directory?: string | null;
};

export type SessionAttachmentWorkspaceResolution<
  Client extends SessionAttachmentStagingClient = SessionAttachmentStagingClient,
> = {
  serverClient: Client;
  serverWorkspaceId: string;
};

export type SessionAttachmentSendPreflight = {
  traceId: string;
};

export type SessionAttachmentServerHostInfo = {
  running: boolean;
  baseUrl?: string | null;
  clientToken?: string | null;
  hostToken?: string | null;
};

export type SessionAttachmentStagingDeps<
  Client extends SessionAttachmentStagingClient = SessionAttachmentStagingClient,
  Preflight extends SessionAttachmentSendPreflight = SessionAttachmentSendPreflight,
> = {
  vesloServerClient: () => Client | null;
  vesloServerStatus: () => string;
  vesloServerWorkspaceId: () => string | null | undefined;
  setVesloServerWorkspaceId: (workspaceId: string) => void;
  vesloServerUrl: () => string;
  envVesloWorkspaceId?: string | null;
  workspaceProjectDir: () => string;
  sessionDirectoryForId: (sessionId: string) => string | null | undefined;
  activeWorkspaceId: () => string;
  activeWorkspaceRoot: () => string;
  activeWorkspaceDisplay: () => SessionAttachmentWorkspaceDisplay;
  selectedSessionBrowseScope: (sessionId: string) => SessionAttachmentBrowseScope | null | undefined;
  isTauriRuntime: () => boolean;
  startupPreference: () => StartupPreference | string;
  vesloServerRestart: () => Promise<SessionAttachmentServerHostInfo | null>;
  setVesloServerHostInfoStable: (info: SessionAttachmentServerHostInfo | null) => void;
  setVesloServerStatus: (status: string) => void;
  setVesloServerCapabilitiesStable: (capabilities: unknown) => void;
  setVesloServerCheckedAt: (timestamp: number) => void;
  checkVesloServer: (
    baseUrl: string,
    clientToken?: string,
    hostToken?: string,
  ) => Promise<{ status: string; capabilities: unknown }>;
  resolveConversationServerWorkspaceForSend: (
    workspaceId: string,
    directory: string,
    preflight: Preflight | undefined,
    reason: string,
  ) => Promise<SessionAttachmentWorkspaceResolution<Client> | null>;
  recordSendTrace: (event: string, payload?: Record<string, unknown>) => void;
  sendTraceStep: <T>(
    label: string,
    run: () => Promise<T>,
    payload?: Record<string, unknown>,
  ) => Promise<T>;
  safeStringify: (value: unknown) => string;
};

export type AttachmentStagingWorkspaceReady<
  Client extends SessionAttachmentStagingClient = SessionAttachmentStagingClient,
> = {
  client: Client;
  workspaceId: string;
};

const attachmentToFile = async (attachment: ComposerAttachment): Promise<File> => {
  const response = await fetch(attachment.dataUrl);
  if (!response.ok) {
    throw new Error(`Failed to read attachment ${attachment.name}.`);
  }
  const blob = await response.blob();
  return new File([blob], attachment.name, {
    type: attachment.mimeType || blob.type || "application/octet-stream",
  });
};

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  const fallbackBuffer = (globalThis as {
    Buffer?: { from: (input: Uint8Array) => { toString: (encoding: string) => string } };
  }).Buffer;
  if (fallbackBuffer) {
    return fallbackBuffer.from(bytes).toString("base64");
  }
  if (typeof btoa !== "function") {
    throw new Error("Base64 encoder is unavailable");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const slice = bytes.subarray(index, index + chunkSize);
    for (const byte of slice) {
      binary += String.fromCharCode(byte);
    }
  }
  return btoa(binary);
};

export function createSessionAttachmentStaging<
  Client extends SessionAttachmentStagingClient = SessionAttachmentStagingClient,
  Preflight extends SessionAttachmentSendPreflight = SessionAttachmentSendPreflight,
>(deps: SessionAttachmentStagingDeps<Client, Preflight>) {
  const resolveSessionDirectoryRelativePath = (sessionID: string, filename: string) => {
    const workspaceRoot = deps.workspaceProjectDir().trim();
    const sessionDirectory = (deps.sessionDirectoryForId(sessionID) ?? workspaceRoot).trim();
    if (!workspaceRoot || !sessionDirectory) {
      throw new Error("Session directory is not available for attachment staging.");
    }

    const workspaceRootForCheck = normalizeDirectoryPath(workspaceRoot) || workspaceRoot;
    const sessionDirectoryForCheck = normalizeDirectoryPath(sessionDirectory) || sessionDirectory;
    return toWorkspaceRelativeFromSessionDir({
      workspaceRoot: workspaceRootForCheck,
      sessionDirectory: sessionDirectoryForCheck,
      filename,
    });
  };

  const resolveWorkspaceAbsolutePath = (relativePath: string) => {
    const workspaceRoot = deps.workspaceProjectDir().trim().replace(/[\\/]+$/, "");
    const normalizedRelativePath = relativePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!workspaceRoot || !normalizedRelativePath) {
      throw new Error("Workspace path is not available for staged attachments.");
    }
    return `${workspaceRoot}/${normalizedRelativePath}`;
  };

  const resolveCollisionSafeAttachmentPath = async (
    client: Client,
    fileSessionId: string,
    preferredPath: string,
    reservedPaths: Set<string>,
  ) => {
    const normalizedPreferred = preferredPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    const slashIndex = normalizedPreferred.lastIndexOf("/");
    const directoryRel = slashIndex === -1 ? "" : normalizedPreferred.slice(0, slashIndex);
    const filename = slashIndex === -1 ? normalizedPreferred : normalizedPreferred.slice(slashIndex + 1);
    const knownCollisions = new Set(reservedPaths);

    let attempt = 0;
    while (attempt < 512) {
      const candidatePath = pickCollisionSafeName({
        directoryRel,
        filename,
        existingPaths: knownCollisions,
      });

      const result = await client.readFileBatch(fileSessionId, [candidatePath]);
      const item = result.items[0];
      if (item?.ok) {
        knownCollisions.add(candidatePath);
        attempt += 1;
        continue;
      }
      if (!item || item.code === "file_not_found") {
        reservedPaths.add(candidatePath);
        return candidatePath;
      }
      throw new Error(item.message ?? `Unable to stage ${filename}.`);
    }

    throw new Error(`Failed to resolve a unique filename for ${filename}.`);
  };

  const resolveWorkspaceIdForAttachmentStaging = async (client: Client) => {
    const response = await client.listWorkspaces();
    const items = Array.isArray(response.items) ? response.items : [];
    const active = deps.activeWorkspaceDisplay();
    const cachedWorkspaceId = (deps.vesloServerWorkspaceId() ?? "").trim();
    const listedWorkspaceId = (workspaceId: string | null | undefined) => {
      const id = workspaceId?.trim() ?? "";
      return id && items.some((entry) => entry.id === id) ? id : "";
    };

    let resolved = "";
    if (active.workspaceType === "remote" && active.remoteType === "veslo") {
      const inferredWorkspaceId =
        parseVesloWorkspaceIdFromUrl(active.vesloHostUrl ?? "") ??
        parseVesloWorkspaceIdFromUrl(active.baseUrl ?? "");
      const storedId = active.vesloWorkspaceId?.trim() || inferredWorkspaceId || "";
      resolved =
        listedWorkspaceId(storedId) ||
        listedWorkspaceId(cachedWorkspaceId);
    } else if (active.workspaceType === "local") {
      const mappedWorkspaceId = active.vesloWorkspaceId?.trim() ?? "";
      resolved =
        listedWorkspaceId(mappedWorkspaceId) ||
        listedWorkspaceId(cachedWorkspaceId);
    }

    if (resolved) {
      deps.setVesloServerWorkspaceId(resolved);
    }

    return resolved;
  };

  const recoverWorkspaceReadyForAttachmentStaging = async (
    fallbackClient: Client,
  ): Promise<AttachmentStagingWorkspaceReady<Client>> => {
    const active = deps.activeWorkspaceDisplay();
    if (!deps.isTauriRuntime() || deps.startupPreference() === "server" || active.workspaceType !== "local") {
      throw new Error("Veslo server workspace is not ready for attachments.");
    }

    deps.recordSendTrace("sendPrompt:attachment-workspace-recover", {
      activeWorkspaceId: deps.activeWorkspaceId().trim(),
      activeRoot: deps.activeWorkspaceRoot().trim(),
    });

    const restarted = await deps.vesloServerRestart();
    deps.setVesloServerHostInfoStable(restarted);
    const running = resolveRunningVesloServerHostInfo(restarted);
    if (!running?.baseUrl?.trim()) {
      deps.setVesloServerStatus("disconnected");
      deps.setVesloServerCapabilitiesStable(null);
      deps.setVesloServerCheckedAt(Date.now());
      throw new Error("Veslo server workspace is not ready for attachments.");
    }

    const result = await deps.checkVesloServer(
      running.baseUrl.trim(),
      running.clientToken?.trim() || undefined,
      running.hostToken?.trim() || undefined,
    );
    deps.setVesloServerStatus(result.status);
    deps.setVesloServerCapabilitiesStable(result.capabilities);
    deps.setVesloServerCheckedAt(Date.now());
    if (result.status !== "connected") {
      throw new Error("Veslo server workspace is not ready for attachments.");
    }

    const client = deps.vesloServerClient() ?? fallbackClient;
    const workspaceId = await resolveWorkspaceIdForAttachmentStaging(client);
    if (!workspaceId) {
      throw new Error("Veslo server workspace is not ready for attachments.");
    }
    return { client, workspaceId };
  };

  const ensureWorkspaceReadyForAttachmentStaging = async (
    client: Client,
  ): Promise<AttachmentStagingWorkspaceReady<Client>> => {
    const workspaceId = await resolveWorkspaceIdForAttachmentStaging(client);
    if (workspaceId) return { client, workspaceId };
    return await recoverWorkspaceReadyForAttachmentStaging(client);
  };

  const shouldRecoverAttachmentStagingWorkspace = (error: unknown) => {
    if (error instanceof VesloServerError) {
      return error.status === 404;
    }
    const message = messageFromUnknownError(error, deps.safeStringify).toLowerCase();
    return message.includes("workspace") && message.includes("not");
  };

  const stageAttachmentsIntoSessionDirectory = async (
    draft: ComposerDraft,
    sessionID: string,
    preflight?: Preflight,
  ): Promise<StagedSessionAttachment[]> => {
    const tracePayload = preflight ? { traceId: preflight.traceId } : undefined;
    const attachmentsToStage = draft.attachments;
    if (!attachmentsToStage.length) {
      deps.recordSendTrace("stageAttachmentsIntoSessionDirectory:skip-empty", {
        ...(tracePayload ?? {}),
        sessionID,
      });
      return [];
    }

    let client = deps.vesloServerClient();
    if (!client || deps.vesloServerStatus() !== "connected") {
      throw new Error("Connect to Veslo server before sending attachments.");
    }
    const scope = deps.selectedSessionBrowseScope(sessionID);
    const workspaceIdForResolution = scope?.workspaceId?.trim() || deps.activeWorkspaceId().trim();
    const directoryForResolution =
      scope?.directory?.trim() ||
      deps.sessionDirectoryForId(sessionID)?.trim() ||
      deps.activeWorkspaceRoot().trim();
    const resolution =
      workspaceIdForResolution && directoryForResolution
        ? await deps.resolveConversationServerWorkspaceForSend(
            workspaceIdForResolution,
            directoryForResolution,
            preflight,
            "stageAttachmentsIntoSessionDirectory",
          )
        : null;
    if (resolution) {
      client = resolution.serverClient;
    }
    let ready: AttachmentStagingWorkspaceReady<Client> = resolution?.serverWorkspaceId
      ? { client, workspaceId: resolution.serverWorkspaceId }
      : await ensureWorkspaceReadyForAttachmentStaging(client);

    const reservedPaths = new Set<string>();
    const stagedAttachments: StagedSessionAttachment[] = [];
    let fileSession: { session: { id: string } };
    try {
      fileSession = await deps.sendTraceStep(
        "stageAttachmentsIntoSessionDirectory:create-file-session",
        () => ready.client.createFileSession(ready.workspaceId, {
          ttlSeconds: 15 * 60,
          write: true,
        }),
        {
          ...(tracePayload ?? {}),
          sessionID,
          workspaceId: ready.workspaceId,
          attachmentCount: attachmentsToStage.length,
        },
      );
    } catch (error) {
      if (!shouldRecoverAttachmentStagingWorkspace(error)) {
        throw error;
      }
      ready = await recoverWorkspaceReadyForAttachmentStaging(ready.client);
      fileSession = await deps.sendTraceStep(
        "stageAttachmentsIntoSessionDirectory:create-file-session",
        () => ready.client.createFileSession(ready.workspaceId, {
          ttlSeconds: 15 * 60,
          write: true,
        }),
        {
          ...(tracePayload ?? {}),
          sessionID,
          workspaceId: ready.workspaceId,
          attachmentCount: attachmentsToStage.length,
        },
      );
    }

    try {
      for (const attachment of attachmentsToStage) {
        const file = await attachmentToFile(attachment);
        const preferredPath = resolveSessionDirectoryRelativePath(sessionID, file.name);
        const relativePath = await resolveCollisionSafeAttachmentPath(
          ready.client,
          fileSession.session.id,
          preferredPath,
          reservedPaths,
        );
        const contentBase64 = arrayBufferToBase64(await file.arrayBuffer());
        const writeResult = await ready.client.writeFileBatch(fileSession.session.id, [
          {
            path: relativePath,
            contentBase64,
          },
        ]);
        const item = writeResult.items[0];
        if (!item?.ok) {
          throw new Error(item?.message ?? `Failed to stage ${attachment.name}.`);
        }
        stagedAttachments.push({
          name: attachment.name,
          kind: attachment.kind,
          mimeType: attachment.mimeType,
          relativePath,
          absolutePath: resolveWorkspaceAbsolutePath(relativePath),
        });
      }
      deps.recordSendTrace("stageAttachmentsIntoSessionDirectory:done", {
        ...(tracePayload ?? {}),
        sessionID,
        workspaceId: ready.workspaceId,
        attachmentCount: stagedAttachments.length,
      });
    } finally {
      await ready.client.closeFileSession(fileSession.session.id).catch(() => undefined);
    }

    return stagedAttachments;
  };

  const buildPromptParts = (draft: ComposerDraft): SessionAttachmentPartInput[] => {
    const parts: SessionAttachmentPartInput[] = [];
    const text = draft.resolvedText ?? draft.text;
    parts.push({ type: "text", text } as TextPartInput);

    const root = deps.workspaceProjectDir().trim();
    const toAbsolutePath = (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("/")) return trimmed;
      if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed;
      if (!root) return "";
      return (root + "/" + trimmed).replace("//", "/");
    };
    const filenameFromPath = (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      const segments = normalized.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? "file";
    };

    for (const part of draft.parts) {
      if (part.type === "agent") {
        parts.push({ type: "agent", name: part.name } as AgentPartInput);
        continue;
      }
      if (part.type === "file") {
        const absolute = toAbsolutePath(part.path);
        if (!absolute) continue;
        parts.push({
          type: "file",
          mime: "text/plain",
          url: `file://${absolute}`,
          filename: filenameFromPath(part.path),
        } as FilePartInput);
      }
    }

    for (const attachment of draft.attachments) {
      parts.push({
        type: "file",
        url: attachment.dataUrl,
        filename: attachment.name,
        mime: attachment.mimeType,
      } as FilePartInput);
    }

    return parts;
  };

  const buildCommandFileParts = (draft: ComposerDraft): FilePartInput[] => {
    const parts: FilePartInput[] = [];
    const root = deps.workspaceProjectDir().trim();

    const toAbsolutePath = (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("/")) return trimmed;
      if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed;
      if (!root) return "";
      return (root + "/" + trimmed).replace("//", "/");
    };

    const filenameFromPath = (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      const segments = normalized.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? "file";
    };

    for (const part of draft.parts) {
      if (part.type !== "file") continue;
      const absolute = toAbsolutePath(part.path);
      if (!absolute) continue;
      parts.push({
        type: "file",
        mime: "text/plain",
        url: `file://${absolute}`,
        filename: filenameFromPath(part.path),
      } as FilePartInput);
    }

    for (const attachment of draft.attachments) {
      parts.push({
        type: "file",
        url: attachment.dataUrl,
        filename: attachment.name,
        mime: attachment.mimeType,
      } as FilePartInput);
    }

    return parts;
  };

  return {
    resolveSessionDirectoryRelativePath,
    resolveWorkspaceAbsolutePath,
    resolveCollisionSafeAttachmentPath,
    resolveWorkspaceIdForAttachmentStaging,
    recoverWorkspaceReadyForAttachmentStaging,
    ensureWorkspaceReadyForAttachmentStaging,
    shouldRecoverAttachmentStagingWorkspace,
    stageAttachmentsIntoSessionDirectory,
    buildPromptParts,
    buildCommandFileParts,
  };
}
