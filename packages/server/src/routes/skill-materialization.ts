import { createHash } from "node:crypto";

import { recordAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import { getPlatformManagedPersonalGlobalSkillSet } from "../platform-managed-skills.js";
import {
  readSkillRegistryRequestInput as skillRegistryRequestInput,
  skillRegistryConfiguredBaseUrl,
  skillRegistryRequestBaseUrl,
  type SkillRegistryRequestInput,
} from "../request-headers.js";
import {
  emitReloadEvent,
  ensureWritable,
  jsonResponse,
  readOptionalJsonBody,
  requireApproval,
  requireClientScope,
  resolveWorkspace,
} from "../route-helpers.js";
import { addRoute, type RequestContext, type Route } from "../routing.js";
import {
  downloadSkillPackageFromRegistry,
  getWorkspaceSkillSetFromRegistry,
  listRegistrySkillInstallations,
  listRegistrySkillRolloutPolicies,
} from "../skill-registry-client.js";
import type { RegistrySkillRolloutPolicy } from "../skill-registry-types.js";
import {
  materializePersonalGlobalSkillSet,
  materializeWorkspaceSkillSet,
  readSkillMaterializationManifest,
  type SkillSetMaterializationResult,
} from "../skill-materializer.js";
import type { SkillPackageArchive } from "../skill-packages.js";
import {
  personalGlobalManagedSkillsRoot,
  userGlobalSkillRootsForMutation,
  workspaceManagedSkillsRoot,
} from "../skill-roots.js";
import type {
  ServerConfig,
  WorkspaceInfo,
  WorkspaceSkillConflict,
  WorkspaceSkillMaterialization,
} from "../types.js";
import {
  materializeUserGlobalSkillsForWorkspace,
  userGlobalMaterializedSkillsRoot,
} from "../user-skill-store.js";
import { shortId } from "../utils.js";
import { writeWorkspaceSkillLockfile } from "../workspace-skill-lockfile.js";
import {
  resolveWorkspaceSkillSet,
  type WorkspaceSkillRegistryInstallation,
  type WorkspaceSkillRolloutPolicy,
} from "../workspace-skill-set.js";

export type SkillMaterializationRouteDependencies = {
  serverDataDir: string;
};

type WorkspaceSkillMaterializationStatusOptions = {
  registryConfigured?: boolean;
  workspaceRegistryConfigured?: boolean;
  status?: string;
  reloadRequired?: boolean;
  registryError?: ApiError;
};

function requireRouteParam(params: Record<string, string>, field: string, label = field): string {
  const value = params[field]?.trim() ?? "";
  if (!value) {
    throw new ApiError(400, "invalid_payload", `${label} is required`);
  }
  return value;
}

function skillRegistryBaseUrl(config: ServerConfig): string {
  return skillRegistryConfiguredBaseUrl(config);
}

function registryIdentityPayload(input: Pick<SkillRegistryRequestInput, "orgId" | "userId">): {
  orgId?: string;
  userId?: string;
} {
  return {
    ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
  };
}

function materializationEntryPayload(entry: WorkspaceSkillMaterialization & {
  skillDir?: string;
  materializedAt?: string;
}) {
  return {
    installationId: entry.installationId,
    skillId: entry.skillId,
    name: entry.name,
    versionId: entry.versionId,
    packageSha256: entry.packageSha256,
    source: entry.source,
    target: entry.target,
    removalPolicy: entry.removalPolicy,
    ...(entry.skillDir ? { skillDir: entry.skillDir } : {}),
    ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {}),
  };
}

function materializationSummaryPayload(entry: WorkspaceSkillMaterialization) {
  return {
    installationId: entry.installationId,
    skillId: entry.skillId,
    name: entry.name,
    versionId: entry.versionId,
    packageSha256: entry.packageSha256,
    source: entry.source,
    target: entry.target,
    removalPolicy: entry.removalPolicy,
  };
}

function skillRegistryErrorPayload(error: ApiError) {
  const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : {};
  const registryAction = typeof details.registryAction === "string" ? details.registryAction : undefined;
  const registryResource = typeof details.registryResource === "string" ? details.registryResource : undefined;
  const registryScope = typeof details.registryScope === "string" ? details.registryScope : undefined;
  return {
    code: error.code,
    message: error.message,
    status: error.status,
    ...(registryAction ? { registryAction } : {}),
    ...(registryResource ? { registryResource } : {}),
    ...(registryScope ? { registryScope } : {}),
  };
}

const materializationMatchesDesired = (
  entry: WorkspaceSkillMaterialization,
  desired: WorkspaceSkillMaterialization,
): boolean =>
  entry.installationId === desired.installationId &&
  entry.skillId === desired.skillId &&
  entry.name === desired.name &&
  entry.versionId === desired.versionId &&
  entry.packageSha256 === desired.packageSha256 &&
  entry.source === desired.source &&
  entry.removalPolicy === desired.removalPolicy &&
  entry.target === desired.target;

async function buildWorkspaceSkillMaterializationStatus(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  options: WorkspaceSkillMaterializationStatusOptions = {},
) {
  const rootDir = workspaceManagedSkillsRoot(workspace.path);
  const manifest = await readSkillMaterializationManifest(rootDir);
  const registryConfigured = options.registryConfigured ?? Boolean(skillRegistryBaseUrl(config));
  const workspaceRegistryConfigured = options.workspaceRegistryConfigured ?? registryConfigured;
  const reloadRequired = options.reloadRequired ?? (registryConfigured && workspaceRegistryConfigured);
  return {
    workspaceId: workspace.id,
    status: options.status ?? (reloadRequired ? "pending" : "not-configured"),
    registryConfigured,
    workspaceRegistryConfigured,
    rootDir,
    materializedSkills: manifest?.entries.map(materializationEntryPayload) ?? [],
    reloadRequired,
    ...(options.registryError ? { registryError: skillRegistryErrorPayload(options.registryError) } : {}),
  };
}

async function buildWorkspaceSkillRegistryUnavailableStatus(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  error: ApiError,
) {
  const base = await buildWorkspaceSkillMaterializationStatus(config, workspace, {
    workspaceRegistryConfigured: false,
    status: "degraded",
    reloadRequired: false,
    registryError: error,
  });
  return {
    ...base,
    synced: false,
    conflicts: [],
  };
}

function isWorkspaceSkillRegistryNotFound(error: unknown): error is ApiError {
  if (!(error instanceof ApiError) || error.status !== 404 || error.code !== "skill_registry_not_found") {
    return false;
  }
  const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : {};
  return details.registryResource === undefined || details.registryResource === "workspace-skill-set";
}

function isSkillRegistryApiError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code.startsWith("skill_registry_");
}

async function buildWorkspaceSkillMaterializationStatusForRequest(ctx: RequestContext, workspace: WorkspaceInfo) {
  const baseUrl = skillRegistryRequestBaseUrl(ctx);
  const registryConfigured = Boolean(baseUrl);
  if (!registryConfigured) {
    return buildWorkspaceSkillMaterializationStatus(ctx.config, workspace, {
      registryConfigured: false,
      workspaceRegistryConfigured: false,
      status: "not-configured",
      reloadRequired: false,
    });
  }

  try {
    await getWorkspaceSkillSetFromRegistry({
      ...skillRegistryRequestInput(ctx),
      workspaceId: workspace.id,
    });
    return buildWorkspaceSkillMaterializationStatus(ctx.config, workspace, {
      registryConfigured: true,
      workspaceRegistryConfigured: true,
      status: "pending",
      reloadRequired: true,
    });
  } catch (error) {
    if (isWorkspaceSkillRegistryNotFound(error)) {
      return buildWorkspaceSkillMaterializationStatus(ctx.config, workspace, {
        registryConfigured: true,
        workspaceRegistryConfigured: false,
        status: "not-configured",
        reloadRequired: false,
        registryError: error,
      });
    }
    if (isSkillRegistryApiError(error)) {
      return buildWorkspaceSkillMaterializationStatus(ctx.config, workspace, {
        registryConfigured: true,
        status: "degraded",
        reloadRequired: false,
        registryError: error,
      });
    }
    throw error;
  }
}

async function buildGlobalSkillMaterializationStatus(config: ServerConfig) {
  const rootDir = personalGlobalManagedSkillsRoot();
  const manifest = await readSkillMaterializationManifest(rootDir);
  const registryConfigured = Boolean(skillRegistryBaseUrl(config));
  const platformSkillSet = await getPlatformManagedPersonalGlobalSkillSet();
  const platformSynced = platformSkillSet.skills.every((skill) =>
    manifest?.entries.some((entry) => materializationMatchesDesired(entry, skill)) ?? false
  );
  const platformPending = platformSkillSet.skills.length > 0 && !platformSynced;
  return {
    scope: "personal-global",
    status: registryConfigured || platformPending ? "pending" : "synced",
    registryConfigured,
    rootDir,
    materializedSkills: manifest?.entries.map(materializationEntryPayload) ?? [],
    platformManaged: {
      enabled: platformSkillSet.skills.length > 0,
      synced: platformSynced,
      desiredSkills: platformSkillSet.skills.map(materializationSummaryPayload),
    },
    reloadRequired: registryConfigured || platformPending,
  };
}

function desiredSkillSetRevision(materializations: WorkspaceSkillMaterialization[]) {
  const payload = materializations
    .map((entry) => ({
      installationId: entry.installationId,
      skillId: entry.skillId,
      name: entry.name,
      versionId: entry.versionId,
      packageSha256: entry.packageSha256,
      source: entry.source,
      target: entry.target,
      removalPolicy: entry.removalPolicy,
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.installationId.localeCompare(right.installationId));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function registryInstallationToWorkspaceInstallation(input: {
  installation: Awaited<ReturnType<typeof getWorkspaceSkillSetFromRegistry>>["skills"][number];
  workspace: WorkspaceInfo;
  packageResponse: { versionId: string; package: SkillPackageArchive };
  orgId?: string;
  userId?: string;
}): WorkspaceSkillRegistryInstallation {
  const { installation, workspace, packageResponse, orgId, userId } = input;
  const ownerUserId = installation.ownerUserId ?? (installation.source === "personal" ? userId : undefined);
  const installationOrgId = installation.orgId ?? (installation.source === "organization" ? orgId : undefined);
  const workspaceId = installation.workspaceId ?? (installation.source === "workspace" ? workspace.id : undefined);
  const approved = installation.approved ?? (installation.source === "personal" ? undefined : true);
  return {
    installationId: installation.installationId,
    skillId: installation.skillId,
    name: installation.name?.trim() || packageResponse.package.metadata.name,
    versionId: packageResponse.versionId,
    packageSha256: installation.desiredPackageSha256?.trim() || installation.packageSha256?.trim() || packageResponse.package.packageSha256,
    enabled: installation.enabled,
    source: installation.source,
    installedAt: installation.installedAt,
    ...(ownerUserId !== undefined ? { ownerUserId } : {}),
    ...(installationOrgId !== undefined ? { orgId: installationOrgId } : {}),
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(approved !== undefined ? { approved } : {}),
    desiredVersionId: installation.desiredVersionId ?? null,
    desiredPackageSha256: installation.desiredPackageSha256 ?? null,
  };
}

function requireRolloutPolicyVersionId(policy: RegistrySkillRolloutPolicy): string {
  const versionId = policy.versionId?.trim();
  if (versionId) return versionId;
  throw new ApiError(
    409,
    "skill_rollout_version_unresolved",
    "Skill rollout policy must resolve to a concrete package version before materialization",
    { policyId: policy.id, skillId: policy.skillId },
  );
}

function registryRolloutPolicyToWorkspacePolicy(input: {
  policy: RegistrySkillRolloutPolicy;
  packageResponse: { versionId: string; package: SkillPackageArchive };
  orgId?: string;
}): WorkspaceSkillRolloutPolicy {
  const { policy, packageResponse, orgId } = input;
  const policyOrgId = policy.orgId ?? (policy.catalogScope === "organization" ? orgId : undefined);
  return {
    id: policy.id,
    skillId: policy.skillId,
    name: packageResponse.package.metadata.name,
    versionId: packageResponse.versionId,
    packageSha256: packageResponse.package.packageSha256,
    enabled: policy.enabled,
    source: policy.catalogScope === "organization" ? "organization" : "platform",
    target: policy.target === "user-global" ? "personal-global" : "workspace",
    audience: policy.audience,
    ...(policyOrgId !== undefined ? { orgId: policyOrgId } : {}),
    ...(policy.userId !== undefined ? { userId: policy.userId } : {}),
    ...(policy.workspaceId !== undefined ? { workspaceId: policy.workspaceId } : {}),
    removalPolicy: policy.removalPolicy,
    updatePolicy: policy.updatePolicy,
    releaseChannel: policy.releaseChannel ?? null,
  };
}

function registryRolloutPolicyAppliesToMaterialization(input: {
  policy: RegistrySkillRolloutPolicy;
  userId?: string;
  orgId?: string;
  workspaceId?: string;
}): boolean {
  const { policy, userId, orgId, workspaceId } = input;
  if (!policy.enabled) return false;
  if (policy.catalogScope === "organization" && (!orgId || policy.orgId !== orgId)) return false;

  if (policy.target === "workspace") {
    return policy.audience === "selected-workspaces" && Boolean(workspaceId && policy.workspaceId === workspaceId);
  }

  if (policy.audience === "user") {
    return Boolean(userId && policy.userId === userId);
  }
  if (policy.audience === "all-org-users") {
    return Boolean(orgId && policy.orgId === orgId);
  }
  return policy.audience === "all-platform-users";
}

function assertNoPlatformManagedPersonalGlobalNameConflicts(input: {
  materializations: WorkspaceSkillMaterialization[];
  platformSkills: WorkspaceSkillMaterialization[];
}) {
  const platformNames = new Set(input.platformSkills.map((skill) => skill.name));
  const duplicate = input.materializations.find((skill) =>
    skill.target === "personal-global" && platformNames.has(skill.name)
  );
  if (!duplicate) return;
  throw new ApiError(
    409,
    "managed_skill_name_conflict",
    `Platform-managed skill ${duplicate.name} conflicts with registry-managed personal-global skill ${duplicate.installationId}`,
    { name: duplicate.name, installationId: duplicate.installationId },
  );
}

async function fetchRegistryWorkspaceMaterializations(
  ctx: RequestContext,
  workspace: WorkspaceInfo,
): Promise<{
  materializations: WorkspaceSkillMaterialization[];
  conflicts: WorkspaceSkillConflict[];
  packagesByInstallationId: Map<string, SkillPackageArchive>;
  personalGlobalSyncRequired: boolean;
  skillSetId: string;
  skillSetRevision: string;
}> {
  const baseUrl = skillRegistryRequestBaseUrl(ctx);
  if (!baseUrl) {
    throw new ApiError(503, "skill_registry_misconfigured", "Skill registry base URL is missing");
  }

  const registryInput = skillRegistryRequestInput(ctx);
  const platformSkillSet = await getPlatformManagedPersonalGlobalSkillSet();
  const skillSet = await getWorkspaceSkillSetFromRegistry({
    ...registryInput,
    workspaceId: workspace.id,
  });

  const registryInstallations: WorkspaceSkillRegistryInstallation[] = [];
  const rolloutPolicies: WorkspaceSkillRolloutPolicy[] = [];
  const packagesByInstallationId = new Map<string, SkillPackageArchive>();
  for (const [installationId, archive] of platformSkillSet.archivesByInstallationId) {
    packagesByInstallationId.set(installationId, archive);
  }
  const seenInstallationIds = new Set<string>();
  const personalGlobalWorkspace: WorkspaceInfo = {
    id: "personal-global",
    name: "Personal global skills",
    path: personalGlobalManagedSkillsRoot(),
    workspaceType: "local",
  };
  let personalGlobalSyncRequired = false;
  const addRegistryInstallation = async (
    installation: typeof skillSet.skills[number],
    targetWorkspace: WorkspaceInfo,
  ) => {
    if (!installation.enabled) return;
    if (seenInstallationIds.has(installation.installationId)) return;
    seenInstallationIds.add(installation.installationId);
    const versionId = installation.desiredVersionId?.trim() || installation.versionId;
    const packageResponse = await downloadSkillPackageFromRegistry({
      ...registryInput,
      versionId,
    });
    const workspaceInstallation = registryInstallationToWorkspaceInstallation({
      installation,
      workspace: targetWorkspace,
      packageResponse,
      ...registryIdentityPayload(registryInput),
    });
    registryInstallations.push(workspaceInstallation);
    packagesByInstallationId.set(workspaceInstallation.installationId, packageResponse.package);
  };

  for (const installation of skillSet.skills) {
    await addRegistryInstallation(installation, workspace);
  }

  const personalGlobalInstallations = await listRegistrySkillInstallations({
    ...registryInput,
    source: "personal",
    target: "personal-global",
  });
  if (personalGlobalInstallations.installations.length > 0) {
    personalGlobalSyncRequired = true;
  }
  for (const installation of personalGlobalInstallations.installations) {
    await addRegistryInstallation(installation, personalGlobalWorkspace);
  }

  for (const query of [
    { target: "workspace" as const, workspaceId: workspace.id },
    { target: "user-global" as const },
  ]) {
    const rolloutPoliciesResponse = await listRegistrySkillRolloutPolicies({
      ...registryInput,
      ...query,
      enabled: true,
    });
    for (const policy of rolloutPoliciesResponse.policies) {
      if (!registryRolloutPolicyAppliesToMaterialization({
        policy,
        workspaceId: workspace.id,
        ...registryIdentityPayload(registryInput),
      })) {
        continue;
      }
      if (policy.target === "user-global") {
        personalGlobalSyncRequired = true;
      }
      const packageResponse = await downloadSkillPackageFromRegistry({
        ...registryInput,
        versionId: requireRolloutPolicyVersionId(policy),
      });
      const workspacePolicy = registryRolloutPolicyToWorkspacePolicy({
        policy,
        packageResponse,
        ...(registryInput.orgId !== undefined ? { orgId: registryInput.orgId } : {}),
      });
      rolloutPolicies.push(workspacePolicy);
      packagesByInstallationId.set(`rollout:${workspacePolicy.id}`, packageResponse.package);
    }
  }

  const resolution = resolveWorkspaceSkillSet({
    workspace: {
      id: workspace.id,
      scope: registryInput.orgId ? "organization" : "personal",
      ...(registryInput.orgId !== undefined ? { orgId: registryInput.orgId } : {}),
    },
    user: {
      id: registryInput.userId ?? "local-user",
      ...(registryInput.orgId !== undefined ? { orgId: registryInput.orgId } : {}),
    },
    registryInstallations,
    rolloutPolicies,
    localUnmanagedSkills: [],
    policy: {},
  });
  assertNoPlatformManagedPersonalGlobalNameConflicts({
    materializations: resolution.requiredMaterializations,
    platformSkills: platformSkillSet.skills,
  });
  const materializations = personalGlobalSyncRequired
    ? [...resolution.requiredMaterializations, ...platformSkillSet.skills]
    : resolution.requiredMaterializations;

  return {
    materializations,
    conflicts: resolution.conflicts,
    packagesByInstallationId,
    personalGlobalSyncRequired,
    skillSetId: skillSet.skillSetId?.trim() || `workspace:${workspace.id}`,
    skillSetRevision: skillSet.revision?.trim() || desiredSkillSetRevision(materializations),
  };
}

async function fetchRegistryPersonalGlobalMaterializations(
  ctx: RequestContext,
): Promise<{
  materializations: WorkspaceSkillMaterialization[];
  conflicts: WorkspaceSkillConflict[];
  packagesByInstallationId: Map<string, SkillPackageArchive>;
}> {
  const baseUrl = skillRegistryRequestBaseUrl(ctx);
  const platformSkillSet = await getPlatformManagedPersonalGlobalSkillSet();
  if (!baseUrl) {
    return {
      materializations: platformSkillSet.skills,
      conflicts: [],
      packagesByInstallationId: platformSkillSet.archivesByInstallationId,
    };
  }

  const registryInput = skillRegistryRequestInput(ctx);
  const installations = await listRegistrySkillInstallations({
    ...registryInput,
    source: "personal",
    target: "personal-global",
  });

  const registryInstallations: WorkspaceSkillRegistryInstallation[] = [];
  const rolloutPolicies: WorkspaceSkillRolloutPolicy[] = [];
  const packagesByInstallationId = new Map<string, SkillPackageArchive>();
  for (const [installationId, archive] of platformSkillSet.archivesByInstallationId) {
    packagesByInstallationId.set(installationId, archive);
  }
  const personalGlobalWorkspace: WorkspaceInfo = {
    id: "personal-global",
    name: "Personal global skills",
    path: personalGlobalManagedSkillsRoot(),
    workspaceType: "local",
  };
  for (const installation of installations.installations) {
    if (!installation.enabled) continue;
    const packageResponse = await downloadSkillPackageFromRegistry({
      ...registryInput,
      versionId: installation.versionId,
    });
    const workspaceInstallation = registryInstallationToWorkspaceInstallation({
      installation,
      workspace: personalGlobalWorkspace,
      packageResponse,
      ...registryIdentityPayload(registryInput),
    });
    registryInstallations.push(workspaceInstallation);
    packagesByInstallationId.set(workspaceInstallation.installationId, packageResponse.package);
  }

  const rolloutPoliciesResponse = await listRegistrySkillRolloutPolicies({
    ...registryInput,
    target: "user-global",
    enabled: true,
  });
  for (const policy of rolloutPoliciesResponse.policies) {
    if (!registryRolloutPolicyAppliesToMaterialization({
      policy,
      ...registryIdentityPayload(registryInput),
    })) {
      continue;
    }
    const packageResponse = await downloadSkillPackageFromRegistry({
      ...registryInput,
      versionId: requireRolloutPolicyVersionId(policy),
    });
    const workspacePolicy = registryRolloutPolicyToWorkspacePolicy({
      policy,
      packageResponse,
      ...(registryInput.orgId !== undefined ? { orgId: registryInput.orgId } : {}),
    });
    rolloutPolicies.push(workspacePolicy);
    packagesByInstallationId.set(`rollout:${workspacePolicy.id}`, packageResponse.package);
  }

  const resolution = resolveWorkspaceSkillSet({
    workspace: {
      id: personalGlobalWorkspace.id,
      scope: registryInput.orgId ? "organization" : "personal",
      ...(registryInput.orgId !== undefined ? { orgId: registryInput.orgId } : {}),
    },
    user: {
      id: registryInput.userId ?? "local-user",
      ...(registryInput.orgId !== undefined ? { orgId: registryInput.orgId } : {}),
    },
    registryInstallations,
    rolloutPolicies,
    localUnmanagedSkills: [],
    policy: {},
  });
  assertNoPlatformManagedPersonalGlobalNameConflicts({
    materializations: resolution.requiredMaterializations,
    platformSkills: platformSkillSet.skills,
  });
  const materializations = [...resolution.requiredMaterializations, ...platformSkillSet.skills];

  return { materializations, conflicts: resolution.conflicts, packagesByInstallationId };
}

export function registerSkillMaterializationRoutes(
  routes: Route[],
  dependencies: SkillMaterializationRouteDependencies,
): void {
  const { serverDataDir } = dependencies;

  addRoute(routes, "GET", "/skills/materialization", "client", async (ctx) => {
    return jsonResponse(await buildGlobalSkillMaterializationStatus(ctx.config));
  });

  addRoute(routes, "POST", "/skills/materialization/sync-global", "host", async (ctx) => {
    ensureWritable(ctx.config);
    const body = await readOptionalJsonBody(ctx.request);
    if (body.activeRun === true) {
      const status = await buildGlobalSkillMaterializationStatus(ctx.config);
      return jsonResponse({
        ...status,
        status: "pending",
        synced: false,
        reloadRequired: true,
        conflicts: [],
      }, 202);
    }

    const { materializations, conflicts, packagesByInstallationId } = await fetchRegistryPersonalGlobalMaterializations(ctx);
    const loadPackage = async (skill: WorkspaceSkillMaterialization) => {
      const archive = packagesByInstallationId.get(skill.installationId);
      if (!archive) {
        throw new ApiError(500, "skill_package_missing", `Missing package for skill ${skill.name}`);
      }
      return archive;
    };

    const result = await materializePersonalGlobalSkillSet({
      skills: materializations,
      loadPackage,
      unmanagedSkillRoots: userGlobalSkillRootsForMutation(),
    });

    await recordAudit(result.rootDir, {
      id: shortId(),
      workspaceId: "global",
      actor: ctx.actor ?? { type: "host" },
      action: "skills.materialization.sync-global",
      target: result.rootDir,
      summary: `Synced ${materializations.length} managed global skill materialization(s)`,
      timestamp: Date.now(),
    });
    for (const workspace of ctx.config.workspaces) {
      emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
        type: "skill",
        name: "veslo-managed",
        action: "updated",
        path: result.rootDir,
      });
    }

    return jsonResponse({
      scope: "personal-global",
      status: "synced",
      synced: true,
      reloadRequired: true,
      registryConfigured: Boolean(skillRegistryBaseUrl(ctx.config)),
      rootDir: result.rootDir,
      materializedSkills: materializations.map(materializationSummaryPayload),
      conflicts,
      removedSkillNames: result.removedSkillNames,
      backupDirs: result.backupDirs,
    });
  });

  addRoute(routes, "GET", "/workspace/:id/skills/materialization", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, requireRouteParam(ctx.params, "id", "workspace id"));
    return jsonResponse(await buildWorkspaceSkillMaterializationStatusForRequest(ctx, workspace));
  });

  addRoute(routes, "POST", "/workspace/:id/skills/user-global-store/sync", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(ctx.config, requireRouteParam(ctx.params, "id", "workspace id"));
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.user_global_store.sync",
      summary: "Sync user-global skills into workspace runtime",
      paths: [userGlobalMaterializedSkillsRoot(workspace.path)],
    });

    const result = await materializeUserGlobalSkillsForWorkspace({
      workspaceRoot: workspace.path,
      workspaceId: workspace.id,
      dataDir: serverDataDir,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.user_global_store.sync",
      target: result.rootDir,
      summary: `Synced ${result.materializedSkills.length} user-global skill(s) into workspace runtime`,
      timestamp: Date.now(),
    });

    if (result.reloadRequired) {
      emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
        type: "skill",
        name: "veslo-user",
        action: "updated",
        path: result.rootDir,
      });
    }

    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/skills/materialization/sync", "host", async (ctx) => {
    ensureWritable(ctx.config);
    const workspace = await resolveWorkspace(ctx.config, requireRouteParam(ctx.params, "id", "workspace id"));
    const body = await readOptionalJsonBody(ctx.request);
    if (body.activeRun === true) {
      const registryConfigured = Boolean(skillRegistryRequestBaseUrl(ctx));
      const status = await buildWorkspaceSkillMaterializationStatus(ctx.config, workspace, {
        registryConfigured,
        workspaceRegistryConfigured: registryConfigured,
        reloadRequired: registryConfigured,
      });
      return jsonResponse({
        ...status,
        status: registryConfigured ? "pending" : status.status,
        synced: false,
        reloadRequired: registryConfigured,
        conflicts: [],
      }, registryConfigured ? 202 : 200);
    }

    let materializationInput: Awaited<ReturnType<typeof fetchRegistryWorkspaceMaterializations>>;
    try {
      materializationInput = await fetchRegistryWorkspaceMaterializations(ctx, workspace);
    } catch (error) {
      if (isWorkspaceSkillRegistryNotFound(error)) {
        return jsonResponse(await buildWorkspaceSkillRegistryUnavailableStatus(ctx.config, workspace, error));
      }
      throw error;
    }
    const {
      materializations,
      conflicts,
      packagesByInstallationId,
      personalGlobalSyncRequired,
      skillSetId,
      skillSetRevision,
    } = materializationInput;
    const workspaceMaterializations = materializations.filter((skill) => skill.target === "workspace");
    const personalGlobalMaterializations = materializations.filter((skill) => skill.target === "personal-global");
    const loadPackage = async (skill: WorkspaceSkillMaterialization) => {
      const archive = packagesByInstallationId.get(skill.installationId);
      if (!archive) {
        throw new ApiError(500, "skill_package_missing", `Missing package for skill ${skill.name}`);
      }
      return archive;
    };

    const workspaceResult = await materializeWorkspaceSkillSet({
      workspaceRoot: workspace.path,
      skills: workspaceMaterializations,
      loadPackage,
    });
    let personalGlobalResult: SkillSetMaterializationResult = {
      rootDir: personalGlobalManagedSkillsRoot(),
      materializedSkills: [],
      removedSkillNames: [],
      backupDirs: [],
    };
    if (personalGlobalSyncRequired) {
      personalGlobalResult = await materializePersonalGlobalSkillSet({
        skills: personalGlobalMaterializations,
        loadPackage,
        unmanagedSkillRoots: userGlobalSkillRootsForMutation(),
      });
    }
    const responseMaterializations = [
      ...workspaceMaterializations,
      ...personalGlobalMaterializations,
    ];
    const lockfileEntries = workspaceMaterializations.map((skill) => ({
      skillId: skill.skillId,
      installationId: skill.installationId,
      versionId: skill.versionId,
      name: skill.name,
      packageSha256: skill.packageSha256,
    }));
    const lockfilePath = await writeWorkspaceSkillLockfile(workspace.path, {
      schemaVersion: 1,
      workspaceId: workspace.id,
      skillSetId,
      skillSetRevision,
      entries: lockfileEntries,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "skills.materialization.sync",
      target: workspaceResult.rootDir,
      summary: `Synced ${responseMaterializations.length} managed skill materialization(s)`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name: "veslo-managed",
      action: "updated",
      path: workspaceResult.rootDir,
    });

    return jsonResponse({
      workspaceId: workspace.id,
      status: "synced",
      synced: true,
      reloadRequired: true,
      registryConfigured: true,
      rootDir: workspaceResult.rootDir,
      globalRootDir: personalGlobalResult.rootDir,
      lockfilePath,
      materializedSkills: responseMaterializations.map(materializationSummaryPayload),
      conflicts,
      removedSkillNames: [
        ...workspaceResult.removedSkillNames,
        ...personalGlobalResult.removedSkillNames,
      ].sort(),
      backupDirs: [
        ...workspaceResult.backupDirs,
        ...personalGlobalResult.backupDirs,
      ],
    });
  });
}
