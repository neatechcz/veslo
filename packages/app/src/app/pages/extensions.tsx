import { Show, createMemo } from "solid-js";

import { Box } from "lucide-solid";

import McpView, { type McpViewProps } from "./mcp";
import { currentLocale, t } from "../../i18n";

export type ExtensionsViewProps = McpViewProps & {
  refreshMcpServers: () => void;
};

export default function ExtensionsView(props: ExtensionsViewProps) {
  const tr = (key: string) => t(key, currentLocale());

  const connectedAppsCount = createMemo(() =>
    props.mcpServers.filter((entry) => {
      if (entry.config.enabled === false) return false;
      const status = props.mcpStatuses[entry.name];
      return status?.status === "connected";
    }).length,
  );

  return (
    <section class="space-y-6 animate-in fade-in duration-300">
      <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div class="space-y-1">
          <h2 class="text-3xl font-bold text-dls-text">{tr("extensions.title")}</h2>
          <p class="text-sm text-dls-secondary mt-1.5">
            {tr("extensions.subtitle")}
          </p>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <Show when={connectedAppsCount() > 0}>
              <div class="inline-flex items-center gap-2 rounded-full bg-green-3 px-3 py-1">
                <div class="w-2 h-2 rounded-full bg-green-9" />
                <span class="text-xs font-medium text-green-11">
                  {connectedAppsCount()} {connectedAppsCount() === 1 ? tr("extensions.apps_connected_one") : tr("extensions.apps_connected_other")}
                </span>
              </div>
            </Show>
          </div>
        </div>
      </div>

      <div class="space-y-4">
        <div class="flex items-center gap-2 text-sm font-medium text-gray-12">
          <Box size={16} class="text-gray-11" />
          <span>{tr("extensions.apps_mcp")}</span>
        </div>
        <McpView
          showHeader={false}
          busy={props.busy}
          activeWorkspaceRoot={props.activeWorkspaceRoot}
          isRemoteWorkspace={props.isRemoteWorkspace}
          mcpServers={props.mcpServers}
          mcpStatus={props.mcpStatus}
          mcpLastUpdatedAt={props.mcpLastUpdatedAt}
          mcpStatuses={props.mcpStatuses}
          mcpConnectingName={props.mcpConnectingName}
          selectedMcp={props.selectedMcp}
          setSelectedMcp={props.setSelectedMcp}
          quickConnect={props.quickConnect}
          hubMcpCards={props.hubMcpCards}
          hubMcpStatus={props.hubMcpStatus}
          refreshHubMcp={props.refreshHubMcp}
          installHubMcp={props.installHubMcp}
          refreshMcpServers={props.refreshMcpServers}
          connectMcp={props.connectMcp}
          authorizeMcp={props.authorizeMcp}
          logoutMcpAuth={props.logoutMcpAuth}
          removeMcp={props.removeMcp}
          showMcpReloadBanner={props.showMcpReloadBanner}
          reloadBlocked={props.reloadBlocked}
          reloadMcpEngine={props.reloadMcpEngine}
        />
      </div>
    </section>
  );
}
