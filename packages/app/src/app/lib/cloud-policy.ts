import {
  filterRemoteWorkspaces as filterRemoteWorkspacesImpl,
  mergeVesloServerSettingsWithEnv as mergeVesloServerSettingsWithEnvImpl,
  resolveVesloCloudEnvironment as resolveVesloCloudEnvironmentImpl,
} from "./cloud-policy.impl.js";
import { APP_RUNTIME_MODE } from "./runtime-policy";

export type VesloCloudEnvironment = {
  name: "development" | "test" | "production";
  vesloUrl: string;
  loginUrl: string;
  token?: string;
  workspaceId?: string;
};

export type VesloServerSettingsLike = {
  urlOverride?: string;
  portOverride?: number;
  token?: string;
};

export const CLOUD_ONLY_MODE: boolean = APP_RUNTIME_MODE === "cloud_only";

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

export const mergeVesloServerSettingsWithEnv = (
  current: VesloServerSettingsLike,
  env: Record<string, string | undefined>,
  options?: { cloudOnlyMode?: boolean },
): { next: VesloServerSettingsLike; changed: boolean } =>
  mergeVesloServerSettingsWithEnvImpl(current, env, options) as {
    next: VesloServerSettingsLike;
    changed: boolean;
  };
