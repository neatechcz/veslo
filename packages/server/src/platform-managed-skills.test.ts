import { expect, test } from "bun:test";

import {
  VESLO_AUTOMATIONS_PLATFORM_SKILL,
  getPlatformManagedPersonalGlobalSkillSet,
} from "./platform-managed-skills.js";

test("veslo-automations platform skill is deterministic and personal-global", async () => {
  const first = await getPlatformManagedPersonalGlobalSkillSet();
  const second = await getPlatformManagedPersonalGlobalSkillSet();

  expect(first.skills).toHaveLength(1);
  expect(first.skills[0]).toEqual(second.skills[0]);
  expect(first.archivesByInstallationId.get(first.skills[0].installationId)?.packageSha256)
    .toBe(second.archivesByInstallationId.get(second.skills[0].installationId)?.packageSha256);
  expect(first.skills[0]).toMatchObject({
    installationId: VESLO_AUTOMATIONS_PLATFORM_SKILL.installationId,
    skillId: VESLO_AUTOMATIONS_PLATFORM_SKILL.skillId,
    name: "veslo-automations",
    versionId: VESLO_AUTOMATIONS_PLATFORM_SKILL.versionId,
    target: "personal-global",
  });
});

test("veslo-automations platform archive teaches official Veslo automation tools only", async () => {
  const { skills, archivesByInstallationId } = await getPlatformManagedPersonalGlobalSkillSet();
  const archive = archivesByInstallationId.get(skills[0].installationId);
  expect(archive).toBeDefined();
  expect(archive?.entrypoint).toBe("SKILL.md");
  expect(archive?.metadata.name).toBe("veslo-automations");
  expect(archive?.packageSha256).toBe(skills[0].packageSha256);

  const skillMarkdown = archive?.files.find((file) => file.path === "SKILL.md")?.text ?? "";
  expect(skillMarkdown).toContain("veslo_create_automation");
  expect(skillMarkdown).toContain("veslo_list_automations");
  expect(skillMarkdown).toContain("veslo_run_automation");
  expect(skillMarkdown).toContain("veslo_update_automation");
  expect(skillMarkdown).toContain("veslo_delete_automation");
  expect(skillMarkdown).toContain("cron");
  expect(skillMarkdown).toContain("launchctl");
  expect(skillMarkdown).toContain("systemctl");
  expect(skillMarkdown).toContain("raw OpenCode scheduler jobs");
  expect(skillMarkdown).toContain("nextRunAt");
});
