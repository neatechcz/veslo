import { createHash } from "node:crypto";

import { buildSkillPackageManifest } from "./skill-package-model.js";
import type { SkillPackageFile } from "./skill-package-model.js";
import type { SkillPackageArchive } from "./skill-packages.js";
import type { WorkspaceSkillMaterialization } from "./types.js";

export const VESLO_AUTOMATIONS_PLATFORM_SKILL = {
  installationId: "platform_install_veslo_automations",
  skillId: "platform_skill_veslo_automations",
  name: "veslo-automations",
  versionId: "platform_version_veslo_automations_v1",
  target: "personal-global" as const,
};

export type PlatformManagedPersonalGlobalSkillSet = {
  skills: WorkspaceSkillMaterialization[];
  archivesByInstallationId: Map<string, SkillPackageArchive>;
};

const VESLO_AUTOMATIONS_SKILL_DESCRIPTION =
  "Use when a Veslo agent needs persistent automations, reminders, scheduled follow-ups, recurring work, or temporary delayed actions.";

const VESLO_AUTOMATIONS_SKILL_MARKDOWN = `---
name: veslo-automations
description: ${VESLO_AUTOMATIONS_SKILL_DESCRIPTION}
---

# Veslo Automations

This skill is platform-managed and locked by Veslo. Use it for persistent Veslo automations only.

Use the official Veslo automation tools:

- \`veslo_create_automation\`: create one-shot or recurring automations.
- \`veslo_list_automations\`: inspect existing automations before changing them.
- \`veslo_run_automation\`: run an automation immediately.
- \`veslo_update_automation\`: pause, resume, cancel, or adjust an automation.
- \`veslo_delete_automation\`: delete/cancel an automation through Veslo.

Do not write cron files, \`launchctl\`, \`systemctl\`, raw OpenCode scheduler jobs, or ad hoc timer files directly.

Schedules supported by Veslo:

- One-shot temporary automations with \`oneShot\` and \`runAt\`.
- Recurring \`daily\`, \`weekly\`, \`interval\`, and \`cron\` schedules.

Default to the current workspace and current session when available. Ask one short clarification question when date, time, timezone, or recurrence is ambiguous. After creation, verify and report the automation id, status, and \`nextRunAt\`.
`;

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

const archiveFile = (path: string, content: string): SkillPackageFile & { contentBase64: string } => {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    mediaType: path.endsWith(".md") ? "text/markdown" : "text/plain",
    text: content,
    contentBase64: bytes.toString("base64"),
  };
};

async function buildVesloAutomationsArchive(): Promise<SkillPackageArchive> {
  const pendingFiles = [
    archiveFile("SKILL.md", VESLO_AUTOMATIONS_SKILL_MARKDOWN),
  ];
  const manifest = await buildSkillPackageManifest({
    metadata: {
      name: VESLO_AUTOMATIONS_PLATFORM_SKILL.name,
      description: VESLO_AUTOMATIONS_SKILL_DESCRIPTION,
      tags: ["veslo", "automations", "platform-managed"],
    },
    files: pendingFiles,
  });
  const contentByPath = new Map(pendingFiles.map((file) => [file.path, file.contentBase64]));
  return {
    ...manifest,
    files: manifest.files.map((file) => {
      const contentBase64 = contentByPath.get(file.path);
      if (contentBase64 === undefined) {
        throw new Error(`Platform managed skill archive is missing content for file: ${file.path}`);
      }
      return {
        ...file,
        contentBase64,
      };
    }),
  };
}

export async function getPlatformManagedPersonalGlobalSkillSet(): Promise<PlatformManagedPersonalGlobalSkillSet> {
  const archive = await buildVesloAutomationsArchive();
  const skill: WorkspaceSkillMaterialization = {
    ...VESLO_AUTOMATIONS_PLATFORM_SKILL,
    packageSha256: archive.packageSha256,
  };
  return {
    skills: [skill],
    archivesByInstallationId: new Map([[skill.installationId, archive]]),
  };
}
