declare module "./local-file-path.impl.js" {
  export function normalizeLocalFilePath(value: string): string;
}

declare module "./cloud-policy.impl.js" {
  export const CLOUD_ONLY_MODE: boolean;

  export type VesloServerSettingsLike = {
    urlOverride?: string;
    portOverride?: number;
    token?: string;
  };

  export function filterRemoteWorkspaces<T extends { workspaceType?: string | null }>(
    workspaces: T[],
  ): T[];

  export function resolveVesloCloudEnvironment(
    env: Record<string, string | undefined>,
  ): {
    name: "development" | "test" | "production";
    vesloUrl: string;
    loginUrl: string;
    token?: string;
    workspaceId?: string;
  };

  export function mergeVesloServerSettingsWithEnv(
    current: VesloServerSettingsLike,
    env: Record<string, string | undefined>,
    options?: { cloudOnlyMode?: boolean },
  ): { next: VesloServerSettingsLike; changed: boolean };
}

declare module "./runtime-policy.impl.js" {
  export const APP_RUNTIME_MODE: "local_sync" | "cloud_only" | "hybrid";
  export function isLocalExecutionOnly(): boolean;
  export function isRemoteUiEnabled(): boolean;
}
