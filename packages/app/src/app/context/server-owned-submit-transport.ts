import type { SendRuntimePreflightTargetWorkspace } from "./send-runtime-readiness";

type LocalWorkspaceCandidate = {
  id?: string | null;
  workspaceType?: string | null;
  path?: string | null;
  directory?: string | null;
};

export type ServerOwnedSubmitTransportTarget =
  | { kind: "skip"; reason: "non-tauri" | "non-local-workspace" }
  | {
      kind: "local";
      workspaceId: string;
      workspacePath: string;
    }
  | {
      kind: "unavailable";
      reason: "missing-target" | "workspace-not-found" | "missing-workspace-root";
    };

/**
 * The daemon-only admission port belongs exclusively to a local desktop
 * workspace. Remote and browser submits already have their own server route
 * and must never attempt a Tauri filesystem/runtime operation.
 */
export function resolveServerOwnedSubmitTransportTarget(input: {
  isTauriRuntime: boolean;
  targetWorkspace?: SendRuntimePreflightTargetWorkspace | null;
  workspaces: readonly LocalWorkspaceCandidate[];
}): ServerOwnedSubmitTransportTarget {
  if (!input.isTauriRuntime) return { kind: "skip", reason: "non-tauri" };

  const workspaceId = input.targetWorkspace?.workspaceId?.trim() ?? "";
  if (!workspaceId) return { kind: "unavailable", reason: "missing-target" };

  const workspace =
    input.workspaces.find((candidate) => candidate.id?.trim() === workspaceId) ??
    null;
  if (!workspace) return { kind: "unavailable", reason: "workspace-not-found" };
  if (workspace.workspaceType !== "local") {
    return { kind: "skip", reason: "non-local-workspace" };
  }

  const workspacePath = workspace.path?.trim() || workspace.directory?.trim() || "";
  if (!workspacePath) {
    return { kind: "unavailable", reason: "missing-workspace-root" };
  }
  return { kind: "local", workspaceId, workspacePath };
}
