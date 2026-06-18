export function normalizeServerUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return;
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
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
