import type { WorkspaceInfo } from "../lib/tauri";
import type { OpencodeAuth } from "../lib/opencode";

export type WorkspaceActivationOptions = {
  origin: string;
  promoteToFront?: boolean;
  blockingOverlay?: boolean;
};

export type WorkspaceConnectContext = {
  workspaceId?: string;
  workspaceType?: WorkspaceInfo["workspaceType"];
  targetRoot?: string;
  reason?: string;
};

export type WorkspaceConnectOptions = {
  quiet?: boolean;
  navigate?: boolean;
  forceRefresh?: boolean;
};

export type ConnectToServer = (
  nextBaseUrl: string,
  directory?: string,
  context?: WorkspaceConnectContext,
  auth?: OpencodeAuth,
  connectOptions?: WorkspaceConnectOptions,
) => Promise<boolean>;
