import type {
  BlockedWorkspaceSkillInstallation,
  ManagedSkillSource,
  ResolvedWorkspaceSkill,
  WorkspaceSkillConflict,
  WorkspaceSkillMaterialization,
  WorkspaceSkillRegistryInstallation,
  WorkspaceSkillSetLocalUnmanagedSkill,
  WorkspaceSkillSetPolicy,
  WorkspaceSkillSetResolution,
  WorkspaceSkillSetUser,
  WorkspaceSkillSetWorkspace,
} from "./types.js";

export type {
  BlockedWorkspaceSkillInstallation,
  ManagedSkillSource,
  ResolvedWorkspaceSkill,
  WorkspaceSkillConflict,
  WorkspaceSkillMaterialization,
  WorkspaceSkillRegistryInstallation,
  WorkspaceSkillSetLocalUnmanagedSkill,
  WorkspaceSkillSetPolicy,
  WorkspaceSkillSetResolution,
  WorkspaceSkillSetUser,
  WorkspaceSkillSetWorkspace,
} from "./types.js";

export type ResolveWorkspaceSkillSetInput = {
  workspace: WorkspaceSkillSetWorkspace;
  user: WorkspaceSkillSetUser;
  registryInstallations: WorkspaceSkillRegistryInstallation[];
  localUnmanagedSkills: WorkspaceSkillSetLocalUnmanagedSkill[];
  policy?: WorkspaceSkillSetPolicy;
};

const normalize = (value: string | null | undefined) => String(value ?? "").trim();

const isApprovedRequired = (source: ManagedSkillSource) => source === "organization" || source === "platform" || source === "workspace";

const materializationTargetForSource = (source: ManagedSkillSource): WorkspaceSkillMaterialization["target"] =>
  source === "personal" ? "personal-global" : "workspace";

const blockedInstallation = (
  installation: WorkspaceSkillRegistryInstallation,
  reason: BlockedWorkspaceSkillInstallation["reason"],
): BlockedWorkspaceSkillInstallation => ({
  installationId: installation.installationId,
  skillId: installation.skillId,
  name: installation.name,
  reason,
});

function isInstallationInScope(
  installation: WorkspaceSkillRegistryInstallation,
  workspace: WorkspaceSkillSetWorkspace,
  user: WorkspaceSkillSetUser,
  policy: WorkspaceSkillSetPolicy,
): boolean {
  if (installation.source === "personal") {
    if (installation.ownerUserId && installation.ownerUserId !== user.id) return false;
    if (workspace.scope === "organization" && policy.allowPersonalGlobalInOrgWorkspace === false) return false;
    return true;
  }

  if (installation.source === "workspace") {
    if (installation.workspaceId && installation.workspaceId !== workspace.id) return false;
    if (workspace.scope === "organization" && installation.orgId && installation.orgId !== workspace.orgId) return false;
    return true;
  }

  if (installation.source === "organization") {
    return workspace.scope === "organization" && Boolean(workspace.orgId) && installation.orgId === workspace.orgId;
  }

  return installation.source === "platform";
}

const resolveVersion = (installation: WorkspaceSkillRegistryInstallation) => ({
  versionId: normalize(installation.desiredVersionId) || installation.versionId,
  packageSha256: normalize(installation.desiredPackageSha256) || installation.packageSha256,
});

const toResolvedSkill = (installation: WorkspaceSkillRegistryInstallation): ResolvedWorkspaceSkill => {
  const resolved = resolveVersion(installation);
  return {
    installationId: installation.installationId,
    skillId: installation.skillId,
    name: installation.name,
    versionId: resolved.versionId,
    packageSha256: resolved.packageSha256,
    source: installation.source,
    target: materializationTargetForSource(installation.source),
  };
};

const toMaterialization = (skill: ResolvedWorkspaceSkill): WorkspaceSkillMaterialization => ({
  installationId: skill.installationId,
  skillId: skill.skillId,
  name: skill.name,
  versionId: skill.versionId,
  packageSha256: skill.packageSha256,
  target: skill.target,
});

export function resolveWorkspaceSkillSet(input: ResolveWorkspaceSkillSetInput): WorkspaceSkillSetResolution {
  const policy = input.policy ?? {};
  const effectiveManagedSkills: ResolvedWorkspaceSkill[] = [];
  const blockedInstallations: BlockedWorkspaceSkillInstallation[] = [];
  const conflicts: WorkspaceSkillConflict[] = [];
  const managedByName = new Map<string, ResolvedWorkspaceSkill>();

  for (const installation of input.registryInstallations) {
    const name = normalize(installation.name);
    if (!name) {
      blockedInstallations.push(blockedInstallation(installation, "out-of-scope"));
      continue;
    }

    if (!installation.enabled) {
      blockedInstallations.push(blockedInstallation(installation, "disabled"));
      continue;
    }

    if (!isInstallationInScope(installation, input.workspace, input.user, policy)) {
      blockedInstallations.push(blockedInstallation(installation, "out-of-scope"));
      continue;
    }

    if (isApprovedRequired(installation.source) && installation.approved !== true) {
      blockedInstallations.push(blockedInstallation(installation, "not-approved"));
      continue;
    }

    const existing = managedByName.get(name);
    if (
      input.workspace.scope === "organization" &&
      installation.source === "personal" &&
      existing &&
      existing.source !== "personal" &&
      policy.allowPersonalGlobalShadowOrgManaged !== true
    ) {
      blockedInstallations.push(blockedInstallation(installation, "shadowed"));
      conflicts.push({
        code: "personal-global-shadowed",
        name,
        blockingInstallationId: existing.installationId,
        blockedInstallationId: installation.installationId,
        message: `Personal global skill ${name} cannot shadow organization-managed skill ${existing.name}.`,
      });
      continue;
    }

    const resolved = toResolvedSkill({ ...installation, name });
    effectiveManagedSkills.push(resolved);
    if (!managedByName.has(name) || resolved.source !== "personal") {
      managedByName.set(name, resolved);
    }
  }

  for (const unmanaged of input.localUnmanagedSkills) {
    const name = normalize(unmanaged.name);
    const managed = managedByName.get(name);
    if (!managed) continue;
    conflicts.push({
      code: "unmanaged-local-shadowed",
      name,
      blockingInstallationId: managed.installationId,
      localPath: unmanaged.path,
      message: `Unmanaged local skill ${name} conflicts with managed skill ${managed.name}.`,
    });
  }

  const requiredMaterializations = effectiveManagedSkills.map(toMaterialization);
  return {
    effectiveManagedSkills,
    requiredMaterializations,
    conflicts,
    blockedInstallations,
    reloadRequired: requiredMaterializations.length > 0 || conflicts.length > 0,
  };
}
