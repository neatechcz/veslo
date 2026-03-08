export const APP_RUNTIME_MODE = "local_sync";

export const isLocalExecutionOnly = () => APP_RUNTIME_MODE === "local_sync";
export const isRemoteUiEnabled = () => false;
