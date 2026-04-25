export function shouldAutoReloadManagedAiConfig(input: {
  hasManagedProfile: boolean;
  hasConfigChanged: boolean;
  hasActiveRuns: boolean;
  canReloadWorkspace: boolean;
}): boolean {
  return (
    input.hasManagedProfile &&
    input.hasConfigChanged &&
    !input.hasActiveRuns &&
    input.canReloadWorkspace
  );
}
