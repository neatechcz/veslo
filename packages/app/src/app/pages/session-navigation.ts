import type { WorkspaceActivationOptions } from "../context/workspace-types";
import { isPendingSessionInstanceKey } from "../components/session/pending-session-instance-model";
import {
  sidebarSessionMatchesOpenTarget,
  type SidebarSessionOpenTarget,
} from "../components/session/workspace-session-list-model";
import type { WorkspaceSessionGroup } from "../types";

export type OpenSessionWithWorkspaceActivationInput = {
  activeWorkspaceId: string;
  getActiveWorkspaceId?: () => string;
  workspaceId: string;
  sessionId: string;
  activateWorkspace: (workspaceId: string, options: WorkspaceActivationOptions) => Promise<boolean> | boolean | void;
  activateWorkspaceBeforeOpen?: boolean;
  openSession: (sessionId: string) => void;
};

export type OpenSessionWithWorkspaceActivationResult = "opened" | "blocked" | "superseded";

export type SessionBrowseScope = {
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  directory?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

export type OpenSidebarSessionFromListInput = {
  workspaceSessionGroups: WorkspaceSessionGroup[];
  activeWorkspaceId: string;
  getActiveWorkspaceId?: () => string;
  workspaceId: string;
  sessionId: string;
  target?: SidebarSessionOpenTarget | null;
  activateWorkspace: (workspaceId: string, options: WorkspaceActivationOptions) => Promise<boolean> | boolean | void;
  setSessionBrowseScope: (scope: SessionBrowseScope) => void;
  selectSession: (sessionId: string) => Promise<void> | void;
  setView: (view: "session", sessionId: string) => void;
  reportError: (error: unknown, context: string) => void;
  sourceContext: string;
};

export type CreateSessionWithWorkspaceActivationInput = {
  activeWorkspaceId: string;
  getActiveWorkspaceId?: () => string;
  workspaceId: string;
  activateWorkspace: (workspaceId: string, options: WorkspaceActivationOptions) => Promise<boolean> | boolean | void;
  createSession: () => Promise<string | undefined> | string | undefined | void;
};

export type OpenPendingDraftWithWorkspaceActivationInput = {
  activeWorkspaceId: string;
  getActiveWorkspaceId?: () => string;
  workspaceId: string;
  activateWorkspace: (workspaceId: string, options: WorkspaceActivationOptions) => Promise<boolean> | boolean | void;
  openPendingDraft: () => Promise<string | boolean | undefined> | string | boolean | undefined | void;
};

export type CreateSessionFromDirectorySelectionInput = {
  activeWorkspaceId: string;
  getActiveWorkspaceId?: () => string;
  pickDirectory: () => Promise<string | null> | string | null;
  ensureWorkspaceForFolder: (
    folder: string,
  ) => Promise<{ id: string } | null> | { id: string } | null;
  activateWorkspace: (workspaceId: string, options: WorkspaceActivationOptions) => Promise<boolean> | boolean | void;
  createSession: () => Promise<string | undefined> | string | undefined | void;
};

export type OpenPendingDraftFromDirectorySelectionInput = {
  activeWorkspaceId: string;
  getActiveWorkspaceId?: () => string;
  pickDirectory: () => Promise<string | null> | string | null;
  ensureWorkspaceForFolder: (
    folder: string,
  ) => Promise<{ id: string } | null> | { id: string } | null;
  activateWorkspace: (workspaceId: string, options: WorkspaceActivationOptions) => Promise<boolean> | boolean | void;
  openPendingDraft: (
    target: { workspaceId: string; directory: string },
  ) => Promise<string | boolean | undefined> | string | boolean | undefined | void;
  onWorkspaceRegistered?: (
    target: { workspaceId: string; directory: string },
  ) => Promise<void> | void;
};

export type CreateSessionFromDirectorySelectionResult = "cancelled" | "blocked" | "created";
export type OpenPendingDraftFromDirectorySelectionResult = "cancelled" | "blocked" | "opened";

// Keep cross-worker session navigation single-flight to avoid overlapping
// activateWorkspace calls when users click between workers rapidly.
let openSessionNavigationQueue: Promise<void> = Promise.resolve();
let openSessionNavigationToken = 0;
let createSessionNavigationQueue: Promise<void> = Promise.resolve();
let createSessionNavigationToken = 0;
let openPendingDraftNavigationQueue: Promise<void> = Promise.resolve();
let openPendingDraftNavigationToken = 0;

export async function openSessionWithWorkspaceActivation(
  input: OpenSessionWithWorkspaceActivationInput,
): Promise<OpenSessionWithWorkspaceActivationResult> {
  const sessionId = input.sessionId.trim();
  const workspaceId = input.workspaceId.trim();
  const activeWorkspaceId = input.activeWorkspaceId.trim();
  const getActiveWorkspaceId = () => input.getActiveWorkspaceId?.().trim() || activeWorkspaceId;
  if (!sessionId || !workspaceId) return "blocked";

  const token = ++openSessionNavigationToken;

  const run = async () => {
    if (token !== openSessionNavigationToken) return "superseded";

    if (input.activateWorkspaceBeforeOpen && workspaceId !== getActiveWorkspaceId()) {
      const activated = await Promise.resolve(input.activateWorkspace(workspaceId, {
        origin: "session-navigation:open-session-before-open",
      }));
      if (!activated) return "blocked";
    }

    if (token !== openSessionNavigationToken) return "superseded";
    input.openSession(sessionId);
    return "opened";
  };

  const task = openSessionNavigationQueue.then(run, run);
  openSessionNavigationQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return await task;
}

export function openSidebarSessionFromList(
  input: OpenSidebarSessionFromListInput,
): Promise<OpenSessionWithWorkspaceActivationResult | void> {
  const group = input.workspaceSessionGroups.find((g) => g.workspace.id === input.workspaceId);
  const session =
    (input.target ? group?.sessions.find((item) => sidebarSessionMatchesOpenTarget(item, input.target)) : null) ??
    group?.sessions.find((item) => item.id === input.sessionId);
  const workspaceRoot =
    group?.workspace.directory?.trim() ||
    group?.workspace.path?.trim() ||
    "";

  const scopedWorkspaceRoot = () => input.target?.workspaceRoot?.trim() || workspaceRoot;

  const openRealSession = (nextSessionId: string) => {
    const root = scopedWorkspaceRoot();
    input.setSessionBrowseScope({
      sessionId: nextSessionId,
      workspaceId: input.workspaceId,
      workspaceRoot: root,
      directory: input.target?.directory?.trim() || session?.directory?.trim() || root,
      conversationId: input.target?.conversationId ?? session?.conversationId ?? null,
      opencodeSessionId: input.target?.opencodeSessionId ?? session?.opencodeSessionId ?? nextSessionId,
    });
    // Route effects can dedupe same-id opens; select after scope so DB reads use the clicked workspace.
    void Promise.resolve(input.selectSession(nextSessionId))
      .catch((error) => input.reportError(error, `${input.sourceContext}.openSessionFromList.selectSession`));
    input.setView("session", nextSessionId);
  };

  const openPendingSession = (nextSessionId: string) => {
    const root = scopedWorkspaceRoot();
    input.setSessionBrowseScope({
      sessionId: nextSessionId,
      workspaceId: input.workspaceId,
      workspaceRoot: root,
      directory: input.target?.directory?.trim() || session?.directory?.trim() || root,
      conversationId: null,
      opencodeSessionId: null,
    });
    input.setView("session", nextSessionId);
  };

  if (isPendingSessionInstanceKey(input.sessionId)) {
    // Pending rows are client aliases; selecting them as real sessions hits server reads.
    return openSessionWithWorkspaceActivation({
      activeWorkspaceId: input.activeWorkspaceId,
      getActiveWorkspaceId: input.getActiveWorkspaceId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      activateWorkspace: input.activateWorkspace,
      activateWorkspaceBeforeOpen: true,
      openSession: openPendingSession,
    }).catch((error) => input.reportError(error, `${input.sourceContext}.openPendingSessionFromList`));
  }

  return openSessionWithWorkspaceActivation({
    activeWorkspaceId: input.activeWorkspaceId,
    getActiveWorkspaceId: input.getActiveWorkspaceId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    activateWorkspace: input.activateWorkspace,
    openSession: openRealSession,
  }).catch((error) => input.reportError(error, `${input.sourceContext}.openSessionFromList`));
}

export async function createSessionWithWorkspaceActivation(
  input: CreateSessionWithWorkspaceActivationInput,
): Promise<boolean> {
  const workspaceId = input.workspaceId.trim();
  const activeWorkspaceId = input.activeWorkspaceId.trim();
  const getActiveWorkspaceId = () => input.getActiveWorkspaceId?.().trim() || activeWorkspaceId;
  if (!workspaceId) return false;

  const token = ++createSessionNavigationToken;

  const run = async () => {
    if (token !== createSessionNavigationToken) return false;

    if (workspaceId !== getActiveWorkspaceId()) {
      const activated = await Promise.resolve(input.activateWorkspace(workspaceId, { origin: "session-navigation:create-session" }));
      if (!activated) return false;
    }

    if (token !== createSessionNavigationToken) return false;
    const created = await Promise.resolve(input.createSession());
    if (typeof created === "string") return created.trim().length > 0;
    return false;
  };

  const task = createSessionNavigationQueue.then(run, run);
  createSessionNavigationQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return await task;
}

export async function openPendingDraftWithWorkspaceActivation(
  input: OpenPendingDraftWithWorkspaceActivationInput,
): Promise<boolean> {
  const workspaceId = input.workspaceId.trim();
  const activeWorkspaceId = input.activeWorkspaceId.trim();
  const getActiveWorkspaceId = () => input.getActiveWorkspaceId?.().trim() || activeWorkspaceId;
  if (!workspaceId) return false;

  const token = ++openPendingDraftNavigationToken;

  const run = async () => {
    if (token !== openPendingDraftNavigationToken) return false;

    if (workspaceId !== getActiveWorkspaceId()) {
      const activated = await Promise.resolve(input.activateWorkspace(workspaceId, { origin: "session-navigation:open-pending-draft" }));
      if (!activated) return false;
    }

    if (token !== openPendingDraftNavigationToken) return false;
    const opened = await Promise.resolve(input.openPendingDraft());
    if (typeof opened === "string") return opened.trim().length > 0;
    return opened !== undefined && opened !== false;
  };

  const task = openPendingDraftNavigationQueue.then(run, run);
  openPendingDraftNavigationQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return await task;
}

export async function createSessionFromDirectorySelection(
  input: CreateSessionFromDirectorySelectionInput,
): Promise<CreateSessionFromDirectorySelectionResult> {
  const selectedDirectory = await Promise.resolve(input.pickDirectory());
  if (selectedDirectory == null || selectedDirectory.trim() === "") return "cancelled";

  // Snapshot the active workspace before ensureWorkspaceForFolder() runs.
  // Creating a new local workspace can register that workspace as "active"
  // before its runtime activation has actually happened.
  const activeWorkspaceIdBeforeEnsure =
    input.getActiveWorkspaceId?.().trim() || input.activeWorkspaceId.trim();

  const workspace = await Promise.resolve(input.ensureWorkspaceForFolder(selectedDirectory));
  const workspaceId = workspace?.id?.trim() ?? "";
  if (!workspaceId) return "blocked";

  const created = await createSessionWithWorkspaceActivation({
    activeWorkspaceId: activeWorkspaceIdBeforeEnsure,
    workspaceId,
    activateWorkspace: input.activateWorkspace,
    createSession: input.createSession,
  });

  return created ? "created" : "blocked";
}

export async function openPendingDraftFromDirectorySelection(
  input: OpenPendingDraftFromDirectorySelectionInput,
): Promise<OpenPendingDraftFromDirectorySelectionResult> {
  const selectedDirectory = await Promise.resolve(input.pickDirectory());
  if (selectedDirectory == null || selectedDirectory.trim() === "") return "cancelled";

  const activeWorkspaceIdBeforeEnsure =
    input.getActiveWorkspaceId?.().trim() || input.activeWorkspaceId.trim();

  const workspace = await Promise.resolve(input.ensureWorkspaceForFolder(selectedDirectory));
  const workspaceId = workspace?.id?.trim() ?? "";
  if (!workspaceId) return "blocked";
  await Promise.resolve(input.onWorkspaceRegistered?.({ workspaceId, directory: selectedDirectory }));

  const opened = await openPendingDraftWithWorkspaceActivation({
    activeWorkspaceId: activeWorkspaceIdBeforeEnsure,
    workspaceId,
    activateWorkspace: input.activateWorkspace,
    openPendingDraft: () => input.openPendingDraft({ workspaceId, directory: selectedDirectory }),
  });

  return opened ? "opened" : "blocked";
}
