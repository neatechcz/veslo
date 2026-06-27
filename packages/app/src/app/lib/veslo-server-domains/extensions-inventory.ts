import type { CommandsClient } from "./commands";
import type { McpClient } from "./mcp";
import type { PluginsClient } from "./plugins";
import type { SkillsClient } from "./skills";

export type ExtensionsInventoryClientContext = {
  mcp: Pick<McpClient, "list">;
  plugins: Pick<PluginsClient, "list">;
  skills: Pick<SkillsClient, "list">;
  commands: Pick<CommandsClient, "list">;
};

export type ExtensionsInventoryOverviewOptions = {
  includeGlobalPlugins?: boolean;
  includeGlobalSkills?: boolean;
  includeDisabledSkills?: boolean;
  commandScope?: "workspace" | "global";
};

export function createExtensionsInventoryClient(context: ExtensionsInventoryClientContext) {
  return {
    overview: async (workspaceId: string, options?: ExtensionsInventoryOverviewOptions) => {
      const [mcp, plugins, skills, commands] = await Promise.all([
        context.mcp.list(workspaceId),
        context.plugins.list(workspaceId, { includeGlobal: options?.includeGlobalPlugins }),
        context.skills.list(workspaceId, {
          includeGlobal: options?.includeGlobalSkills,
          includeDisabled: options?.includeDisabledSkills,
        }),
        context.commands.list(workspaceId, options?.commandScope ?? "workspace"),
      ]);

      return {
        mcp,
        plugins,
        skills,
        commands,
      };
    },
  };
}

export type ExtensionsInventoryClient = ReturnType<typeof createExtensionsInventoryClient>;
