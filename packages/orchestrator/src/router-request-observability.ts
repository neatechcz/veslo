import { createHash } from "node:crypto";

export type RouterRequestObservation = {
  message: string;
  attributes: {
    method: string;
    routeFamily: string;
    status: number;
    durationMs: number;
    traceId: string | null;
    activeWorkspaceIdDigest: string | null;
  };
};

const TRACE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function routerRouteFamily(pathname: string): string {
  if (pathname === "/health") return "health";
  if (pathname === "/workspaces") return "workspaces";
  if (/^\/workspaces\/[^/]+(?:\/|$)/.test(pathname)) return "workspace-management";
  if (/^\/workspace\/[^/]+\/opencode(?:\/|$)/.test(pathname)) return "workspace-opencode-proxy";
  if (/^\/workspace\/[^/]+(?:\/|$)/.test(pathname)) return "workspace-runtime";
  if (/^\/instances\/[^/]+(?:\/|$)/.test(pathname)) return "instance-management";
  if (pathname.startsWith("/e2e/")) return "e2e";
  return "other";
}

function safeTraceId(value: string | string[] | undefined): string | null {
  const candidate = (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  return TRACE_ID_PATTERN.test(candidate) ? candidate : null;
}

function workspaceDigest(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  return createHash("sha256").update(candidate).digest("hex").slice(0, 16);
}

export function routerRequestObservation(input: {
  method: string;
  pathname: string;
  status: number;
  durationMs: number;
  sendTraceHeader: string | string[] | undefined;
  activeWorkspaceId: string;
}): RouterRequestObservation {
  const routeFamily = routerRouteFamily(input.pathname);
  const traceId = safeTraceId(input.sendTraceHeader);
  const activeWorkspaceIdDigest = workspaceDigest(input.activeWorkspaceId);
  const attributes = {
    method: input.method,
    routeFamily,
    status: input.status,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    traceId,
    activeWorkspaceIdDigest,
  };
  const trace = traceId ?? "none";
  const active = activeWorkspaceIdDigest ?? "none";
  return {
    attributes,
    message: `Router request ${attributes.method} ${routeFamily} status=${attributes.status} durationMs=${attributes.durationMs} traceId=${trace} activeWorkspace=${active}`,
  };
}
