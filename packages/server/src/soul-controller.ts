import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ApiError } from "./errors.js";
import {
  localUserResourceOwner,
  organizationResourceOwner,
  workspaceResourceOwner,
} from "./resource-owner.js";
import {
  resolveWorkspace,
  scopeRank,
} from "./route-helpers.js";
import type { RequestContext } from "./routing.js";
import {
  getOrganizationSoul,
  getUserSoul,
} from "./soul-den-client.js";
import {
  cacheSoulDocument,
  clearPendingSoulEdits,
  listPendingSoulEdits,
  readCachedSoulDocument,
  readSingleCachedSoulDocument,
  type SoulPendingEdit,
} from "./soul-cache.js";
import {
  currentSoulVersion,
  type SoulDocument,
  type SoulScope,
  type SoulVersion,
} from "./soul-memory.js";
import {
  readDenUserIdentityHeader,
  readSoulDenContext,
} from "./request-headers.js";
import {
  materializeEffectiveSoul,
  readSoulMaterializationManifest,
  readSoulMaterializationStatus,
  type SoulMaterializationResult,
} from "./soul-materializer.js";
import { soulMaterializationApprovalPaths as soulRuntimeMaterializationApprovalPaths } from "./soul-runtime.js";
import type { ResourceOwner, ServerConfig, WorkspaceInfo } from "./types.js";
import { shortId } from "./utils.js";

export type SoulSummary = {
  scope: "organization" | "user" | "workspace";
  ownerId: string;
  owner: ResourceOwner;
  title: string;
  currentVersionId: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  status: "active" | "pending" | "conflict" | "not_configured";
  heartbeatEnabled: boolean;
  pendingSuggestionCount: number;
  canEdit: boolean;
};

export type SoulDenContext = {
  baseUrl: string;
  denToken?: string;
  orgId?: string;
  userId?: string;
};

export type SoulModel = {
  document: SoulDocument | null;
  summary: SoulSummary;
  pendingEdits?: SoulPendingEdit[];
  denSynced?: boolean;
  materialization?: unknown;
};

export type SoulMaterializationTestHookInput = {
  workspaceId: string;
  overrides: Partial<Record<SoulScope, SoulDocument | null>>;
};

function ownerForWorkspace(workspace: WorkspaceInfo): ResourceOwner {
  return workspaceResourceOwner({ workspaceId: workspace.id, root: workspace.path, label: workspace.name });
}

function soulUpdatedAt(document: SoulDocument | null): string | null {
  if (!document) return null;
  return currentSoulVersion(document)?.createdAt ?? null;
}

function soulUpdatedBy(document: SoulDocument | null): string | null {
  if (!document) return null;
  return currentSoulVersion(document)?.createdBy ?? null;
}

function soulTitle(scope: SoulScope, workspace?: WorkspaceInfo): string {
  if (scope === "organization") return "Organization Soul";
  if (scope === "user") return "User Soul";
  return workspace?.name ? `${workspace.name} Soul` : "Workspace Soul";
}

function soulResourceOwner(input: {
  scope: SoulScope;
  ownerId: string;
  workspace?: WorkspaceInfo;
}): ResourceOwner {
  if (input.scope === "organization") {
    return organizationResourceOwner({ orgId: input.ownerId, label: "Organization" });
  }
  if (input.scope === "user") {
    return localUserResourceOwner({ userId: input.ownerId, label: "User" });
  }
  if (input.workspace) {
    return ownerForWorkspace(input.workspace);
  }
  return workspaceResourceOwner({ workspaceId: input.ownerId });
}

function isSoulDenUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.code === "soul_den_fetch_failed" || error.code === "soul_den_misconfigured";
}

function uniqueApprovalPaths(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => path.trim().length > 0))];
}

export function createSoulController() {
  let materializationTestHookForTests: ((input: SoulMaterializationTestHookInput) => Promise<void>) | null = null;
  const materializationLocks = new Map<string, Promise<void>>();

  function setMaterializationTestHookForTests(
    hook: ((input: SoulMaterializationTestHookInput) => Promise<void>) | null,
  ): void {
    materializationTestHookForTests = hook;
  }

  async function withSoulMaterializationLock<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
    const previous = materializationLocks.get(workspaceId)?.catch(() => undefined) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      releaseCurrent = resolveCurrent;
    });
    const queued = previous.then(() => current);
    materializationLocks.set(workspaceId, queued);
    await previous;
    try {
      return await run();
    } finally {
      releaseCurrent();
      if (materializationLocks.get(workspaceId) === queued) {
        materializationLocks.delete(workspaceId);
      }
    }
  }

  function soulDenContext(ctx: RequestContext): SoulDenContext {
    return readSoulDenContext(ctx);
  }

  function requireSoulDenToken(ctx: SoulDenContext): string {
    if (!ctx.denToken) {
      throw new ApiError(401, "den_token_required", "Den token is required");
    }
    return ctx.denToken;
  }

  function requireSoulOrgId(ctx: SoulDenContext): string {
    if (!ctx.orgId) {
      throw new ApiError(400, "den_org_required", "Den organization id is required");
    }
    return ctx.orgId;
  }

  function requireSoulUserId(ctx: SoulDenContext): string {
    if (!ctx.userId) {
      throw new ApiError(400, "den_user_required", "Den user id is required");
    }
    return ctx.userId;
  }

  function soulCanEdit(ctx: RequestContext, scope: SoulScope): boolean {
    if (ctx.config.readOnly) return false;
    const tokenScope = ctx.actor?.scope;
    const hasCollaboratorScope = Boolean(tokenScope && scopeRank(tokenScope) >= scopeRank("collaborator"));
    if (scope === "organization") {
      const den = soulDenContext(ctx);
      return Boolean(hasCollaboratorScope && den.denToken && den.orgId);
    }
    return hasCollaboratorScope;
  }

  function soulSummary(input: {
    scope: SoulScope;
    ownerId: string;
    document: SoulDocument | null;
    canEdit: boolean;
    status?: SoulSummary["status"];
    workspace?: WorkspaceInfo;
  }): SoulSummary {
    const status = input.status ?? (input.document?.currentVersionId ? "active" : "not_configured");
    return {
      scope: input.scope,
      ownerId: input.ownerId,
      owner: soulResourceOwner(input),
      title: soulTitle(input.scope, input.workspace),
      currentVersionId: input.document?.currentVersionId ?? null,
      updatedAt: soulUpdatedAt(input.document),
      updatedBy: soulUpdatedBy(input.document),
      status,
      heartbeatEnabled: input.document?.heartbeatEnabled ?? false,
      pendingSuggestionCount: 0,
      canEdit: input.canEdit,
    };
  }

  function emptySoulDocument(scope: SoulScope, ownerId: string): SoulDocument {
    return {
      id: `${scope}_${ownerId}`,
      scope,
      ownerId,
      currentVersionId: null,
      heartbeatEnabled: false,
      versions: [],
    };
  }

  function validateSoulScopeParam(value: string): SoulScope {
    if (value === "organization" || value === "user" || value === "workspace") return value;
    throw new ApiError(400, "invalid_soul_scope", "Soul scope is invalid");
  }

  function requireSoulText(body: Record<string, unknown>, field: "content" | "changeSummary"): string {
    const value = body[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new ApiError(400, "invalid_request", `Field ${field} is required`);
    }
    return value;
  }

  function optionalSoulBaseVersionId(body: Record<string, unknown>): string | null {
    const value = body.baseVersionId;
    if (value === undefined || value === null) return null;
    if (typeof value === "string") return value;
    throw new ApiError(400, "invalid_request", "Field baseVersionId must be a string or null");
  }

  function soulActorId(ctx: RequestContext): string {
    return readDenUserIdentityHeader(ctx.request) ||
      ctx.actor?.tokenHash ||
      ctx.actor?.clientId ||
      "system";
  }

  function soulVersionId(prefix = "soul_v"): string {
    return `${prefix}${shortId()}`;
  }

  function soulVersionResponse(document: SoulDocument, versionId: string): SoulVersion {
    const version = document.versions.find((item) => item.id === versionId);
    if (!version) {
      throw new ApiError(404, "soul_version_not_found", "Soul version not found");
    }
    return version;
  }

  async function readCachedSoulVersions(dataDir: string, scope: SoulScope, ownerId: string): Promise<SoulVersion[]> {
    const document = await readCachedSoulDocument({ dataDir, scope, ownerId });
    return document?.versions ?? [];
  }

  async function readPendingSoulEditsFor(dataDir: string, scope: SoulScope, ownerId: string): Promise<SoulPendingEdit[]> {
    const edits = await listPendingSoulEdits({ dataDir });
    return edits.filter((edit) => edit.scope === scope && edit.ownerId === ownerId);
  }

  async function readCachedSoulForMaterialization(
    dataDir: string,
    scope: SoulScope,
    ownerId: string | undefined,
    workspaceRoot?: string,
  ): Promise<SoulDocument | null> {
    const cached = ownerId
      ? await readCachedSoulDocument({ dataDir, scope, ownerId })
      : await readSingleCachedSoulDocument({ dataDir, scope });
    if (cached) return cached;
    const existing = workspaceRoot
      ? await readMaterializedSoulDocumentForScope(workspaceRoot, scope)
      : null;
    if (!existing) return null;
    if (ownerId && existing.ownerId !== ownerId) return null;
    return existing;
  }

  async function readMaterializedSoulDocumentForScope(
    workspaceRoot: string,
    scope: SoulScope,
  ): Promise<SoulDocument | null> {
    let manifest: Awaited<ReturnType<typeof readSoulMaterializationManifest>>;
    try {
      manifest = await readSoulMaterializationManifest(workspaceRoot);
    } catch {
      return null;
    }
    const entry = manifest?.files.find((file) => file.scope === scope);
    if (!entry?.ownerId) return null;

    let content = "";
    try {
      content = await readFile(join(workspaceRoot, entry.path), "utf8");
    } catch {
      return null;
    }

    const versionId = entry.currentVersionId ?? entry.sourceVersionId;
    return {
      id: entry.documentId ?? `${scope}_${entry.ownerId}`,
      scope,
      ownerId: entry.ownerId,
      currentVersionId: versionId,
      heartbeatEnabled: true,
      versions: versionId
        ? [{
            id: versionId,
            content: content.endsWith("\n") ? content.slice(0, -1) : content,
            changeSummary: "Existing materialized Soul runtime",
            createdAt: entry.materializedAt,
            createdBy: "system",
            source: "system",
            baseVersionId: null,
            restoreSourceVersionId: null,
          }]
        : [],
    };
  }

  async function materializeSoulForWorkspace(
    dataDir: string,
    ctx: RequestContext,
    workspace: WorkspaceInfo,
    overrides: Partial<Record<SoulScope, SoulDocument | null>> = {},
    options: { workspaceActive?: boolean } = {},
  ): Promise<SoulMaterializationResult> {
    return withSoulMaterializationLock(workspace.id, async () => {
      const den = soulDenContext(ctx);
      const hasOverride = (scope: SoulScope) => Object.prototype.hasOwnProperty.call(overrides, scope);
      const organization = hasOverride("organization")
        ? overrides.organization ?? null
        : await readCachedSoulForMaterialization(dataDir, "organization", den.orgId, workspace.path);
      const user = hasOverride("user")
        ? overrides.user ?? null
        : await readCachedSoulForMaterialization(dataDir, "user", den.userId, workspace.path);
      const workspaceDocument = hasOverride("workspace")
        ? overrides.workspace ?? null
        : await readCachedSoulForMaterialization(dataDir, "workspace", workspace.id, workspace.path);

      await materializationTestHookForTests?.({ workspaceId: workspace.id, overrides });

      return materializeEffectiveSoul({
        workspaceRoot: workspace.path,
        organization,
        user,
        workspace: workspaceDocument,
        workspaceActive: options.workspaceActive,
      });
    });
  }

  async function materializeSoulForConfiguredWorkspaces(
    dataDir: string,
    config: ServerConfig,
    ctx: RequestContext,
    overrides: Partial<Record<SoulScope, SoulDocument | null>>,
    options: { activeWorkspaceIds?: Set<string> } = {},
  ): Promise<{
    ok: boolean;
    pending: boolean;
    manualSyncRequired: false;
    workspaces: Array<{ workspaceId: string; result: SoulMaterializationResult }>;
  }> {
    const workspaces = [];
    for (const configuredWorkspace of config.workspaces) {
      const workspace = await resolveWorkspace(config, configuredWorkspace.id);
      const result = await materializeSoulForWorkspace(dataDir, ctx, workspace, overrides, {
        workspaceActive: options.activeWorkspaceIds?.has(workspace.id) === true,
      });
      workspaces.push({ workspaceId: workspace.id, result });
    }
    return {
      ok: workspaces.every((item) => item.result.ok),
      pending: workspaces.some((item) => item.result.pending),
      manualSyncRequired: false,
      workspaces,
    };
  }

  function soulReadPayload(input: {
    document: SoulDocument | null;
    summary: SoulSummary;
    pendingEdits?: SoulPendingEdit[];
    denSynced?: boolean;
    materialization?: unknown;
  }) {
    return {
      document: input.document ?? emptySoulDocument(input.summary.scope, input.summary.ownerId),
      summary: input.summary,
      ...(input.pendingEdits ? { pendingEdits: input.pendingEdits } : {}),
      ...(input.denSynced === undefined ? {} : { denSynced: input.denSynced }),
      ...(input.materialization === undefined ? {} : { materialization: input.materialization }),
    };
  }

  function activeSoulWorkspaceIdsFromBody(body: Record<string, unknown>, config?: ServerConfig): Set<string> {
    const raw = Array.isArray(body.activeWorkspaceIds) ? body.activeWorkspaceIds : [];
    const activeWorkspaceIds = new Set(
      raw
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean),
    );
    if (body.activeRun === true && config) {
      for (const workspace of config.workspaces) {
        const workspaceId = workspace.id?.trim() ?? "";
        if (workspaceId) activeWorkspaceIds.add(workspaceId);
      }
    }
    return activeWorkspaceIds;
  }

  function soulWorkspaceActiveFromBody(body: Record<string, unknown>, workspaceId: string): boolean {
    return body.activeRun === true || activeSoulWorkspaceIdsFromBody(body).has(workspaceId);
  }

  async function buildSoulMaterializationStatus(workspace: WorkspaceInfo): Promise<SoulMaterializationResult | undefined> {
    return readSoulMaterializationStatus(workspace.path);
  }

  async function configuredSoulMaterializationApprovalPaths(
    config: ServerConfig,
    extraPaths: string[],
  ): Promise<string[]> {
    const paths = [...extraPaths];
    for (const configuredWorkspace of config.workspaces) {
      const workspace = await resolveWorkspace(config, configuredWorkspace.id);
      paths.push(...soulRuntimeMaterializationApprovalPaths(workspace.path));
    }
    return uniqueApprovalPaths(paths);
  }

  function globalSoulApprovalWorkspaceId(config: ServerConfig): string {
    return config.workspaces[0]?.id ?? "__soul__";
  }

  async function readOrganizationSoulModel(dataDir: string, ctx: RequestContext): Promise<SoulModel> {
    const den = soulDenContext(ctx);
    const ownerId = den.orgId ?? "organization";
    if (den.baseUrl && den.denToken && den.orgId) {
      try {
        const document = await getOrganizationSoul({ ...den, token: den.denToken });
        await cacheSoulDocument({ dataDir, document });
        return {
          document,
          summary: soulSummary({
            scope: "organization",
            ownerId: document.ownerId,
            document,
            canEdit: soulCanEdit(ctx, "organization"),
          }),
          denSynced: true,
        };
      } catch (error) {
        if (!isSoulDenUnavailable(error)) throw error;
      }
    }

    const cached = den.orgId
      ? await readCachedSoulDocument({ dataDir, scope: "organization", ownerId: den.orgId })
      : null;
    return {
      document: cached,
      summary: soulSummary({
        scope: "organization",
        ownerId,
        document: cached,
        canEdit: soulCanEdit(ctx, "organization"),
      }),
      denSynced: false,
    };
  }

  async function readUserSoulModel(dataDir: string, ctx: RequestContext): Promise<SoulModel> {
    const den = soulDenContext(ctx);
    const ownerId = den.userId ?? "user";
    if (den.baseUrl && den.denToken && den.userId) {
      try {
        const document = await getUserSoul({ ...den, token: den.denToken });
        await cacheSoulDocument({ dataDir, document });
        await clearPendingSoulEdits({ dataDir, scope: "user", ownerId: document.ownerId });
        return {
          document,
          summary: soulSummary({
            scope: "user",
            ownerId: document.ownerId,
            document,
            canEdit: soulCanEdit(ctx, "user"),
          }),
          denSynced: true,
        };
      } catch (error) {
        if (!isSoulDenUnavailable(error)) throw error;
      }
    }

    const cached = den.userId
      ? await readCachedSoulDocument({ dataDir, scope: "user", ownerId: den.userId })
      : null;
    const pendingEdits = den.userId && !cached?.currentVersionId
      ? await readPendingSoulEditsFor(dataDir, "user", den.userId)
      : [];
    return {
      document: cached,
      summary: soulSummary({
        scope: "user",
        ownerId,
        document: cached,
        canEdit: soulCanEdit(ctx, "user"),
        status: pendingEdits.length > 0 ? "pending" : undefined,
      }),
      pendingEdits: pendingEdits.length > 0 ? pendingEdits : undefined,
      denSynced: false,
    };
  }

  async function readWorkspaceSoulModel(
    dataDir: string,
    ctx: RequestContext,
    workspace: WorkspaceInfo,
  ): Promise<SoulModel> {
    const document = await readCachedSoulDocument({
      dataDir,
      scope: "workspace",
      ownerId: workspace.id,
    });
    return {
      document,
      summary: soulSummary({
        scope: "workspace",
        ownerId: workspace.id,
        document,
        canEdit: soulCanEdit(ctx, "workspace"),
        workspace,
      }),
      materialization: await buildSoulMaterializationStatus(workspace),
    };
  }

  return {
    activeSoulWorkspaceIdsFromBody,
    buildSoulMaterializationStatus,
    configuredSoulMaterializationApprovalPaths,
    emptySoulDocument,
    globalSoulApprovalWorkspaceId,
    isSoulDenUnavailable,
    materializeSoulForConfiguredWorkspaces,
    materializeSoulForWorkspace,
    optionalSoulBaseVersionId,
    readCachedSoulVersions,
    readOrganizationSoulModel,
    readUserSoulModel,
    readWorkspaceSoulModel,
    requireSoulDenToken,
    requireSoulOrgId,
    requireSoulText,
    requireSoulUserId,
    setMaterializationTestHookForTests,
    soulActorId,
    soulCanEdit,
    soulDenContext,
    soulReadPayload,
    soulSummary,
    soulVersionId,
    soulVersionResponse,
    soulWorkspaceActiveFromBody,
    validateSoulScopeParam,
  };
}

export type SoulController = ReturnType<typeof createSoulController>;
