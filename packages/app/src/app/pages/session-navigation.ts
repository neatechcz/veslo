import type { WorkspaceActivationOptions } from "../context/workspace";

export type OpenSessionWithWorkspaceActivationInput = {
  activeWorkspaceId: string;
  getActiveWorkspaceId?: () => string;
  workspaceId: string;
  sessionId: string;
  activateWorkspace: (workspaceId: string, options: WorkspaceActivationOptions) => Promise<boolean> | boolean | void;
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
  if (!sessionId || !workspaceId) return "blocked";

  const token = ++openSessionNavigationToken;

  const run = async () => {
    if (token !== openSessionNavigationToken) return "superseded";

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
    return created !== undefined && created !== null;
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
    return opened !== undefined && opened !== null && opened !== false;
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
