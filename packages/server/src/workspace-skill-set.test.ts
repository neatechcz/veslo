import { describe, expect, test } from "bun:test";

import { resolveWorkspaceSkillSet } from "./workspace-skill-set.js";
import type { WorkspaceSkillRegistryInstallation, WorkspaceSkillRolloutPolicy } from "./workspace-skill-set.js";

const installedAt = "2026-05-26T12:00:00.000Z";

function installation(
  overrides: Partial<WorkspaceSkillRegistryInstallation> & Pick<WorkspaceSkillRegistryInstallation, "name" | "source">,
): WorkspaceSkillRegistryInstallation {
  const name = overrides.name;
  return {
    installationId: overrides.installationId ?? `${overrides.source}_${name}_install`,
    skillId: overrides.skillId ?? `${name}_skill`,
    name,
    versionId: overrides.versionId ?? `${name}_v1`,
    packageSha256:
      overrides.packageSha256 ??
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    enabled: overrides.enabled ?? true,
    source: overrides.source,
    installedAt: overrides.installedAt ?? installedAt,
    ownerUserId: overrides.ownerUserId,
    orgId: overrides.orgId,
    workspaceId: overrides.workspaceId,
    approved: overrides.approved,
    updatePolicy: overrides.updatePolicy,
    releaseChannel: overrides.releaseChannel,
    desiredVersionId: overrides.desiredVersionId,
    desiredPackageSha256: overrides.desiredPackageSha256,
  };
}

function rollout(
  overrides: Partial<WorkspaceSkillRolloutPolicy> & Pick<WorkspaceSkillRolloutPolicy, "name" | "source" | "target" | "audience">,
): WorkspaceSkillRolloutPolicy {
  const name = overrides.name;
  return {
    id: overrides.id ?? `${overrides.source}_${name}_rollout`,
    skillId: overrides.skillId ?? `${name}_skill`,
    name,
    versionId: overrides.versionId ?? `${name}_v1`,
    packageSha256:
      overrides.packageSha256 ??
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    enabled: overrides.enabled ?? true,
    source: overrides.source,
    target: overrides.target,
    audience: overrides.audience,
    orgId: overrides.orgId,
    userId: overrides.userId,
    workspaceId: overrides.workspaceId,
    removalPolicy: overrides.removalPolicy ?? "user_removable",
    updatePolicy: overrides.updatePolicy,
    releaseChannel: overrides.releaseChannel,
  };
}

describe("resolveWorkspaceSkillSet", () => {
  test("personal workspace can include personal global skills", () => {
    const result = resolveWorkspaceSkillSet({
      workspace: { id: "ws_personal", scope: "personal" },
      user: { id: "user_1" },
      registryInstallations: [
        installation({ name: "research", source: "personal", ownerUserId: "user_1" }),
      ],
      localUnmanagedSkills: [],
      policy: {},
    });

    expect(result.effectiveManagedSkills.map((skill) => skill.name)).toEqual(["research"]);
    expect(result.requiredMaterializations).toEqual([
      {
        installationId: "personal_research_install",
        skillId: "research_skill",
        name: "research",
        versionId: "research_v1",
        packageSha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        source: "personal",
        removalPolicy: "user_removable",
        target: "personal-global",
      },
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.reloadRequired).toBe(true);
  });

  test("organization workspace resolves organization and platform skills to approved versions", () => {
    const result = resolveWorkspaceSkillSet({
      workspace: { id: "ws_org", scope: "organization", orgId: "org_1" },
      user: { id: "user_1", orgId: "org_1" },
      registryInstallations: [
        installation({ name: "release-notes", source: "organization", orgId: "org_1", approved: true }),
        installation({ name: "security-review", source: "platform", approved: true }),
        installation({ name: "draft-org", source: "organization", orgId: "org_1", approved: false }),
      ],
      localUnmanagedSkills: [],
      policy: {},
    });

    expect(result.effectiveManagedSkills.map((skill) => skill.name)).toEqual([
      "release-notes",
      "security-review",
    ]);
    expect(result.blockedInstallations.map((entry) => entry.name)).toEqual(["draft-org"]);
    expect(result.blockedInstallations[0]?.reason).toBe("not-approved");
    expect(result.requiredMaterializations.every((entry) => entry.target === "workspace")).toBe(true);
  });

  test("pinned workspace skill set uses desired version overrides for stable output", () => {
    const result = resolveWorkspaceSkillSet({
      workspace: { id: "ws_org", scope: "organization", orgId: "org_1" },
      user: { id: "user_1", orgId: "org_1" },
      registryInstallations: [
        installation({
          name: "planning",
          source: "workspace",
          orgId: "org_1",
          workspaceId: "ws_org",
          approved: true,
          versionId: "planning_latest",
          desiredVersionId: "planning_pinned",
          desiredPackageSha256:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
      ],
      localUnmanagedSkills: [],
      policy: {},
    });

    expect(result.effectiveManagedSkills[0]?.versionId).toBe("planning_pinned");
    expect(result.effectiveManagedSkills[0]?.packageSha256).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(result.requiredMaterializations[0]?.versionId).toBe("planning_pinned");
  });

  test("personal globals cannot shadow organization managed names unless policy allows it", () => {
    const blocked = resolveWorkspaceSkillSet({
      workspace: { id: "ws_org", scope: "organization", orgId: "org_1" },
      user: { id: "user_1", orgId: "org_1" },
      registryInstallations: [
        installation({ name: "research", source: "organization", orgId: "org_1", approved: true }),
        installation({ name: "research", source: "personal", ownerUserId: "user_1" }),
      ],
      localUnmanagedSkills: [],
      policy: {},
    });

    expect(blocked.effectiveManagedSkills.map((skill) => skill.source)).toEqual(["organization"]);
    expect(blocked.conflicts).toEqual([
      {
        code: "personal-global-shadowed",
        name: "research",
        blockingInstallationId: "organization_research_install",
        blockedInstallationId: "personal_research_install",
        message: "Personal global skill research cannot shadow organization-managed skill research.",
      },
    ]);

    const allowed = resolveWorkspaceSkillSet({
      workspace: { id: "ws_org", scope: "organization", orgId: "org_1" },
      user: { id: "user_1", orgId: "org_1" },
      registryInstallations: [
        installation({ name: "research", source: "organization", orgId: "org_1", approved: true }),
        installation({ name: "research", source: "personal", ownerUserId: "user_1" }),
      ],
      localUnmanagedSkills: [],
      policy: { allowPersonalGlobalShadowOrgManaged: true },
    });

    expect(allowed.effectiveManagedSkills.map((skill) => skill.source)).toEqual(["organization"]);
    expect(allowed.conflicts).toEqual([
      {
        code: "target-conflict",
        name: "research",
        blockingInstallationId: "organization_research_install",
        blockedInstallationId: "personal_research_install",
        message: "Skill research cannot be active as both user-global and workspace targets.",
      },
    ]);
  });

  test("conflict output identifies unmanaged local skills blocked by managed names", () => {
    const result = resolveWorkspaceSkillSet({
      workspace: { id: "ws_org", scope: "organization", orgId: "org_1" },
      user: { id: "user_1", orgId: "org_1" },
      registryInstallations: [
        installation({ name: "reporting", source: "organization", orgId: "org_1", approved: true }),
      ],
      localUnmanagedSkills: [
        {
          name: "reporting",
          path: "/workspace/.opencode/skills/reporting/SKILL.md",
          scope: "workspace",
        },
      ],
      policy: {},
    });

    expect(result.conflicts).toEqual([
      {
        code: "unmanaged-local-shadowed",
        name: "reporting",
        blockingInstallationId: "organization_reporting_install",
        localPath: "/workspace/.opencode/skills/reporting/SKILL.md",
        message: "Unmanaged local skill reporting conflicts with managed skill reporting.",
      },
    ]);
    expect(result.reloadRequired).toBe(true);
  });

  test("all-org-users rollout applies as personal-global only for organization members", () => {
    const included = resolveWorkspaceSkillSet({
      workspace: { id: "ws_org", scope: "organization", orgId: "org_1" },
      user: { id: "user_1", orgId: "org_1" },
      registryInstallations: [],
      rolloutPolicies: [
        rollout({
          name: "office-writer",
          source: "organization",
          target: "personal-global",
          audience: "all-org-users",
          orgId: "org_1",
          removalPolicy: "locked",
        }),
      ],
      localUnmanagedSkills: [],
    });

    expect(included.requiredMaterializations).toEqual([
      {
        installationId: "rollout:organization_office-writer_rollout",
        skillId: "office-writer_skill",
        name: "office-writer",
        versionId: "office-writer_v1",
        packageSha256:
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        source: "organization",
        removalPolicy: "locked",
        target: "personal-global",
      },
    ]);

    const excluded = resolveWorkspaceSkillSet({
      workspace: { id: "ws_other", scope: "organization", orgId: "org_2" },
      user: { id: "user_2", orgId: "org_2" },
      registryInstallations: [],
      rolloutPolicies: [
        rollout({
          name: "office-writer",
          source: "organization",
          target: "personal-global",
          audience: "all-org-users",
          orgId: "org_1",
        }),
      ],
      localUnmanagedSkills: [],
    });

    expect(excluded.requiredMaterializations).toEqual([]);
  });

  test("selected workspace rollout applies only to the chosen workspace", () => {
    const result = resolveWorkspaceSkillSet({
      workspace: { id: "ws_target", scope: "organization", orgId: "org_1" },
      user: { id: "user_1", orgId: "org_1" },
      registryInstallations: [],
      rolloutPolicies: [
        rollout({
          name: "planning",
          source: "organization",
          target: "workspace",
          audience: "selected-workspaces",
          orgId: "org_1",
          workspaceId: "ws_target",
        }),
        rollout({
          name: "not-this-workspace",
          source: "organization",
          target: "workspace",
          audience: "selected-workspaces",
          orgId: "org_1",
          workspaceId: "ws_other",
        }),
      ],
      localUnmanagedSkills: [],
    });

    expect(result.requiredMaterializations.map((skill) => skill.name)).toEqual(["planning"]);
    expect(result.requiredMaterializations[0]?.target).toBe("workspace");
  });

  test("target conflicts do not materialize both user-global and workspace rollouts", () => {
    const result = resolveWorkspaceSkillSet({
      workspace: { id: "ws_target", scope: "organization", orgId: "org_1" },
      user: { id: "user_1", orgId: "org_1" },
      registryInstallations: [],
      rolloutPolicies: [
        rollout({
          name: "office-writer",
          source: "organization",
          target: "personal-global",
          audience: "all-org-users",
          orgId: "org_1",
          removalPolicy: "user_removable",
        }),
        rollout({
          id: "office_locked_workspace",
          name: "office-writer",
          source: "organization",
          target: "workspace",
          audience: "selected-workspaces",
          orgId: "org_1",
          workspaceId: "ws_target",
          removalPolicy: "locked",
        }),
      ],
      localUnmanagedSkills: [],
    });

    expect(result.requiredMaterializations).toHaveLength(1);
    expect(result.requiredMaterializations[0]).toMatchObject({
      installationId: "rollout:office_locked_workspace",
      target: "workspace",
    });
    expect(result.conflicts).toEqual([
      {
        code: "target-conflict",
        name: "office-writer",
        blockingInstallationId: "rollout:office_locked_workspace",
        blockedInstallationId: "rollout:organization_office-writer_rollout",
        message: "Skill office-writer cannot be active as both user-global and workspace targets.",
      },
    ]);
  });
});
