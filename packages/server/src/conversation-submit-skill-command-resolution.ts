import type { ConversationSubmitSkillCommandResolver } from "./conversation-submit-draft-resolution.js";
import { workspaceResourceOwner } from "./resource-owner.js";
import { ensureActiveRuntimeSkillView } from "./active-runtime-skill-view.js";
import { listDisabledSkills } from "./skill-enabled-overrides.js";
import { resolveSkillMatch } from "./skill-resolver.js";
import { withWorkspaceSkillLease } from "./workspace-skill-lease.js";

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
    const skills = (
      await withWorkspaceSkillLease(
        workspace.path,
        "conversation-skill-command-resolution",
        () =>
          ensureActiveRuntimeSkillView(workspace, {
            disabledSkills,
            workspaceId: workspace.id,
            workspaceOwner: workspaceResourceOwner({
              workspaceId: workspace.id,
              root: workspace.path,
              label: workspace.name,
            }),
          }),
      )
    ).skills;
    const result = resolveSkillMatch({
      text: normalizedText,
      skills,
    });
    return result.match?.name?.trim() || null;
  };
}
