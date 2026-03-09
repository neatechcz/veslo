import { APP_RUNTIME_MODE } from "./runtime-policy.impl.js";

export const CLOUD_ONLY_MODE = APP_RUNTIME_MODE === "cloud_only";

const normalizeUrl = (raw) => {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, "");
};

const normalizeEnvName = (raw) => {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "development" || value === "test" || value === "production") {
    return value;
  }
  return "production";
};

const envSuffix = (envName) => {
  if (envName === "development") return "DEV";
  if (envName === "test") return "TEST";
  return "PROD";
};

const readScoped = (env, key, suffix, envName) => {
  const canonicalEnvSuffix = String(envName ?? "").trim().toUpperCase();
  return env?.[`${key}_${suffix}`] ?? env?.[`${key}_${canonicalEnvSuffix}`] ?? env?.[key] ?? "";
};

export const filterRemoteWorkspaces = (workspaces) =>
  (Array.isArray(workspaces) ? workspaces : []).filter((entry) =>
    String(entry?.workspaceType ?? "").trim().toLowerCase() === "remote",
  );

export const resolveVesloCloudEnvironment = (env) => {
  const name = normalizeEnvName(env?.VITE_VESLO_ENV);
  const suffix = envSuffix(name);
  const vesloUrl = normalizeUrl(readScoped(env, "VITE_VESLO_URL", suffix, name));
  const loginUrl = normalizeUrl(readScoped(env, "VITE_VESLO_LOGIN_URL", suffix, name));
  const token = String(readScoped(env, "VITE_VESLO_TOKEN", suffix, name) ?? "").trim();
  const workspaceId = String(readScoped(env, "VITE_VESLO_WORKSPACE_ID", suffix, name) ?? "").trim();

  return {
    name,
    vesloUrl,
    loginUrl,
    token: token || undefined,
    workspaceId: workspaceId || undefined,
  };
};

export const mergeVesloServerSettingsWithEnv = (
  current,
  env,
  options = {},
) => {
  const existing = current ?? {};
  const cloudOnlyMode = options.cloudOnlyMode ?? CLOUD_ONLY_MODE;
  const resolvedEnv = resolveVesloCloudEnvironment(env ?? {});
  const envUrl = resolvedEnv.vesloUrl;
  const envToken = resolvedEnv.token ?? "";
  const envPortRaw = typeof env?.VITE_VESLO_PORT === "string" ? env.VITE_VESLO_PORT.trim() : "";
  const envPortParsed = Number(envPortRaw);
  const envPort = Number.isFinite(envPortParsed) && envPortParsed > 0 ? envPortParsed : undefined;

  let changed = false;
  const next = { ...existing };

  if (cloudOnlyMode) {
    if (envUrl && next.urlOverride !== envUrl) {
      next.urlOverride = envUrl;
      changed = true;
    }
    if (envToken && next.token !== envToken) {
      next.token = envToken;
      changed = true;
    }
    if (typeof envPort === "number" && next.portOverride !== envPort) {
      next.portOverride = envPort;
      changed = true;
    }
  } else {
    if (!next.urlOverride && envUrl) {
      next.urlOverride = envUrl;
      changed = true;
    }
    if (!next.token && envToken) {
      next.token = envToken;
      changed = true;
    }
    if (typeof next.portOverride !== "number" && typeof envPort === "number") {
      next.portOverride = envPort;
      changed = true;
    }
  }

  return { next, changed };
};
