import type { SendTargetWorkspaceScope } from "./workspace-session-selection";

type PendingDraftSendTarget = {
  workspaceId?: string | null;
  privateWorkspaceId?: string | null;
  directory?: string | null;
};

type SelectedSessionBrowseScope = {
  workspaceId?: string | null;
};

type ResolvePendingDraftSendTargetInput = {
  pendingDraft: PendingDraftSendTarget | null | undefined;
  resolveWorkspaceRoot: (workspaceId: string, fallbackDirectory?: string | null) => string;
};

type WorkspaceSendTargetOptions<Client = unknown> = {
  activePendingDraftMeta: () => PendingDraftSendTarget | null | undefined;
  resolveWorkspaceRoot: (workspaceId: string, fallbackDirectory?: string | null) => string;
  resolveSessionSendTargetScope: (sessionId?: string | null) => SendTargetWorkspaceScope | null;
  resolveSelectedSessionBrowseScope?: (sessionId: string) => SelectedSessionBrowseScope | null;
  activeWorkspaceId: () => string;
  activateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  recordSendTrace: (event: string, payload?: Record<string, unknown>) => void;
  sendTraceStep: <T>(
    event: string,
    run: () => Promise<T>,
    payload?: Record<string, unknown>,
  ) => Promise<T>;
  messageFromUnknownError: (error: unknown) => string;
  routedClient?: (workspaceId?: string) => Client | null | undefined;
};

export function resolvePendingDraftSendTargetWorkspaceScope(
  input: ResolvePendingDraftSendTargetInput,
): SendTargetWorkspaceScope | null {
  const pending = input.pendingDraft;
  const workspaceId = (pending?.privateWorkspaceId ?? pending?.workspaceId ?? "").trim();
  if (!workspaceId) return null;

  const root = input.resolveWorkspaceRoot(workspaceId, pending?.directory ?? null).trim();
  const directory = pending?.directory?.trim() || root;
  if (!root || !directory) return null;

  return { workspaceId, workspaceRoot: root, directory };
}

export function resolveRoutedClientForSendTarget<Client>(input: {
  targetWorkspace?: SendTargetWorkspaceScope | null;
  routedClient: (workspaceId?: string) => Client | null | undefined;
}) {
  const workspaceId = input.targetWorkspace?.workspaceId?.trim() ?? "";
  return workspaceId ? input.routedClient(workspaceId) ?? null : input.routedClient() ?? null;
}

export function createWorkspaceSendTarget<Client = unknown>(options: WorkspaceSendTargetOptions<Client>) {
  const resolveSendTargetWorkspaceScope = (sessionId?: string | null): SendTargetWorkspaceScope | null => {
    const normalizedSessionId = sessionId?.trim() ?? "";
    if (!normalizedSessionId) {
      const pendingScope = resolvePendingDraftSendTargetWorkspaceScope({
        pendingDraft: options.activePendingDraftMeta(),
        resolveWorkspaceRoot: options.resolveWorkspaceRoot,
      });
      if (pendingScope) return pendingScope;
    }

    return options.resolveSessionSendTargetScope(normalizedSessionId);
  };

  const routedClientForSendTarget = (targetWorkspace?: SendTargetWorkspaceScope | null) => {
    if (!options.routedClient) return null;
    return resolveRoutedClientForSendTarget({
      targetWorkspace,
      routedClient: options.routedClient,
    });
  };

  const ensureSelectedSessionWorkspaceActiveForSend = async (
    sessionId: string,
    traceId?: string | null,
  ): Promise<boolean> => {
    const tracePayload = traceId ? { traceId } : undefined;
    const transcriptScope = options.resolveSelectedSessionBrowseScope
      ? options.resolveSelectedSessionBrowseScope(sessionId)
      : options.resolveSessionSendTargetScope(sessionId);
    if (!transcriptScope) {
      options.recordSendTrace("sendPrompt:scoped-workspace-skipped-no-scope", tracePayload);
      return true;
    }
    const targetWorkspaceId = transcriptScope.workspaceId?.trim() ?? "";
    if (!targetWorkspaceId) {
      options.recordSendTrace("sendPrompt:scoped-workspace-skipped-empty-target", tracePayload);
      return true;
    }
    if (targetWorkspaceId === options.activeWorkspaceId().trim()) {
      options.recordSendTrace("sendPrompt:scoped-workspace-already-active", {
        ...(tracePayload ?? {}),
        workspaceId: targetWorkspaceId,
      });
      return true;
    }

    options.recordSendTrace("sendPrompt:activate-scoped-workspace", {
      ...(tracePayload ?? {}),
      sessionId,
      workspaceId: targetWorkspaceId,
      activeWorkspaceId: options.activeWorkspaceId().trim(),
    });
    try {
      const activated = await options.sendTraceStep(
        "sendPrompt:activate-scoped-workspace-call",
        async () => options.activateWorkspace(targetWorkspaceId),
        {
          ...(tracePayload ?? {}),
          sessionId,
          workspaceId: targetWorkspaceId,
        },
      );
      if (!activated) {
        options.recordSendTrace("sendPrompt:activate-scoped-workspace-blocked", {
          ...(tracePayload ?? {}),
          sessionId,
          workspaceId: targetWorkspaceId,
        });
      }
      return Boolean(activated);
    } catch (error) {
      options.recordSendTrace("sendPrompt:activate-scoped-workspace-error", {
        ...(tracePayload ?? {}),
        sessionId,
        workspaceId: targetWorkspaceId,
        message: options.messageFromUnknownError(error),
      });
      return false;
    }
  };

  return {
    resolveSendTargetWorkspaceScope,
    routedClientForSendTarget,
    ensureSelectedSessionWorkspaceActiveForSend,
  };
}

export type { SendTargetWorkspaceScope };
