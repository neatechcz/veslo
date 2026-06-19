import {
  AI_ACCESS_NOT_CONFIGURED_MESSAGE,
  type ManagedAiAccessProfile,
} from "../lib/ai-access";

export type ManagedAiRuntimeAccessProfile = ManagedAiAccessProfile;

const trim = (value: string | null | undefined) => value?.trim() ?? "";

export type ManagedAiAccessRefreshPreflightDecision =
  | { type: "reset"; reason: "missing-gateway" | "missing-user-token" | "deferred-local-gateway" }
  | { type: "use-cache" }
  | { type: "load"; applyCachedAccessFirst: boolean };

export function resolveManagedAiAccessRefreshPreflight(input: {
  hasGatewayClient: boolean;
  managedAiBaseUrl?: string | null;
  userToken?: string | null;
  deferForLocalGateway: boolean;
  cachedAccessPresent: boolean;
  freshCachedAccessPresent?: boolean;
}): ManagedAiAccessRefreshPreflightDecision {
  if (!input.hasGatewayClient && !trim(input.managedAiBaseUrl)) {
    return { type: "reset", reason: "missing-gateway" };
  }
  if (!trim(input.userToken)) {
    return { type: "reset", reason: "missing-user-token" };
  }
  if (input.deferForLocalGateway) {
    return { type: "reset", reason: "deferred-local-gateway" };
  }
  if (input.freshCachedAccessPresent) {
    return { type: "use-cache" };
  }
  return { type: "load", applyCachedAccessFirst: input.cachedAccessPresent };
}

export type ManagedAiAccessRefreshSuccessDecision =
  | {
    type: "apply-profile";
    profile: ManagedAiAccessProfile;
    gatewayAccessToken: string;
    error: null;
    writeCache: true;
    retry: false;
  }
  | {
    type: "clear-profile";
    gatewayAccessToken: "";
    error: string;
    clearCache: true;
    retry: true;
  };

export function resolveManagedAiAccessRefreshSuccess(input: {
  profile: ManagedAiAccessProfile | null;
  gatewayAccessToken: string;
  reason?: string | null;
}): ManagedAiAccessRefreshSuccessDecision {
  if (input.profile) {
    return {
      type: "apply-profile",
      profile: input.profile,
      gatewayAccessToken: input.gatewayAccessToken,
      error: null,
      writeCache: true,
      retry: false,
    };
  }
  return {
    type: "clear-profile",
    gatewayAccessToken: "",
    error: trim(input.reason) || AI_ACCESS_NOT_CONFIGURED_MESSAGE,
    clearCache: true,
    retry: true,
  };
}

export function resolveManagedAiAccessRefreshFailure(input: {
  cachedAccessPresent: boolean;
  errorMessage: string;
}): {
  clearProfile: boolean;
  gatewayAccessToken: "" | null;
  error: string;
  retry: true;
} {
  return {
    clearProfile: !input.cachedAccessPresent,
    gatewayAccessToken: input.cachedAccessPresent ? null : "",
    error: input.errorMessage,
    retry: true,
  };
}
