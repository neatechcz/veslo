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

const readScoped = (env, key, suffix) => env?.[`${key}_${suffix}`] ?? env?.[key] ?? "";

export const filterRemoteWorkspaces = (workspaces) =>
  (Array.isArray(workspaces) ? workspaces : []).filter((entry) =>
    String(entry?.workspaceType ?? "").trim().toLowerCase() === "remote",
  );

export const resolveVesloCloudEnvironment = (env) => {
  const name = normalizeEnvName(env?.VITE_VESLO_ENV);
  const suffix = envSuffix(name);
  const vesloUrl = normalizeUrl(readScoped(env, "VITE_VESLO_URL", suffix));
  const loginUrl = normalizeUrl(readScoped(env, "VITE_VESLO_LOGIN_URL", suffix));
  const token = String(readScoped(env, "VITE_VESLO_TOKEN", suffix) ?? "").trim();
  const workspaceId = String(readScoped(env, "VITE_VESLO_WORKSPACE_ID", suffix) ?? "").trim();

  return {
    name,
    vesloUrl,
    loginUrl,
    token: token || undefined,
    workspaceId: workspaceId || undefined,
  };
};
