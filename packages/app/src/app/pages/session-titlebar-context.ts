import { resolveComposerWorkspaceLabel } from "../components/session/composer-workspace-label";

type SessionTitlebarWorkspaceType = "local" | "remote";

export type SessionTitlebarContextInput = {
  selectedSessionId: string | null | undefined;
  selectedSessionTitle?: string | null;
  messageCount: number;
  workspaceType: SessionTitlebarWorkspaceType;
  activeWorkspaceRoot: string | null | undefined;
  localWorkspaceLabel: string;
  remoteWorkspaceLabel: string;
  newSessionLabel: string;
  chatFallbackLabel: string;
  isPrivateWorkspacePath?: boolean;
};

export type SessionTitlebarContext = {
  stateLabel: string | null;
  locationLabel: string | null;
  locationTitle: string | null;
  locationUsePathStyle: boolean;
};

export const resolveSessionTitlebarContext = (
  input: SessionTitlebarContextInput,
): SessionTitlebarContext | null => {
  const selectedSessionId = input.selectedSessionId?.trim() ?? "";
  const isNewSession = selectedSessionId.length === 0 && input.messageCount === 0;
  const rootPath = input.activeWorkspaceRoot?.trim() ?? "";
  const isRemoteWorkspace = input.workspaceType === "remote";
  const isPrivateWorkspace = !isRemoteWorkspace && input.isPrivateWorkspacePath === true;
  const privateChatLabel =
    input.selectedSessionTitle?.trim() ||
    input.chatFallbackLabel.trim() ||
    input.newSessionLabel.trim() ||
    null;
  const stateLabel = isPrivateWorkspace
    ? isNewSession
      ? input.newSessionLabel.trim() || privateChatLabel
      : privateChatLabel
    : isNewSession
      ? input.newSessionLabel.trim() || null
      : null;
  const hideLocalLocation = !isRemoteWorkspace && (!rootPath || isPrivateWorkspace);

  let locationLabel: string | null = null;
  let locationTitle: string | null = null;
  let locationUsePathStyle = false;

  if (!hideLocalLocation) {
    const label = resolveComposerWorkspaceLabel({
      isRemoteWorkspace,
      localWorkspacePath: rootPath,
      localLabel: input.localWorkspaceLabel,
      remoteLabel: input.remoteWorkspaceLabel,
    });
    const trimmedLabel = label.label.trim();
    if (trimmedLabel) {
      locationLabel = trimmedLabel;
      locationTitle = label.usePathStyle && rootPath ? rootPath : trimmedLabel;
      locationUsePathStyle = label.usePathStyle;
    }
  }

  if (!stateLabel && !locationLabel) return null;

  return {
    stateLabel,
    locationLabel,
    locationTitle,
    locationUsePathStyle,
  };
};
