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
    return {
      label: localPath,
      usePathStyle: true,
    };
  }

  return {
    label: input.localLabel,
    usePathStyle: false,
  };
};
