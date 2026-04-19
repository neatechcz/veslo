import type { StartupPreference } from "../types";

export function shouldAutoBootstrapRemoteServer(input: {
  cloudOnlyMode: boolean;
  startupPreference: StartupPreference | null;
  hasConfiguredServerUrl: boolean;
  preferServerByDefault: boolean;
}) {
  if (!input.hasConfiguredServerUrl) return false;
  if (input.cloudOnlyMode) return true;
  if (input.startupPreference === "local") return false;
  if (input.startupPreference === "server") return true;
  return input.preferServerByDefault;
}
