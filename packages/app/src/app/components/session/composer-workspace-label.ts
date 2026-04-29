import { getBasename } from "../../utils/workspace-path";

export type ComposerWorkspaceLabelInput = {
  isRemoteWorkspace: boolean;
  localWorkspacePath: string | null | undefined;
  localLabel: string;
  remoteLabel: string;
};

export type ComposerWorkspaceLabel = {
  label: string;
  usePathStyle: boolean;
};

export const resolveComposerWorkspaceLabel = (
  input: ComposerWorkspaceLabelInput,
): ComposerWorkspaceLabel => {
  if (input.isRemoteWorkspace) {
    return {
      label: input.remoteLabel,
      usePathStyle: false,
    };
  }

  const localPath = input.localWorkspacePath?.trim() ?? "";
  if (localPath) {
    const leafName = getBasename(localPath.replace(/[\\/]+$/g, ""));
    return {
      label: leafName || localPath,
      usePathStyle: true,
    };
  }

  return {
    label: input.localLabel,
    usePathStyle: false,
  };
};
