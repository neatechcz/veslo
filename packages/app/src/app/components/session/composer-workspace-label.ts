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

const resolveLastPathSegment = (value: string): string => {
  const normalized = value.trim().replace(/[\\/]+$/g, "");
  if (!normalized) return "";

  const segments = normalized.split(/[/\\]+/).filter(Boolean);
  return segments.at(-1)?.trim() || normalized;
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
    const leafName = resolveLastPathSegment(localPath);
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
