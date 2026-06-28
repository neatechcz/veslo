import { recordAudit } from "../audit.js";
import {
  importSkillCandidates,
  listSkillImportCandidates,
} from "../skill-import-candidates.js";
import {
  emitReloadEvent,
  ensureWritable,
  jsonResponse,
  readJsonBody,
  requireClientScope,
  resolveWorkspace,
} from "../route-helpers.js";
import { addRoute, type Route } from "../routing.js";
import { shortId } from "../utils.js";

export type SkillImportRouteDependencies = {
  serverDataDir: string;
};

export function registerSkillImportRoutes(
  routes: Route[],
  dependencies: SkillImportRouteDependencies,
): void {
  const { serverDataDir } = dependencies;

  addRoute(routes, "GET", "/skills/import-candidates", "client", async (ctx) => {
    const items = await listSkillImportCandidates({
      workspaces: ctx.config.workspaces,
      dataDir: serverDataDir,
    });
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/skills/import-candidates/import", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const body = await readJsonBody(ctx.request);
    const candidateIds = Array.isArray(body?.candidateIds)
      ? body.candidateIds.map((id) => String(id).trim()).filter(Boolean)
      : [];

    const result = await importSkillCandidates({
      workspaces: ctx.config.workspaces,
      dataDir: serverDataDir,
      actor: ctx.actor ?? { type: "remote" },
      candidateIds,
    });

    const successful = result.results.filter((item) => item.ok);
    for (const item of successful) {
      if (item.target?.scope === "workspace") {
        try {
          const workspace = await resolveWorkspace(ctx.config, item.target.workspaceId);
          await recordAudit(workspace.path, {
            id: shortId(),
            workspaceId: workspace.id,
            actor: ctx.actor ?? { type: "remote" },
            action: "skills.import",
            target: item.path ?? item.name ?? item.candidateId,
            summary: `Imported skill ${item.name ?? item.candidateId}`,
            timestamp: Date.now(),
          });
          emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
            type: "skill",
            name: item.name,
            action: "added",
            path: item.path,
          });
        } catch {
          // Import succeeded; skip stale workspace reload/audit failures.
        }
      }
    }

    return jsonResponse({
      ...result,
      ok: result.results.every((item) => item.ok),
      reloadRequired: successful.length > 0,
    });
  });
}
