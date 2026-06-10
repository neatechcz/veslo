import { createEffect, createSignal } from "solid-js";

import type { SessionBrowseScope } from "../pages/session-navigation";
import type {
  UiConversationScope,
  UiConversationScopeInput,
} from "../lib/conversation-scope";
import {
  resolveUiConversationScope,
  upsertUiConversationScope,
} from "../lib/conversation-scope";
import type { VesloSessionTranscriptSnapshot } from "../lib/veslo-server";
import type { SidebarSessionItem } from "../types";

export const SESSION_BY_WORKSPACE_KEY = "veslo.workspace-last-session.v1";

type WorkspaceSessionSelectionStorage = Pick<Storage, "getItem" | "setItem">;

type WorkspaceSessionSelectionWorkspace = {
  id: string;
  path?: string | null;
  directory?: string | null;
  workspaceType?: string | null;
};

export type SendTargetWorkspaceScope = {
  workspaceId: string;
  workspaceRoot: string;
  directory: string;
};

export type DisplayedConversationGuard = {
  sessionId: string;
  workspaceId: string;
  conversationId: string;
  opencodeSessionId: string;
};

type SessionConversationSidecar = Pick<SidebarSessionItem, "id" | "directory"> & {
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

type WorkspaceSessionSelectionOptions = {
  activeWorkspaceId: () => string;
  activeWorkspaceRoot?: () => string;
  workspaces: () => WorkspaceSessionSelectionWorkspace[];
  storage?: WorkspaceSessionSelectionStorage | null;
};

const browserStorage = (): WorkspaceSessionSelectionStorage | null => {
  if (typeof window === "undefined") return null;
  return window.localStorage;
};

const normalize = (value: string | null | undefined) => value?.trim() ?? "";

export const readSessionByWorkspaceFromStorage = (
  storage: WorkspaceSessionSelectionStorage | null | undefined,
) => {
  if (!storage) return {} as Record<string, string>;
  try {
    const raw = storage.getItem(SESSION_BY_WORKSPACE_KEY);
    if (!raw) return {} as Record<string, string>;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {} as Record<string, string>;
    return parsed as Record<string, string>;
  } catch {
    return {} as Record<string, string>;
  }
};

export const writeSessionByWorkspaceToStorage = (
  storage: WorkspaceSessionSelectionStorage | null | undefined,
  map: Record<string, string>,
) => {
  if (!storage) return;
  try {
    storage.setItem(SESSION_BY_WORKSPACE_KEY, JSON.stringify(map));
  } catch {
    // ignore persistence failures
  }
};

const makeSendTargetWorkspaceScope = (
  workspaceId: string,
  workspaceRoot: string,
  directory?: string | null,
): SendTargetWorkspaceScope | null => {
  const id = workspaceId.trim();
  const root = workspaceRoot.trim();
  const dir = directory?.trim() || root;
  if (!id || !root || !dir) return null;
  return { workspaceId: id, workspaceRoot: root, directory: dir };
};

export function createWorkspaceSessionSelection(options: WorkspaceSessionSelectionOptions) {
  const storage = () => options.storage ?? browserStorage();
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
  const [selectedSessionBrowseScope, setSelectedSessionBrowseScope] = createSignal<SessionBrowseScope | null>(null);
  const [conversationScopeBySessionId, setConversationScopeBySessionId] = createSignal<
    Record<string, UiConversationScope[]>
  >({});

  const rememberConversationScope = (scope: UiConversationScopeInput) => {
    setConversationScopeBySessionId((current) => upsertUiConversationScope(current, scope));
  };

  const selectedBrowseScopeInput = (): UiConversationScopeInput | null => {
    const scope = selectedSessionBrowseScope();
    if (!scope) return null;
    return {
      sessionId: scope.sessionId,
      workspaceId: scope.workspaceId,
      workspaceRoot: scope.workspaceRoot,
      directory: scope.directory ?? scope.workspaceRoot,
      conversationId: scope.conversationId,
      opencodeSessionId: scope.opencodeSessionId,
    };
  };

  const resolveSelectedSessionBrowseScope = (sessionId: string): SessionBrowseScope | null => {
    const id = sessionId.trim();
    if (!id) return null;
    return resolveUiConversationScope(conversationScopeBySessionId(), id, {
      activeWorkspaceId: options.activeWorkspaceId(),
      selectedScope: selectedBrowseScopeInput(),
    });
  };

  const captureDisplayedConversationGuard = (sessionId: string): DisplayedConversationGuard => {
    const id = sessionId.trim();
    const scope = id ? resolveSelectedSessionBrowseScope(id) : null;
    return {
      sessionId: id,
      workspaceId: scope?.workspaceId?.trim() || options.activeWorkspaceId().trim() || "",
      conversationId: scope?.conversationId?.trim() || "",
      opencodeSessionId: scope?.opencodeSessionId?.trim() || id,
    };
  };

  const displayedConversationStillMatches = (guard: DisplayedConversationGuard): boolean => {
    const currentSessionId = selectedSessionId()?.trim() || "";
    if (!guard.sessionId || !currentSessionId) return false;
    const currentScope = resolveSelectedSessionBrowseScope(currentSessionId);
    const currentWorkspaceId = currentScope?.workspaceId?.trim() || options.activeWorkspaceId().trim() || "";
    if (guard.workspaceId && currentWorkspaceId && guard.workspaceId !== currentWorkspaceId) return false;
    if (guard.conversationId) {
      return currentSessionId === guard.conversationId || currentScope?.conversationId?.trim() === guard.conversationId;
    }
    const currentOpenCodeSessionId = currentScope?.opencodeSessionId?.trim() || currentSessionId;
    return currentSessionId === guard.sessionId || currentOpenCodeSessionId === guard.opencodeSessionId;
  };

  const latestConversationRunIdByScope = new Map<string, string>();
  const conversationRunScopeKey = (workspaceId: string, conversationId: string) => {
    const workspaceKey = workspaceId.trim();
    const conversationKey = conversationId.trim();
    return workspaceKey && conversationKey ? `${workspaceKey}\0${conversationKey}` : "";
  };

  const rememberLatestConversationRunId = (input: {
    workspaceId: string;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
    uiSessionId?: string | null;
    runId?: string | null;
  }) => {
    const runId = input.runId?.trim();
    if (!runId) return;
    for (const id of [input.conversationId, input.opencodeSessionId, input.uiSessionId]) {
      const key = id ? conversationRunScopeKey(input.workspaceId, id) : "";
      if (key) latestConversationRunIdByScope.set(key, runId);
    }
  };

  const resolveLatestConversationRunId = (input: {
    workspaceId: string;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
    uiSessionId?: string | null;
  }) => {
    for (const id of [input.conversationId, input.opencodeSessionId, input.uiSessionId]) {
      const key = id ? conversationRunScopeKey(input.workspaceId, id) : "";
      const runId = key ? latestConversationRunIdByScope.get(key) : undefined;
      if (runId) return runId;
    }
    return "";
  };

  const setSessionBrowseScope = (scope: SessionBrowseScope) => {
    const sessionId = scope.sessionId.trim();
    const workspaceId = scope.workspaceId.trim();
    if (!sessionId || !workspaceId) return;
    const next = {
      sessionId,
      workspaceId,
      workspaceRoot: scope.workspaceRoot.trim(),
      directory: scope.directory?.trim() || scope.workspaceRoot.trim(),
      conversationId: scope.conversationId?.trim() || undefined,
      opencodeSessionId: scope.opencodeSessionId?.trim() || undefined,
    };
    setSelectedSessionBrowseScope(next);
    rememberConversationScope(next);
  };

  const resolveWorkspaceRootForConversationScope = (workspaceId: string, directory?: string | null) => {
    const scopedDirectory = directory?.trim() ?? "";
    const workspace = options.workspaces().find((item) => item.id === workspaceId);
    return workspace?.directory?.trim() || workspace?.path?.trim() || scopedDirectory;
  };

  const rememberConversationScopesFromSessions = (
    workspaceId: string,
    directory: string | undefined,
    sessions: SessionConversationSidecar[],
  ) => {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId) return;
    for (const session of sessions) {
      const sessionId = session.id?.trim() ?? "";
      if (!sessionId) continue;
      const scopedDirectory = session.directory?.trim() || directory?.trim() || "";
      rememberConversationScope({
        sessionId,
        workspaceId: normalizedWorkspaceId,
        workspaceRoot: resolveWorkspaceRootForConversationScope(normalizedWorkspaceId, scopedDirectory),
        directory: scopedDirectory,
        conversationId: session.conversationId,
        opencodeSessionId: session.opencodeSessionId ?? sessionId,
      });
    }
  };

  const rememberConversationScopeFromTranscript = (
    workspaceId: string,
    directory: string | undefined,
    snapshot: Pick<VesloSessionTranscriptSnapshot, "sessionId" | "directory" | "conversationId" | "opencodeSessionId"> | null,
  ) => {
    if (!snapshot) return;
    const scopedDirectory = directory ?? snapshot.directory;
    const sessionId = snapshot.sessionId?.trim() ?? "";
    const opencodeSessionId = snapshot.opencodeSessionId?.trim() || sessionId;
    const conversationId = snapshot.conversationId?.trim() || undefined;
    const uiSessionId = opencodeSessionId || conversationId || sessionId;
    if (!uiSessionId) return;
    rememberConversationScope({
      sessionId: uiSessionId,
      workspaceId,
      workspaceRoot: resolveWorkspaceRootForConversationScope(workspaceId, scopedDirectory),
      directory: scopedDirectory,
      conversationId,
      opencodeSessionId,
    });
  };

  const readSessionByWorkspace = () => readSessionByWorkspaceFromStorage(storage());
  const writeSessionByWorkspace = (map: Record<string, string>) =>
    writeSessionByWorkspaceToStorage(storage(), map);

  createEffect(() => {
    const sessionId = selectedSessionId();
    const workspaceId =
      (sessionId ? resolveSelectedSessionBrowseScope(sessionId)?.workspaceId : null) ??
      options.activeWorkspaceId();
    if (!workspaceId || !sessionId) return;
    const map = readSessionByWorkspace();
    if (map[workspaceId] === sessionId) return;
    map[workspaceId] = sessionId;
    writeSessionByWorkspace(map);
  });

  const activeWorkspaceLastSessionId = () => {
    const workspaceId = options.activeWorkspaceId().trim();
    const selected = selectedSessionId()?.trim() ?? "";
    if (!workspaceId) return selected || null;
    const selectedScope = selected ? resolveSelectedSessionBrowseScope(selected) : null;
    if (selected && (!selectedScope || selectedScope.workspaceId === workspaceId)) return selected;
    const stored = readSessionByWorkspace()[workspaceId]?.trim() ?? "";
    return stored || null;
  };

  const scopedSessionIds = () => [
    ...new Set(
      Object.values(conversationScopeBySessionId()).flatMap((scopes) =>
        scopes.flatMap((scope) => [
        scope.sessionId,
        scope.conversationId ?? "",
        scope.opencodeSessionId ?? "",
        ]),
      ).filter(Boolean),
    ),
  ];

  const workspaceRootForId = (workspaceId: string, fallbackDirectory?: string | null) => {
    const id = workspaceId.trim();
    const workspace = options.workspaces().find((item) => item.id === id) ?? null;
    return workspace?.directory?.trim() || workspace?.path?.trim() || fallbackDirectory?.trim() || "";
  };

  const resolveSendTargetWorkspaceScope = (sessionId?: string | null): SendTargetWorkspaceScope | null => {
    const normalizedSessionId = normalize(sessionId);
    if (normalizedSessionId) {
      const scope = resolveSelectedSessionBrowseScope(normalizedSessionId);
      if (scope?.workspaceId?.trim()) {
        return makeSendTargetWorkspaceScope(
          scope.workspaceId,
          scope.workspaceRoot || workspaceRootForId(scope.workspaceId, scope.directory),
          scope.directory,
        );
      }
    }

    const activeRoot = options.activeWorkspaceRoot?.().trim() ?? "";
    return makeSendTargetWorkspaceScope(options.activeWorkspaceId().trim(), activeRoot, activeRoot);
  };

  return {
    selectedSessionId,
    setSelectedSessionId,
    rememberConversationScope,
    resolveSelectedSessionBrowseScope,
    captureDisplayedConversationGuard,
    displayedConversationStillMatches,
    rememberLatestConversationRunId,
    resolveLatestConversationRunId,
    setSessionBrowseScope,
    resolveWorkspaceRootForConversationScope,
    rememberConversationScopesFromSessions,
    rememberConversationScopeFromTranscript,
    readSessionByWorkspace,
    writeSessionByWorkspace,
    activeWorkspaceLastSessionId,
    scopedSessionIds,
    resolveSendTargetWorkspaceScope,
  };
}
