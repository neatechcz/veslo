import type { ConversationSubmitSkillCommandResolver } from "./conversation-submit-draft-resolution.js";
import { workspaceResourceOwner } from "./resource-owner.js";
import { listDisabledSkills } from "./skill-enabled-overrides.js";
import { resolveSkillMatch } from "./skill-resolver.js";
import { listActiveWorkspaceSkills } from "./skills.js";

export function createConversationSubmitSkillCommandResolver(_input: {
  dataDir?: string;
}): ConversationSubmitSkillCommandResolver {
  return async ({ text, workspace }) => {
    const normalizedText = text.trim();
    if (!normalizedText || !workspace) return null;

    const disabledSkills = await listDisabledSkills({
      workspaceId: workspace.id,
      includeGlobal: true,
      ...(_input.dataDir ? { dataDir: _input.dataDir } : {}),
    });
    const skills = await listActiveWorkspaceSkills(workspace.path, {
      disabledSkills,
      workspaceId: workspace.id,
      workspaceOwner: workspaceResourceOwner({
        workspaceId: workspace.id,
        root: workspace.path,
        label: workspace.name,
      }),
    });
    const result = resolveSkillMatch({
      text: normalizedText,
      skills,
    });
    return result.match?.name?.trim() || null;
  };
}
