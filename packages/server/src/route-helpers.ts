import { resolve, sep } from "node:path";

import { ApiError } from "./errors.js";
import type { RequestContext } from "./routing.js";
import type {
  ApprovalRequest,
  ReloadReason,
  ReloadTrigger,
  ServerConfig,
  TokenScope,
  WorkspaceInfo,
} from "./types.js";
import type { ReloadEventStore } from "./events.js";

const DEFAULT_JSON_BODY_MAX_BYTES = 1024 * 1024;

export type BodyReadOptions = {
  maxBytes?: number;
  label?: string;
};

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function emitReloadEvent(
  reloadEvents: ReloadEventStore,
  workspace: WorkspaceInfo,
  reason: ReloadReason,
  trigger?: ReloadTrigger,
): void {
  reloadEvents.recordDebounced(workspace.id, reason, trigger);
}

export function normalizeOpencodeDirectory(directory: string): string {
  // OpenCode stores/list-filters Windows sessions by regular drive paths
  // (`C:\Users\...`). Tauri can persist local workspaces as extended-length
  // paths (`\\?\C:\Users\...`); passing those through as the directory query
  // makes OpenCode return an empty session list even though the sessions exist.
  if (process.platform === "win32") {
    return directory.replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "");
  }
  return directory;
}

export function resolveWorkspaceOpencodeBaseUrl(config: ServerConfig, workspace: WorkspaceInfo): string {
  const configured = workspace.baseUrl?.trim() ?? "";
  const derived = buildOrchestratorWorkspaceOpencodeBaseUrl(config, workspace);
  if (configured && !isEmptyWorkspaceOpencodeMount(configured)) return configured;
  return derived || configured;
}

export async function resolveWorkspace(config: ServerConfig, id: string): Promise<WorkspaceInfo> {
  const workspace = config.workspaces.find((entry) => entry.id === id);
  if (!workspace) {
    throw new ApiError(404, "workspace_not_found", "Workspace not found");
  }
  const resolvedWorkspace = resolve(workspace.path);
  const authorized = isAuthorizedRootSync(resolvedWorkspace, config.authorizedRoots);
  if (!authorized) {
    throw new ApiError(403, "workspace_unauthorized", "Workspace is not authorized");
  }
  const baseUrl = resolveWorkspaceOpencodeBaseUrl(config, workspace);
  return {
    ...workspace,
    path: resolvedWorkspace,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export function isAuthorizedRootSync(workspacePath: string, roots: string[]): boolean {
  const normalizeAuthorizedPath = (value: string) => {
    const resolved = normalizeOpencodeDirectory(resolve(value));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const resolvedWorkspace = normalizeAuthorizedPath(workspacePath);
  for (const root of roots) {
    const resolvedRoot = normalizeAuthorizedPath(root);
    if (resolvedWorkspace === resolvedRoot) return true;
    if (resolvedWorkspace.startsWith(resolvedRoot + sep)) return true;
  }
  return false;
}

export async function isAuthorizedRoot(workspacePath: string, roots: string[]): Promise<boolean> {
  const normalizeAuthorizedPath = (value: string) => {
    const resolved = normalizeOpencodeDirectory(resolve(value));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const resolvedWorkspace = normalizeAuthorizedPath(workspacePath);
  for (const root of roots) {
    const resolvedRoot = normalizeAuthorizedPath(root);
    if (resolvedWorkspace === resolvedRoot) return true;
    if (resolvedWorkspace.startsWith(resolvedRoot + sep)) return true;
  }
  return false;
}

export function ensureWritable(config: ServerConfig): void {
  if (config.readOnly) {
    throw new ApiError(403, "read_only", "Server is read-only");
  }
}

export function scopeRank(scope: TokenScope): number {
  if (scope === "viewer") return 1;
  if (scope === "collaborator") return 2;
  return 3;
}

export function requireClientScope(ctx: RequestContext, required: TokenScope): void {
  const scope = ctx.actor?.scope;
  if (!scope) {
    throw new ApiError(401, "unauthorized", "Missing token scope");
  }
  if (scopeRank(scope) < scopeRank(required)) {
    throw new ApiError(403, "forbidden", "Insufficient token scope", { required, scope });
  }
}

export async function requireApproval(
  ctx: RequestContext,
  input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">,
): Promise<void> {
  const actor = ctx.actor ?? { type: "remote" };
  const result = await ctx.approvals.requestApproval({ ...input, actor });
  if (!result.allowed) {
    throw new ApiError(403, "write_denied", "Write request denied", {
      requestId: result.id,
      reason: result.reason,
    });
  }
}

export async function requireSoulApproval(
  ctx: RequestContext,
  input: {
    workspaceId: string;
    action: string;
    summary: string;
    paths: string[];
  },
): Promise<void> {
  await requireApproval(ctx, {
    workspaceId: input.workspaceId,
    action: input.action,
    summary: input.summary,
    paths: uniqueApprovalPaths(input.paths),
  });
}

export function readMaxBytes(options?: BodyReadOptions): number {
  return options?.maxBytes ?? DEFAULT_JSON_BODY_MAX_BYTES;
}

export function bodyLimitLabel(options?: BodyReadOptions): string {
  return options?.label ?? "request body";
}

export function contentLengthFor(headers: Headers): number | null {
  const parsed = Number(headers.get("content-length") ?? NaN);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

export async function readTextPreview(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = Buffer.from(value);
      const remaining = maxBytes - total;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
          total += remaining;
        }
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }

      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    if (truncated) {
      await reader.cancel().catch(() => undefined);
    }
  }

  return {
    text: Buffer.concat(chunks).toString("utf8"),
    truncated,
  };
}

export async function readRequestTextWithLimit(request: Request, options?: BodyReadOptions): Promise<string> {
  const maxBytes = readMaxBytes(options);
  const label = bodyLimitLabel(options);
  const contentLength = contentLengthFor(request.headers);
  if (contentLength !== null && contentLength > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw new ApiError(413, "payload_too_large", "Request body exceeds size limit", {
      label,
      maxBytes,
      size: contentLength,
    });
  }

  const preview = await readTextPreview(request.body, maxBytes);
  if (preview.truncated) {
    throw new ApiError(413, "payload_too_large", "Request body exceeds size limit", {
      label,
      maxBytes,
    });
  }
  return preview.text;
}

export async function readJsonBody(request: Request, options?: BodyReadOptions): Promise<Record<string, unknown>> {
  try {
    const text = await readRequestTextWithLimit(request, options);
    const json = JSON.parse(text);
    return json as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

export async function readOptionalJsonBody(request: Request, options?: BodyReadOptions): Promise<Record<string, unknown>> {
  const text = await readRequestTextWithLimit(request, options);
  if (!text.trim()) return {};
  try {
    const json = JSON.parse(text);
    return json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : {};
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

export function buildOrchestratorWorkspaceOpencodeBaseUrl(config: ServerConfig, workspace: WorkspaceInfo): string {
  if (workspace.workspaceType !== "local") return "";
  const daemonUrl = config.orchestratorDaemonUrl?.trim().replace(/\/+$/, "") ?? "";
  const workspaceId = workspace.id?.trim() ?? "";
  if (!daemonUrl || !workspaceId) return "";
  return `${daemonUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode`;
}

function isEmptyWorkspaceOpencodeMount(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const match = url.pathname.match(/^\/workspace\/([^/]*)\/opencode(?:\/.*)?$/);
    return Boolean(match && !(match[1] ?? "").trim());
  } catch {
    return false;
  }
}

function uniqueApprovalPaths(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => path.trim().length > 0))];
}
