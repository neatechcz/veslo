import { describe, expect, test } from "bun:test";

import { resolveWorkspaceSkillSet } from "./workspace-skill-set.js";
import type { WorkspaceSkillRegistryInstallation } from "./workspace-skill-set.js";

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

    expect(allowed.effectiveManagedSkills.map((skill) => skill.source)).toEqual([
      "organization",
      "personal",
    ]);
    expect(allowed.conflicts).toEqual([]);
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
});
