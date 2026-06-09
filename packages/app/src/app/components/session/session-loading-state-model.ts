type SessionLoadingStateInput = {
  hasWorkspaceSetupEmptyState: boolean;
  selectedSessionId: string | null;
  messageCount: number;
  loadingEarlierMessages: boolean;
};

export const shouldShowSessionLoadingState = (
  input: SessionLoadingStateInput,
) => {
  if (input.hasWorkspaceSetupEmptyState) return false;
  if (!input.selectedSessionId) return false;
  if (input.messageCount > 0) return false;
  return input.loadingEarlierMessages;
};
