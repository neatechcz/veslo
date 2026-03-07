import {
  CLOUD_ONLY_MODE as cloudOnlyModeImpl,
  filterRemoteWorkspaces as filterRemoteWorkspacesImpl,
  resolveVesloCloudEnvironment as resolveVesloCloudEnvironmentImpl,
} from "./cloud-policy.impl.js";

export type VesloCloudEnvironment = {
  name: "development" | "test" | "production";
  vesloUrl: string;
  loginUrl: string;
  token?: string;
  workspaceId?: string;
};

export const CLOUD_ONLY_MODE: boolean = cloudOnlyModeImpl;

export const filterRemoteWorkspaces = <
  T extends {
    workspaceType?: string | null;
  },
>(
  workspaces: T[],
): T[] => filterRemoteWorkspacesImpl(workspaces) as T[];

export const resolveVesloCloudEnvironment = (
  env: Record<string, string | undefined>,
): VesloCloudEnvironment => resolveVesloCloudEnvironmentImpl(env) as VesloCloudEnvironment;
