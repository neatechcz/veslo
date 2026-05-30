import type { WorkspaceInfo } from "./tauri";

type BuildSkillInstallTargetWorkspacesInput = {
  workspaces: readonly WorkspaceInfo[];
  activeWorkspaceId: string;
  activeWorkspaceName: string;
  activeWorkspaceRoot: string;
  activeWorkspaceType: WorkspaceInfo["workspaceType"];
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean;
};

const workspaceRootForInstallTarget = (
  workspace: WorkspaceInfo,
  input: Pick<BuildSkillInstallTargetWorkspacesInput, "activeWorkspaceId" | "activeWorkspaceRoot">,
) => (
  workspace.path.trim() ||
  workspace.directory?.trim() ||
  (workspace.id === input.activeWorkspaceId ? input.activeWorkspaceRoot.trim() : "")
);

const isPrivateSkillInstallTarget = (
  workspace: WorkspaceInfo,
  input: Pick<BuildSkillInstallTargetWorkspacesInput, "activeWorkspaceId" | "activeWorkspaceRoot" | "isPrivateWorkspacePath">,
) => workspace.workspaceType === "local" && input.isPrivateWorkspacePath(workspaceRootForInstallTarget(workspace, input));

export function buildSkillInstallTargetWorkspaces(input: BuildSkillInstallTargetWorkspacesInput): WorkspaceInfo[] {
  const activeWorkspace: WorkspaceInfo = {
    id: input.activeWorkspaceId,
    name: input.activeWorkspaceName,
    path: input.activeWorkspaceRoot,
    preset: "",
    workspaceType: input.activeWorkspaceType,
  };
  const candidates = input.workspaces.some((workspace) => workspace.id === input.activeWorkspaceId)
    ? [...input.workspaces]
    : [activeWorkspace, ...input.workspaces];
  const seen = new Set<string>();
  return candidates.filter((workspace) => {
    if (seen.has(workspace.id)) return false;
    seen.add(workspace.id);
    return !isPrivateSkillInstallTarget(workspace, input);
  });
}
