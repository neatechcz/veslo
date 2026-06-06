import type {
  BlockedWorkspaceSkillInstallation,
  ManagedSkillSource,
  ResolvedWorkspaceSkill,
  WorkspaceSkillConflict,
  WorkspaceSkillMaterialization,
  WorkspaceSkillRegistryInstallation,
  WorkspaceSkillRolloutPolicy,
  WorkspaceSkillRolloutRemovalPolicy,
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
  WorkspaceSkillRolloutPolicy,
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
  rolloutPolicies?: WorkspaceSkillRolloutPolicy[];
  localUnmanagedSkills: WorkspaceSkillSetLocalUnmanagedSkill[];
  policy?: WorkspaceSkillSetPolicy;
};

type ManagedCandidate = ResolvedWorkspaceSkill & {
  removalPolicy: WorkspaceSkillRolloutRemovalPolicy;
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
    removalPolicy: "user_removable",
  };
};

const toCandidateFromInstallation = (installation: WorkspaceSkillRegistryInstallation): ManagedCandidate => ({
  ...toResolvedSkill(installation),
  removalPolicy: "user_removable",
});

const toCandidateFromRollout = (policy: WorkspaceSkillRolloutPolicy): ManagedCandidate => ({
  installationId: `rollout:${policy.id}`,
  skillId: policy.skillId,
  name: policy.name,
  versionId: policy.versionId,
  packageSha256: policy.packageSha256,
  source: policy.source,
  target: policy.target,
  removalPolicy: policy.removalPolicy,
});

const toMaterialization = (skill: ManagedCandidate): WorkspaceSkillMaterialization => ({
  installationId: skill.installationId,
  skillId: skill.skillId,
  name: skill.name,
  versionId: skill.versionId,
  packageSha256: skill.packageSha256,
  source: skill.source,
  target: skill.target,
  removalPolicy: skill.removalPolicy,
});

function isRolloutInScope(
  policy: WorkspaceSkillRolloutPolicy,
  workspace: WorkspaceSkillSetWorkspace,
  user: WorkspaceSkillSetUser,
): boolean {
  if (!policy.enabled) return false;
  if (policy.source === "organization" && (!workspace.orgId || policy.orgId !== workspace.orgId)) return false;

  if (policy.target === "workspace") {
    return policy.audience === "selected-workspaces" && policy.workspaceId === workspace.id;
  }

  if (policy.audience === "user") {
    return policy.userId === user.id;
  }
  if (policy.audience === "all-org-users") {
    return Boolean(user.orgId && policy.orgId === user.orgId);
  }
  return policy.audience === "all-platform-users";
}

function targetConflictPriority(skill: ManagedCandidate): number {
  const removalPriority = skill.removalPolicy === "locked" ? 300 : skill.removalPolicy === "admin_removable" ? 200 : 0;
  const targetPriority = skill.target === "workspace" ? 100 : 0;
  return removalPriority + targetPriority;
}

function resolveTargetConflicts(
  candidates: ManagedCandidate[],
  conflicts: WorkspaceSkillConflict[],
): ManagedCandidate[] {
  const bySkill = new Map<string, ManagedCandidate[]>();
  for (const candidate of candidates) {
    const existing = bySkill.get(candidate.skillId) ?? [];
    existing.push(candidate);
    bySkill.set(candidate.skillId, existing);
  }

  const resolved: ManagedCandidate[] = [];
  for (const group of bySkill.values()) {
    const targets = new Set(group.map((candidate) => candidate.target));
    if (targets.size < 2) {
      resolved.push(...group);
      continue;
    }

    const ordered = [...group].sort((left, right) => targetConflictPriority(right) - targetConflictPriority(left));
    const winner = ordered[0];
    resolved.push(winner);
    for (const loser of ordered.slice(1)) {
      conflicts.push({
        code: "target-conflict",
        name: loser.name,
        blockingInstallationId: winner.installationId,
        blockedInstallationId: loser.installationId,
        message: `Skill ${loser.name} cannot be active as both user-global and workspace targets.`,
      });
    }
  }
  return resolved;
}

export function resolveWorkspaceSkillSet(input: ResolveWorkspaceSkillSetInput): WorkspaceSkillSetResolution {
  const policy = input.policy ?? {};
  const effectiveManagedSkillCandidates: ManagedCandidate[] = [];
  const blockedInstallations: BlockedWorkspaceSkillInstallation[] = [];
  const conflicts: WorkspaceSkillConflict[] = [];
  const orgManagedNames = new Map<string, Pick<WorkspaceSkillRegistryInstallation, "installationId" | "name">>();

  for (const installation of input.registryInstallations) {
    const name = normalize(installation.name);
    if (!name || installation.source === "personal") continue;
    if (!installation.enabled) continue;
    if (!isInstallationInScope(installation, input.workspace, input.user, policy)) continue;
    if (isApprovedRequired(installation.source) && installation.approved !== true) continue;
    orgManagedNames.set(name, { ...installation, name });
  }
  for (const rolloutPolicy of input.rolloutPolicies ?? []) {
    const name = normalize(rolloutPolicy.name);
    if (!name || rolloutPolicy.target === "personal-global") continue;
    if (!isRolloutInScope(rolloutPolicy, input.workspace, input.user)) continue;
    orgManagedNames.set(name, {
      installationId: `rollout:${rolloutPolicy.id}`,
      name,
    });
  }

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

    const orgManaged = orgManagedNames.get(name);
    if (
      input.workspace.scope === "organization" &&
      installation.source === "personal" &&
      orgManaged &&
      policy.allowPersonalGlobalShadowOrgManaged !== true
    ) {
      blockedInstallations.push(blockedInstallation({ ...installation, name }, "shadowed"));
      conflicts.push({
        code: "personal-global-shadowed",
        name,
        blockingInstallationId: orgManaged.installationId,
        blockedInstallationId: installation.installationId,
        message: `Personal global skill ${name} cannot shadow organization-managed skill ${orgManaged.name}.`,
      });
      continue;
    }

    const existing = effectiveManagedSkillCandidates.find((candidate) => candidate.name === name);
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

    const resolved = toCandidateFromInstallation({ ...installation, name });
    effectiveManagedSkillCandidates.push(resolved);
  }

  for (const rolloutPolicy of input.rolloutPolicies ?? []) {
    const name = normalize(rolloutPolicy.name);
    if (!name || !isRolloutInScope(rolloutPolicy, input.workspace, input.user)) {
      continue;
    }
    effectiveManagedSkillCandidates.push(toCandidateFromRollout({ ...rolloutPolicy, name }));
  }

  const effectiveManagedSkills = resolveTargetConflicts(effectiveManagedSkillCandidates, conflicts);
  const managedByName = new Map<string, ResolvedWorkspaceSkill>();
  for (const skill of effectiveManagedSkills) {
    if (!managedByName.has(skill.name) || skill.source !== "personal") {
      managedByName.set(skill.name, skill);
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
