import { normalizeVesloServerUrl } from "./veslo-server";

export type SharedBundleImportIntent = "new_worker" | "import_current";

export type SharedBundleDeepLink = {
  bundleUrl: string;
  intent: SharedBundleImportIntent;
  source?: string;
  orgId?: string;
  label?: string;
};

type RemoteWorkspaceDefaults = {
  vesloHostUrl?: string | null;
  vesloToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

function normalizeSharedBundleImportIntent(value: string | null | undefined): SharedBundleImportIntent {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "new_worker" || normalized === "new-worker" || normalized === "newworker") {
    return "new_worker";
  }
  return "import_current";
}

export function parseSharedBundleDeepLink(rawUrl: string): SharedBundleDeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== "veslo:" && protocol !== "https:" && protocol !== "http:") {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  const looksLikeImportRoute =
    routeHost === "import-bundle" ||
    routePath === "import-bundle" ||
    routeTail === "import-bundle";

  const rawBundleUrl =
    url.searchParams.get("veslo_bundle") ??
    url.searchParams.get("ow_bundle") ??
    url.searchParams.get("bundleUrl") ??
    "";

  if (!looksLikeImportRoute && !rawBundleUrl.trim()) {
    return null;
  }

  try {
    const parsedBundleUrl = new URL(rawBundleUrl.trim());
    if (parsedBundleUrl.protocol !== "https:" && parsedBundleUrl.protocol !== "http:") {
      return null;
    }
    const intent = normalizeSharedBundleImportIntent(
      url.searchParams.get("veslo_intent") ??
        url.searchParams.get("ow_intent") ??
        url.searchParams.get("intent"),
    );
    const source = (
      url.searchParams.get("veslo_source") ??
      url.searchParams.get("ow_source") ??
      url.searchParams.get("source") ??
      ""
    ).trim();
    const orgId = (url.searchParams.get("veslo_org") ?? url.searchParams.get("ow_org") ?? "").trim();
    const label = (url.searchParams.get("veslo_label") ?? url.searchParams.get("ow_label") ?? "").trim();
    return {
      bundleUrl: parsedBundleUrl.toString(),
      intent,
      source: source || undefined,
      orgId: orgId || undefined,
      label: label || undefined,
    };
  } catch {
    return null;
  }
}

export function stripSharedBundleQuery(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  let changed = false;
  for (const key of [
    "veslo_bundle",
    "ow_bundle",
    "bundleUrl",
    "veslo_intent",
    "ow_intent",
    "intent",
    "veslo_source",
    "ow_source",
    "source",
    "veslo_org",
    "ow_org",
    "veslo_label",
    "ow_label",
  ]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  if (!changed) {
    return null;
  }

  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}

export function parseRemoteConnectDeepLink(rawUrl: string): RemoteWorkspaceDefaults | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== "veslo:" && protocol !== "https:" && protocol !== "http:") {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (routeHost !== "connect-remote" && routePath !== "connect-remote" && routeTail !== "connect-remote") {
    return null;
  }

  const hostUrlRaw = url.searchParams.get("vesloHostUrl") ?? url.searchParams.get("vesloUrl") ?? "";
  const tokenRaw = url.searchParams.get("vesloToken") ?? url.searchParams.get("accessToken") ?? "";
  const normalizedHostUrl = normalizeVesloServerUrl(hostUrlRaw);
  const token = tokenRaw.trim();
  if (!normalizedHostUrl || !token) {
    return null;
  }

  const workerName = url.searchParams.get("workerName")?.trim() ?? "";
  const workerId = url.searchParams.get("workerId")?.trim() ?? "";
  const displayName = workerName || (workerId ? `Worker ${workerId.slice(0, 8)}` : "");

  return {
    vesloHostUrl: normalizedHostUrl,
    vesloToken: token,
    directory: null,
    displayName: displayName || null,
  };
}

export function stripRemoteConnectQuery(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  let changed = false;
  for (const key of [
    "vesloHostUrl",
    "vesloUrl",
    "vesloToken",
    "accessToken",
    "workerId",
    "workerName",
    "source",
  ]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  if (!changed) {
    return null;
  }

  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}
