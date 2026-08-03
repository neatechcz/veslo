import { addRoute, type Route } from "../routing.js";
import type { SessionArchiveRecord } from "../session-archives.js";
import {
  ensureWritable,
  jsonResponse,
  readJsonBody,
  requireClientScope,
} from "../route-helpers.js";

type SessionArchiveStore = {
  list: (ownerKey: string) => Promise<SessionArchiveRecord[]>;
  put: (ownerKey: string, input: SessionArchiveRecord) => Promise<SessionArchiveRecord[]>;
  delete: (
    ownerKey: string,
    sessionId: string,
    options?: { workspaceId?: string | null; workspaceIdentity?: string | null; directory?: string | null },
  ) => Promise<SessionArchiveRecord[]>;
};

export type SessionArchiveRouteDependencies = {
  resolveArchiveOwnerKey: (request: Request) => string;
  sessionArchives: SessionArchiveStore;
};

export function registerSessionArchiveRoutes(routes: Route[], dependencies: SessionArchiveRouteDependencies): void {
  addRoute(routes, "GET", "/session-archives", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const ownerKey = dependencies.resolveArchiveOwnerKey(ctx.request);
    return jsonResponse({ items: await dependencies.sessionArchives.list(ownerKey) });
  });

  addRoute(routes, "PUT", "/session-archives/:sessionId", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const ownerKey = dependencies.resolveArchiveOwnerKey(ctx.request);
    const body = await readJsonBody(ctx.request);
    const archivedAt = typeof body.archivedAt === "number" && Number.isFinite(body.archivedAt) ? body.archivedAt : Date.now();
    const titleSnapshot = typeof body.titleSnapshot === "string" ? body.titleSnapshot : "";
    return jsonResponse({
      items: await dependencies.sessionArchives.put(ownerKey, {
        sessionId: ctx.params.sessionId,
        archivedAt,
        titleSnapshot,
        workspaceIdAtArchive: typeof body.workspaceIdAtArchive === "string" ? body.workspaceIdAtArchive : undefined,
        workspaceLabelSnapshot: typeof body.workspaceLabelSnapshot === "string" ? body.workspaceLabelSnapshot : undefined,
        resolvedDirectoryAtArchive:
          typeof body.resolvedDirectoryAtArchive === "string" ? body.resolvedDirectoryAtArchive : undefined,
        projectRootAtArchive: typeof body.projectRootAtArchive === "string" ? body.projectRootAtArchive : undefined,
        projectLabelSnapshot: typeof body.projectLabelSnapshot === "string" ? body.projectLabelSnapshot : undefined,
        parentSessionId:
          typeof body.parentSessionId === "string"
            ? body.parentSessionId
            : body.parentSessionId === null
              ? null
              : undefined,
        createdAtSnapshot:
          typeof body.createdAtSnapshot === "number" && Number.isFinite(body.createdAtSnapshot)
            ? body.createdAtSnapshot
            : body.createdAtSnapshot === null
              ? null
              : undefined,
        updatedAtSnapshot:
          typeof body.updatedAtSnapshot === "number" && Number.isFinite(body.updatedAtSnapshot)
            ? body.updatedAtSnapshot
            : body.updatedAtSnapshot === null
              ? null
              : undefined,
        workspaceIdentity: typeof body.workspaceIdentity === "string" ? body.workspaceIdentity : undefined,
      }),
    });
  });

  addRoute(routes, "DELETE", "/session-archives/:sessionId", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const ownerKey = dependencies.resolveArchiveOwnerKey(ctx.request);
    const workspaceId = ctx.url.searchParams.get("workspaceId")?.trim() || undefined;
    const workspaceIdentity = ctx.url.searchParams.get("workspaceIdentity")?.trim() || undefined;
    const directory = ctx.url.searchParams.get("directory")?.trim() || undefined;
    return jsonResponse({
      items: await dependencies.sessionArchives.delete(ownerKey, ctx.params.sessionId, {
        workspaceId,
        workspaceIdentity,
        directory,
      }),
    });
  });
}
