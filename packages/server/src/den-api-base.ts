import { deploymentServiceUrl } from "./deployment-endpoints.js";

export const DEFAULT_DEN_API_BASE = deploymentServiceUrl("api");

const ONRENDER_HOST_SUFFIX = ".onrender.com";

function isOnrenderHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "onrender.com" || normalized.endsWith(ONRENDER_HOST_SUFFIX);
}

export function normalizeDenApiBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (isOnrenderHost(url.hostname)) return DEFAULT_DEN_API_BASE;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}
