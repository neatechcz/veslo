export function normalizeServerUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return;
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export const SERVER_LIST_STORAGE_KEY = "veslo.server.list";
export const SERVER_ACTIVE_STORAGE_KEY = "veslo.server.active";

export function resolveServerProviderInitialState(input: {
  defaultUrl: string;
  storedList: string[];
  storedActive: string;
  isTauriRuntime: boolean;
  forceProxy: boolean;
}): { list: string[]; active: string } {
  const fallback = normalizeServerUrl(input.defaultUrl) ?? "";
  if ((input.forceProxy || input.isTauriRuntime) && fallback) {
    return { list: [fallback], active: fallback };
  }

  const storedList = input.storedList
    .map((item) => normalizeServerUrl(item) ?? "")
    .filter(Boolean);
  const storedActive = normalizeServerUrl(input.storedActive) ?? "";
  const initialList = storedList.length ? storedList : fallback ? [fallback] : [];
  const initialActive = storedActive || initialList[0] || fallback || "";
  return { list: initialList, active: initialActive };
}

export function shouldPersistServerProviderStorage(isTauriRuntime: boolean) {
  return !isTauriRuntime;
}

export function serverDisplayName(url: string) {
  if (!url) return "";
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function isWorkspaceOpencodeProxyUrl(url: string) {
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname).replace(/\/+/g, "/");
    return /\/workspace\/[^/]+\/opencode(?:\/|$)/i.test(pathname);
  } catch {
    const normalized = url.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
    if (/\/workspace\/[^/]+\/opencode(?:\/|$)/i.test(normalized)) return true;
    return false;
  }
}
