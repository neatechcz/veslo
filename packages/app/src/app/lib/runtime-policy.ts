import {
  APP_RUNTIME_MODE as runtimeModeImpl,
  isLocalExecutionOnly as isLocalExecutionOnlyImpl,
  isRemoteUiEnabled as isRemoteUiEnabledImpl,
} from "./runtime-policy.impl.js";

export const APP_RUNTIME_MODE: "local_sync" | "cloud_only" | "hybrid" = runtimeModeImpl;
export const isLocalExecutionOnly = () => Boolean(isLocalExecutionOnlyImpl());
export const isRemoteUiEnabled = () => Boolean(isRemoteUiEnabledImpl());
