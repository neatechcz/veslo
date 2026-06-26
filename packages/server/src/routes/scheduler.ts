import { recordAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import { addRoute, type Route } from "../routing.js";
import {
  deleteScheduledJob,
  listScheduledJobs,
  resolveScheduledJob,
} from "../scheduler.js";
import {
  ensureWritable,
  jsonResponse,
  requireApproval,
  requireClientScope,
  resolveWorkspace,
} from "../route-helpers.js";
import { shortId } from "../utils.js";

export function registerSchedulerRoutes(routes: Route[]): void {
  addRoute(routes, "GET", "/workspace/:id/scheduler/jobs", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const items = await listScheduledJobs(workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/scheduler/jobs/:name", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name;
    if (!name) {
      throw new ApiError(400, "job_name_required", "name is required");
    }

    const { job, jobFile, systemPaths } = await resolveScheduledJob(name, workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "scheduler.delete",
      summary: `Delete scheduled job ${job.name}`,
      paths: [jobFile, ...systemPaths],
    });

    await deleteScheduledJob(job, jobFile);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "scheduler.delete",
      target: jobFile,
      summary: `Deleted scheduled job ${job.name}`,
      timestamp: Date.now(),
    });

    return jsonResponse({ job });
  });
}
