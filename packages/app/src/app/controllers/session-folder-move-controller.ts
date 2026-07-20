import type { Session } from "@opencode-ai/sdk/v2/client";

import type { WorkspaceDisplay } from "../types";
import { normalizeDirectoryPath, preferredSessionWorkspaceRoot } from "../utils";
import {
  opencodeDbUpdateSessionDirectory,
  workspaceCopyIntoFolder,
  workspaceVesloRead,
  workspaceVesloWrite,
} from "../lib/tauri";

/**
 * Moves a session out of a private (scratch) workspace into a user-picked
 * folder: copies the files, retargets the OpenCode session directory, swaps
 * the active workspace, and deletes the private workspace afterwards. Owned
 * by a controller because the flow is navigation-aware, mutates state across
 * several stores, and ends with a destructive cleanup.
 */

export type SessionFolderMoveSourceInput = {
  sessionDirectory: string;
  activeWorkspaceId: string;
  activeWorkspaceRoot: string;
  activeWorkspace: Pick<WorkspaceDisplay, "id" | "workspaceType">;
  workspaces: Pick<WorkspaceDisplay, "id" | "workspaceType" | "path">[];
  isPrivateWorkspacePath: (path: string) => boolean;
};

export type SessionFolderMoveSource =
  | { ok: true; sourceRoot: string; sourceWorkspaceId: string }
  | { ok: false; reason: "not-private" | "missing-root" };

/**
 * Resolves which workspace a session is moved out of. The session's own
 * directory wins over the active workspace so a session opened from another
 * workspace's sidebar is moved from its real home, not the active one.
 */
export function resolveSessionFolderMoveSource(
  input: SessionFolderMoveSourceInput,
): SessionFolderMoveSource {
  const activeRoot = input.activeWorkspaceRoot.trim();
  const sourceRoot = preferredSessionWorkspaceRoot(input.sessionDirectory, activeRoot);
  const normalizedSourceRoot = normalizeDirectoryPath(sourceRoot);
  const sourceWorkspaceMatch = normalizedSourceRoot
    ? input.workspaces.find(
        (workspace) =>
          workspace.workspaceType === "local" &&
          normalizeDirectoryPath(workspace.path?.trim() ?? "") === normalizedSourceRoot,
      ) ?? null
    : null;
  const sourceWorkspace = sourceWorkspaceMatch ?? input.activeWorkspace;
  const sourceWorkspaceId = sourceWorkspace.id?.trim() || input.activeWorkspaceId.trim();

  if (sourceWorkspace.workspaceType !== "local" || !input.isPrivateWorkspacePath(sourceRoot)) {
    return { ok: false, reason: "not-private" };
  }
  if (!sourceRoot) {
    return { ok: false, reason: "missing-root" };
  }
  return { ok: true, sourceRoot, sourceWorkspaceId };
}

type SidebarSessionSnapshot = {
  id: string;
  title: string;
  slug?: string;
  parentID?: string | null;
  time?: Session["time"];
  directory: string;
};

export type SessionFolderMoveControllerDeps = {
  isTauriRuntime: () => boolean;
  selectedSessionId: () => string | null;
  sessions: () => Session[];
  setSessions: (sessions: Session[]) => void;
  resolveSessionDirectory: (session: Pick<Session, "id" | "directory">) => string;
  persistSessionDirectoryOverride: (sessionID: string, directory?: string | null) => void;
  workspace: {
    activeWorkspaceId: () => string;
    activeWorkspaceRoot: () => string;
    activeWorkspaceDisplay: () => WorkspaceDisplay;
    workspaces: () => WorkspaceDisplay[];
    isPrivateWorkspacePath: (path: string) => boolean;
    pickWorkspaceFolder: () => Promise<string | null | undefined>;
    ensureWorkspaceForFolder: (folder: string) => Promise<{ id: string; path: string } | null | undefined>;
    ensureLocalWorkspaceActive: (workspaceId: string) => Promise<boolean>;
    forgetWorkspace: (workspaceId: string, options: { deleteLocalData: boolean }) => Promise<unknown>;
  };
  moveWorkspaceLastSession: (input: {
    sourceWorkspaceId: string;
    targetWorkspaceId: string;
    sessionId: string;
  }) => void;
  moveSessionBetweenWorkspaceSidebars: (input: {
    sourceWorkspaceId: string;
    targetWorkspaceId: string;
    item: SidebarSessionSnapshot;
  }) => void;
  ensureSessionInWorkspaceSidebar: (workspaceId: string, item: SidebarSessionSnapshot) => void;
  refreshSidebarWorkspaceSessions: (workspaceId: string) => Promise<unknown>;
  goToSession: (sessionId: string, options?: { replace?: boolean }) => void;
  selectSession: (sessionId: string) => Promise<unknown>;
  reportError: (error: unknown, scope: string) => void;
};

export function createSessionFolderMoveController(deps: SessionFolderMoveControllerDeps) {
  const chooseFolderForCurrentSession = async () => {
    if (!deps.isTauriRuntime()) return false;

    const sessionID = (deps.selectedSessionId() ?? "").trim();
    if (!sessionID) {
      throw new Error("No session selected");
    }

    const sessionRecord = deps.sessions().find((session) => session.id === sessionID) ?? null;
    const source = resolveSessionFolderMoveSource({
      sessionDirectory: sessionRecord ? deps.resolveSessionDirectory(sessionRecord) : "",
      activeWorkspaceId: deps.workspace.activeWorkspaceId(),
      activeWorkspaceRoot: deps.workspace.activeWorkspaceRoot(),
      activeWorkspace: deps.workspace.activeWorkspaceDisplay(),
      workspaces: deps.workspace.workspaces(),
      isPrivateWorkspacePath: deps.workspace.isPrivateWorkspacePath,
    });
    if (!source.ok) {
      throw new Error(
        source.reason === "not-private"
          ? "Choose folder is only available for private workspaces."
          : "Private workspace folder is unavailable.",
      );
    }
    const { sourceRoot, sourceWorkspaceId } = source;

    for (;;) {
      const selectedDirectory = await deps.workspace.pickWorkspaceFolder();
      if (!selectedDirectory) return false;

      let transfer = await workspaceCopyIntoFolder({
        sourcePath: sourceRoot,
        targetPath: selectedDirectory,
        overwrite: false,
      });

      if (transfer.kind === "conflict") {
        const preview = transfer.conflicts.slice(0, 6);
        const suffix =
          transfer.conflicts.length > preview.length
            ? `\n…and ${transfer.conflicts.length - preview.length} more.`
            : "";
        const overwrite = window.confirm(
          `This folder already has conflicting files:\n\n${preview.join("\n")}${suffix}\n\nReplace conflicting files?`,
        );
        if (!overwrite) {
          const chooseAnother = window.confirm(
            "Choose another folder? Click Cancel to keep using the private workspace.",
          );
          if (chooseAnother) continue;
          return false;
        }

        transfer = await workspaceCopyIntoFolder({
          sourcePath: sourceRoot,
          targetPath: selectedDirectory,
          overwrite: true,
        });
      }

      if (transfer.kind !== "ok") {
        return false;
      }

      // Fix stale authorizedRoots copied from the private workspace.
      // The copied veslo.json still points to the old private-workspaces path;
      // replace it with the actual target directory before the engine starts.
      try {
        const copiedConfig = await workspaceVesloRead({ workspacePath: selectedDirectory });
        const oldRoots = Array.isArray(copiedConfig.authorizedRoots) ? copiedConfig.authorizedRoots : [];
        const fixedRoots = oldRoots
          .map((r) => (r === sourceRoot ? selectedDirectory : r))
          .filter((r, i, arr) => arr.indexOf(r) === i);
        if (!fixedRoots.includes(selectedDirectory)) fixedRoots.push(selectedDirectory);
        await workspaceVesloWrite({
          workspacePath: selectedDirectory,
          config: { ...copiedConfig, authorizedRoots: fixedRoots },
        });
      } catch {
        // veslo.json may not exist yet — ensureWorkspaceForFolder will create it
      }

      // Snapshot the session BEFORE activating the target workspace.
      // ensureLocalWorkspaceActive → connectToServer → loadSessions scopes
      // to the target directory and won't include this session (it was
      // created in the temp workspace). Without the snapshot, the session
      // data would be lost after activation.
      const sessionSnapshot = deps.sessions().find((s) => s.id === sessionID) ?? null;

      // Update session directory in the OpenCode SQLite database BEFORE
      // activating the new workspace.  ensureLocalWorkspaceActive restarts the
      // engine, so the restarted engine will read the corrected directory from
      // the DB and won't generate stale external_directory permission prompts.
      if (deps.isTauriRuntime()) {
        try {
          const dbUpdate = await opencodeDbUpdateSessionDirectory({
            sessionId: sessionID,
            oldDirectory: sourceRoot,
            directory: selectedDirectory,
          });
          if (!dbUpdate.ok) {
            throw new Error(dbUpdate.stderr || "Failed to update OpenCode session directory.");
          }
        } catch (error) {
          deps.reportError(error, "workspace.move.updateSessionDirectory");
          // Non-fatal: the session will still work, just with a permission prompt.
        }
      }

      const targetWorkspace = await deps.workspace.ensureWorkspaceForFolder(selectedDirectory);
      if (!targetWorkspace?.id) return false;
      const ready = await deps.workspace.ensureLocalWorkspaceActive(targetWorkspace.id);
      if (!ready) return false;

      deps.persistSessionDirectoryOverride(sessionID, targetWorkspace.path);

      // Ensure the session is in sessions() with the correct directory so
      // the route effect (which validates session existence) doesn't
      // redirect away when goToSession changes the URL.
      const currentSessions = deps.sessions();
      const existingIdx = currentSessions.findIndex((s) => s.id === sessionID);
      if (existingIdx >= 0) {
        const copy = [...currentSessions];
        copy[existingIdx] = { ...copy[existingIdx], directory: targetWorkspace.path };
        deps.setSessions(copy);
      } else if (sessionSnapshot) {
        deps.setSessions([{ ...sessionSnapshot, directory: targetWorkspace.path }, ...currentSessions]);
      }

      deps.moveWorkspaceLastSession({
        sourceWorkspaceId,
        targetWorkspaceId: targetWorkspace.id,
        sessionId: sessionID,
      });

      // Optimistically move the session in the sidebar so the user sees
      // immediate feedback. Uses the snapshot captured before activation.
      deps.moveSessionBetweenWorkspaceSidebars({
        sourceWorkspaceId,
        targetWorkspaceId: targetWorkspace.id,
        item: {
          id: sessionID,
          title: sessionSnapshot?.title ?? "",
          slug: sessionSnapshot?.slug,
          parentID: sessionSnapshot?.parentID ?? null,
          time: sessionSnapshot?.time,
          directory: targetWorkspace.path,
        },
      });

      // Navigate and load messages before forgetWorkspace (which may
      // trigger disruptive reactive effects).
      // Yield a microtask so the reactive session/client state from
      // ensureLocalWorkspaceActive has settled before selecting.
      await Promise.resolve();
      deps.goToSession(sessionID, { replace: true });
      // Yield again so the route effect (triggered by goToSession) runs
      // first — then our explicit selectSession call won't be deduped
      // against a stale in-flight load.
      await new Promise((r) => setTimeout(r, 100));
      await deps.selectSession(sessionID);

      // Refresh sidebar from API, then clean up the old private workspace.
      await deps.refreshSidebarWorkspaceSessions(targetWorkspace.id).catch((e) =>
        deps.reportError(e, "sidebar.refreshSessions"),
      );

      if (sourceWorkspaceId && sourceWorkspaceId !== targetWorkspace.id) {
        await deps.workspace.forgetWorkspace(sourceWorkspaceId, { deleteLocalData: true });
      }

      // forgetWorkspace → setWorkspaces() triggers a reactive sidebar
      // refresh (fire-and-forget). That refresh uses the directory override
      // to find the session, so it should include it. As a safety net,
      // re-ensure the session appears in case the async refresh hasn't
      // completed or failed to find it.
      deps.ensureSessionInWorkspaceSidebar(targetWorkspace.id, {
        id: sessionID,
        title: sessionSnapshot?.title ?? "",
        slug: sessionSnapshot?.slug,
        parentID: sessionSnapshot?.parentID ?? null,
        time: sessionSnapshot?.time,
        directory: targetWorkspace.path,
      });

      return true;
    }
  };

  return { chooseFolderForCurrentSession };
}
