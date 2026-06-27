import { createHash } from "node:crypto";

import { recordAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import { getPlatformManagedPersonalGlobalSkillSet } from "../platform-managed-skills.js";
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
  personalGlobalManagedSkillsRoot,
  readSkillMaterializationManifest,
  workspaceManagedSkillsRoot,
  type SkillSetMaterializationResult,
} from "../skill-materializer.js";
import type { SkillPackageArchive } from "../skill-packages.js";
import { userGlobalSkillRootsForMutation } from "../skills.js";
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

function skillRegistryBaseUrl(config: ServerConfig): string {
  return config.skillRegistryBaseUrl?.trim() || "";
}

function normalizeSkillRegistryBaseUrl(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password || url.search || url.hash) return "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function skillRegistryRequestBaseUrl(ctx: RequestContext): string {
  return (
    skillRegistryBaseUrl(ctx.config) ||
    normalizeSkillRegistryBaseUrl(ctx.request.headers.get("x-veslo-den-api-base"))
  );
}

function skillRegistryRequestInput(ctx: RequestContext) {
  const userId = ctx.request.headers.get("x-veslo-den-user-id")?.trim() ||
    ctx.request.headers.get("x-veslo-user-id")?.trim() ||
    ctx.request.headers.get("x-veslo-account-id")?.trim() ||
    undefined;
  return {
    baseUrl: skillRegistryRequestBaseUrl(ctx),
    token: ctx.config.skillRegistryToken?.trim() || undefined,
    denToken: ctx.request.headers.get("x-veslo-den-token")?.trim() || undefined,
    orgId: ctx.request.headers.get("x-veslo-den-org-id")?.trim() || undefined,
    userId,
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

async function buildWorkspaceSkillMaterializationStatus(config: ServerConfig, workspace: WorkspaceInfo) {
  const rootDir = workspaceManagedSkillsRoot(workspace.path);
  const manifest = await readSkillMaterializationManifest(rootDir);
  const registryConfigured = Boolean(skillRegistryBaseUrl(config));
  return {
    workspaceId: workspace.id,
    status: registryConfigured ? "pending" : "not-configured",
    registryConfigured,
    rootDir,
    materializedSkills: manifest?.entries.map(materializationEntryPayload) ?? [],
    reloadRequired: registryConfigured,
  };
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
  return {
    installationId: installation.installationId,
    skillId: installation.skillId,
    name: installation.name?.trim() || packageResponse.package.metadata.name,
    versionId: packageResponse.versionId,
    packageSha256: installation.desiredPackageSha256?.trim() || installation.packageSha256?.trim() || packageResponse.package.packageSha256,
    enabled: installation.enabled,
    source: installation.source,
    installedAt: installation.installedAt,
    ownerUserId: installation.ownerUserId ?? (installation.source === "personal" ? userId : undefined),
    orgId: installation.orgId ?? (installation.source === "organization" ? orgId : undefined),
    workspaceId: installation.workspaceId ?? (installation.source === "workspace" ? workspace.id : undefined),
    approved: installation.approved ?? (installation.source === "personal" ? undefined : true),
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
    orgId: policy.orgId ?? (policy.catalogScope === "organization" ? orgId : undefined),
    userId: policy.userId ?? undefined,
    workspaceId: policy.workspaceId ?? undefined,
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
      orgId: registryInput.orgId,
      userId: registryInput.userId,
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
        userId: registryInput.userId,
        orgId: registryInput.orgId,
        workspaceId: workspace.id,
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
        orgId: registryInput.orgId,
      });
      rolloutPolicies.push(workspacePolicy);
      packagesByInstallationId.set(`rollout:${workspacePolicy.id}`, packageResponse.package);
    }
  }

  const resolution = resolveWorkspaceSkillSet({
    workspace: {
      id: workspace.id,
      scope: registryInput.orgId ? "organization" : "personal",
      orgId: registryInput.orgId,
    },
    user: {
      id: registryInput.userId ?? "local-user",
      orgId: registryInput.orgId,
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
      orgId: registryInput.orgId,
      userId: registryInput.userId,
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
      userId: registryInput.userId,
      orgId: registryInput.orgId,
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
      orgId: registryInput.orgId,
    });
    rolloutPolicies.push(workspacePolicy);
    packagesByInstallationId.set(`rollout:${workspacePolicy.id}`, packageResponse.package);
  }

  const resolution = resolveWorkspaceSkillSet({
    workspace: {
      id: personalGlobalWorkspace.id,
      scope: registryInput.orgId ? "organization" : "personal",
      orgId: registryInput.orgId,
    },
    user: {
      id: registryInput.userId ?? "local-user",
      orgId: registryInput.orgId,
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
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    return jsonResponse(await buildWorkspaceSkillMaterializationStatus(ctx.config, workspace));
  });

  addRoute(routes, "POST", "/workspace/:id/skills/user-global-store/sync", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
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
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const body = await readOptionalJsonBody(ctx.request);
    if (body.activeRun === true) {
      const status = await buildWorkspaceSkillMaterializationStatus(ctx.config, workspace);
      return jsonResponse({
        ...status,
        status: "pending",
        synced: false,
        reloadRequired: true,
        conflicts: [],
      }, 202);
    }

    const {
      materializations,
      conflicts,
      packagesByInstallationId,
      personalGlobalSyncRequired,
      skillSetId,
      skillSetRevision,
    } = await fetchRegistryWorkspaceMaterializations(ctx, workspace);
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
