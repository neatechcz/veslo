import { For, Show, createMemo } from "solid-js";

import type { PluginInventoryCard, PluginScope } from "../types";

import Button from "../components/button";
import TextInput from "../components/text-input";
import { Cpu } from "lucide-solid";
import { currentLocale as __vesloCurrentLocale, t as __vesloT } from "../../i18n";

type SuggestedPluginCard = {
  name: string;
  packageName: string;
  description: string;
  tags: string[];
  aliases?: string[];
  installMode?: "simple" | "guided";
  steps?: Array<{
    title: string;
    description: string;
    command?: string;
    url?: string;
    path?: string;
    note?: string;
  }>;
};

type PluginInventoryScope = PluginInventoryCard["scope"];

const PLUGIN_INVENTORY_GROUPS = [
  { key: "platform", label: "Platform" },
  { key: "organization", label: "Organization" },
  { key: "user", label: "User" },
  { key: "project", label: "Project" },
] satisfies Array<{ key: PluginInventoryScope; label: string }>;

const POLICY_MANAGED_SUGGESTION_BLOCKLIST = new Set([
  "opencode-scheduler",
  "superpowers",
  "superpowers@git+https://github.com/obra/superpowers.git",
]);

const normalizeSuggestionIdentifier = (value: string) => value.trim().toLowerCase();

const suggestedPluginIsPolicyManaged = (plugin: SuggestedPluginCard) => {
  const identifiers = [plugin.name, plugin.packageName, ...(plugin.aliases ?? [])]
    .map(normalizeSuggestionIdentifier)
    .filter(Boolean);
  return identifiers.some((identifier) => POLICY_MANAGED_SUGGESTION_BLOCKLIST.has(identifier));
};

const legacyPluginInventoryScope = (scope: PluginScope): Extract<PluginInventoryScope, "user" | "project"> =>
  scope === "global" ? "user" : "project";

const legacyPluginInventoryCard = (spec: string, scope: PluginScope): PluginInventoryCard => ({
  id: `config.${legacyPluginInventoryScope(scope)}.${spec}`,
  spec,
  displayName: spec,
  scope: legacyPluginInventoryScope(scope),
  enabled: true,
  lifecycle: "active",
  managed: false,
  visibility: "visible",
  removalPolicy: "user-removable",
  enabledPolicy: "user-toggleable",
  source: "config.unmanaged",
  target: scope === "global" ? "user" : "project",
});

const canTogglePluginInventoryCard = (item: PluginInventoryCard) =>
  item.managed &&
  item.lifecycle !== "removed" &&
  item.lifecycle !== "conflict" &&
  item.enabledPolicy === "user-toggleable";

const canRemovePluginInventoryCard = (item: PluginInventoryCard) =>
  item.lifecycle !== "removed" &&
  item.removalPolicy === "user-removable" &&
  (item.managed || item.scope === "user" || item.scope === "project");

const canRestorePluginInventoryCard = (item: PluginInventoryCard) =>
  item.managed && item.lifecycle === "removed" && item.removalPolicy === "user-removable";

const pluginLifecycleLabel = (item: PluginInventoryCard) => {
  if (item.lifecycle === "removed") return "Removed";
  if (item.lifecycle === "conflict") return "Conflict";
  if (item.enabled === false || item.lifecycle === "disabled") return "Disabled";
  return "Enabled";
};

const pluginOwnerLabel = (item: PluginInventoryCard) => {
  if (item.owner?.label) return item.owner.label;
  if (item.source === "config.unmanaged") return "OpenCode config";
  return item.managed ? "Managed policy" : "Manual plugin";
};

export type PluginsViewProps = {
  busy: boolean;
  developerMode: boolean;
  activeWorkspaceRoot: string;
  canEditPlugins: boolean;
  canUseGlobalScope: boolean;
  accessHint?: string | null;
  pluginScope: PluginScope;
  setPluginScope: (scope: PluginScope) => void;
  pluginConfigPath: string | null;
  pluginInventory: PluginInventoryCard[];
  pluginList: string[];
  pluginInput: string;
  setPluginInput: (value: string) => void;
  pluginStatus: string | null;
  activePluginGuide: string | null;
  setActivePluginGuide: (value: string | null) => void;
  isPluginInstalled: (name: string, aliases?: string[]) => boolean;
  suggestedPlugins: SuggestedPluginCard[];
  refreshPlugins: (scopeOverride?: PluginScope, optionsOverride?: { debug?: boolean }) => void;
  addPlugin: (pluginNameOverride?: string) => void;
  removePlugin: (pluginName: string) => void;
  setPluginEnabled?: (pluginId: string, enabled: boolean) => Promise<void>;
  removeManagedPlugin?: (pluginId: string) => Promise<void>;
  restoreManagedPlugin?: (pluginId: string) => Promise<void>;
};

export default function PluginsView(props: PluginsViewProps) {
  const refreshPluginsForMode = (scopeOverride?: PluginScope) => {
    props.refreshPlugins(scopeOverride, { debug: props.developerMode });
  };

  const pluginInventoryRows = createMemo(() =>
    props.pluginInventory.length
      ? props.pluginInventory
      : props.pluginList.map((pluginName) => legacyPluginInventoryCard(pluginName, props.pluginScope)),
  );

  const visiblePluginInventoryRows = createMemo(() =>
    pluginInventoryRows().filter((item) => {
      if (item.visibility !== "hidden-debug-only") return true;
      return props.developerMode;
    }),
  );

  const groupedPluginInventoryRows = createMemo(() =>
    PLUGIN_INVENTORY_GROUPS
      .map((group) => ({
        ...group,
        rows: visiblePluginInventoryRows().filter((item) => item.scope === group.key),
      }))
      .filter((group) => group.rows.length > 0),
  );

  const suggestedPluginsForDisplay = createMemo(() =>
    props.suggestedPlugins.filter((plugin) => !suggestedPluginIsPolicyManaged(plugin)),
  );

  const manualAddDisabled = () =>
    props.busy ||
    !props.pluginInput.trim() ||
    !props.canEditPlugins ||
    (props.pluginScope === "project" && !props.activeWorkspaceRoot.trim());

  const togglePluginInventoryCard = (item: PluginInventoryCard) => {
    if (!props.setPluginEnabled || !canTogglePluginInventoryCard(item)) return;
    void props.setPluginEnabled(item.id, !item.enabled);
  };

  const removePluginInventoryCard = (item: PluginInventoryCard) => {
    if (!canRemovePluginInventoryCard(item)) return;
    if (item.managed) {
      if (!props.removeManagedPlugin) return;
      void props.removeManagedPlugin(item.id);
      return;
    }
    props.removePlugin(item.spec);
  };

  const restorePluginInventoryCard = (item: PluginInventoryCard) => {
    if (!props.restoreManagedPlugin || !canRestorePluginInventoryCard(item)) return;
    void props.restoreManagedPlugin(item.id);
  };

  return (
    <section class="space-y-6">
      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-1">
            <div class="text-sm font-medium text-gray-12">{__vesloT("plugins.title", __vesloCurrentLocale())}</div>
            <div class="text-xs text-gray-10">{__vesloT("plugins.description", __vesloCurrentLocale())}</div>
          </div>
          <div class="flex items-center gap-2">
            <button
              class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                props.pluginScope === "project"
                  ? "bg-gray-12/10 text-gray-12 border-gray-6/20"
                  : "text-gray-10 border-gray-6 hover:text-gray-12"
              }`}
              onClick={() => {
                props.setPluginScope("project");
                refreshPluginsForMode("project");
              }}
            >
              {__vesloT("plugins.scope_project", __vesloCurrentLocale())}</button>
            <button
              disabled={!props.canUseGlobalScope}
              class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                props.pluginScope === "global"
                  ? "bg-gray-12/10 text-gray-12 border-gray-6/20"
                  : "text-gray-10 border-gray-6 hover:text-gray-12"
              } ${!props.canUseGlobalScope ? "opacity-40 cursor-not-allowed hover:text-gray-10" : ""}`}
              onClick={() => {
                if (!props.canUseGlobalScope) return;
                props.setPluginScope("global");
                refreshPluginsForMode("global");
              }}
            >
              {__vesloT("session.capabilities_scope_global", __vesloCurrentLocale())}</button>
            <Button variant="ghost" onClick={() => refreshPluginsForMode()}>
              {__vesloT("skills.refresh", __vesloCurrentLocale())}</Button>
          </div>
        </div>

        <div class="flex flex-col gap-1 text-xs text-gray-10">
          <div>{__vesloT("plugins.config_label", __vesloCurrentLocale())}</div>
          <div class="text-gray-7 font-mono truncate">{props.pluginConfigPath ?? __vesloT("plugins.config_not_loaded", __vesloCurrentLocale())}</div>
          <Show when={props.accessHint}>
            <div class="text-gray-9">{props.accessHint}</div>
          </Show>
        </div>

        <Show when={suggestedPluginsForDisplay().length > 0}>
          <div class="space-y-3">
            <div class="text-xs font-medium text-gray-11 uppercase tracking-wider">{__vesloT("plugins.suggested_label", __vesloCurrentLocale())}</div>
            <div class="grid gap-3">
              <For each={suggestedPluginsForDisplay()}>
                {(plugin) => {
                  const isGuided = () => plugin.installMode === "guided";
                  const isInstalled = () => props.isPluginInstalled(plugin.packageName, plugin.aliases ?? []);
                  const isGuideOpen = () => props.activePluginGuide === plugin.packageName;

                  return (
                    <div class="rounded-2xl border border-gray-6/60 bg-gray-1/40 p-4 space-y-3">
                      <div class="flex items-start justify-between gap-4">
                        <div>
                          <div class="text-sm font-medium text-gray-12 font-mono">{plugin.name}</div>
                          <div class="text-xs text-gray-10 mt-1">{plugin.description}</div>
                          <Show when={plugin.packageName !== plugin.name}>
                            <div class="text-xs text-gray-7 font-mono mt-1">{plugin.packageName}</div>
                          </Show>
                        </div>
                        <div class="flex items-center gap-2">
                          <Show when={isGuided()}>
                            <Button
                              variant="ghost"
                              onClick={() => props.setActivePluginGuide(isGuideOpen() ? null : plugin.packageName)}
                            >
                              {isGuideOpen() ? __vesloT("plugins.hide_setup", __vesloCurrentLocale()) : __vesloT("plugins.setup", __vesloCurrentLocale())}
                            </Button>
                          </Show>
                          <Button
                            variant={isInstalled() ? "outline" : "secondary"}
                            onClick={() => props.addPlugin(plugin.packageName)}
                            disabled={
                              props.busy ||
                              isInstalled() ||
                              !props.canEditPlugins ||
                              (props.pluginScope === "project" && !props.activeWorkspaceRoot.trim())
                            }
                          >
                            {isInstalled() ? __vesloT("plugins.added", __vesloCurrentLocale()) : __vesloT("plugins.add", __vesloCurrentLocale())}
                          </Button>
                        </div>
                      </div>
                      <div class="flex flex-wrap gap-2">
                        <For each={plugin.tags}>
                          {(tag) => (
                            <span class="text-[10px] uppercase tracking-wide bg-gray-4/70 text-gray-11 px-2 py-0.5 rounded-full">
                              {tag}
                            </span>
                          )}
                        </For>
                      </div>
                      <Show when={isGuided() && isGuideOpen()}>
                        <div class="rounded-xl border border-gray-6/70 bg-gray-1/60 p-4 space-y-3">
                          <For each={plugin.steps ?? []}>
                            {(step, idx) => (
                              <div class="space-y-1">
                                <div class="text-xs font-medium text-gray-11">
                                  {idx() + 1}. {step.title}
                                </div>
                                <div class="text-xs text-gray-10">{step.description}</div>
                                <Show when={step.command}>
                                  <div class="text-xs font-mono text-gray-12 bg-gray-2/60 border border-gray-6/70 rounded-lg px-3 py-2">
                                    {step.command}
                                  </div>
                                </Show>
                                <Show when={step.note}>
                                  <div class="text-xs text-gray-10">{step.note}</div>
                                </Show>
                                <Show when={step.url}>
                                  <div class="text-xs text-gray-10">
                                    {__vesloT("ui.literal.open_o47uw9", __vesloCurrentLocale())}{" "}<span class="font-mono text-gray-11">{step.url}</span>
                                  </div>
                                </Show>
                                <Show when={step.path}>
                                  <div class="text-xs text-gray-10">
                                    {__vesloT("ui.literal.path_1yqvg9", __vesloCurrentLocale())}{" "}<span class="font-mono text-gray-11">{step.path}</span>
                                  </div>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>

        <Show
          when={groupedPluginInventoryRows().length}
          fallback={
            <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 text-sm text-gray-10">
              {__vesloT("plugins.no_plugins_yet", __vesloCurrentLocale())}</div>
          }
        >
          <div class="space-y-4">
            <For each={groupedPluginInventoryRows()}>
              {(group) => (
                <div class="space-y-2" data-testid={`plugin-inventory-group-${group.key}`}>
                  <div class="text-xs font-medium text-gray-11 uppercase tracking-wider">{group.label}</div>
                  <div class="grid gap-2">
                    <For each={group.rows}>
                      {(item) => {
                        const toggleVisible = () => canTogglePluginInventoryCard(item) && Boolean(props.setPluginEnabled);
                        const removeVisible = () =>
                          canRemovePluginInventoryCard(item) &&
                          (item.managed ? Boolean(props.removeManagedPlugin) : props.canEditPlugins);
                        const restoreVisible = () => canRestorePluginInventoryCard(item) && Boolean(props.restoreManagedPlugin);

                        return (
                          <div class="flex items-center justify-between gap-4 rounded-xl border border-gray-6/60 bg-gray-1/40 px-4 py-3">
                            <div class="min-w-0 flex items-start gap-3">
                              <div class="mt-0.5 rounded-lg border border-gray-6/70 bg-gray-2/60 p-1.5 text-gray-10">
                                <Cpu size={14} />
                              </div>
                              <div class="min-w-0 space-y-1">
                                <div class="flex flex-wrap items-center gap-2">
                                  <div class="text-sm text-gray-12 font-medium truncate">{item.displayName}</div>
                                  <span class="rounded-full bg-gray-3/70 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-10">
                                    {pluginLifecycleLabel(item)}
                                  </span>
                                  <Show when={item.visibility === "hidden-debug-only"}>
                                    <span class="rounded-full bg-amber-3 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-11">
                                      Debug
                                    </span>
                                  </Show>
                                </div>
                                <div class="text-xs text-gray-7 font-mono truncate">{item.spec}</div>
                                <div class="text-xs text-gray-10 truncate">{pluginOwnerLabel(item)}</div>
                                <Show when={item.conflict}>
                                  <div class="text-xs text-red-11">{item.conflict}</div>
                                </Show>
                              </div>
                            </div>
                            <div class="flex shrink-0 items-center gap-2">
                              <Show when={toggleVisible()}>
                                <Button
                                  variant="ghost"
                                  class="h-7 px-2 text-[11px]"
                                  data-testid="plugin-inventory-toggle"
                                  onClick={() => togglePluginInventoryCard(item)}
                                  disabled={props.busy || !props.canEditPlugins}
                                >
                                  {item.enabled ? "Disable" : "Enable"}
                                </Button>
                              </Show>
                              <Show when={restoreVisible()}>
                                <Button
                                  variant="outline"
                                  class="h-7 px-2 text-[11px]"
                                  onClick={() => restorePluginInventoryCard(item)}
                                  disabled={props.busy || !props.canEditPlugins}
                                >
                                  Restore
                                </Button>
                              </Show>
                              <Show when={removeVisible()}>
                                <Button
                                  variant="ghost"
                                  class="h-7 px-2 text-[11px] text-red-11 hover:text-red-12"
                                  data-testid="plugin-inventory-remove"
                                  onClick={() => removePluginInventoryCard(item)}
                                  disabled={props.busy || !props.canEditPlugins}
                                >
                                  {__vesloT("mcp.remove_app", __vesloCurrentLocale())}</Button>
                              </Show>
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class="flex flex-col gap-3">
          <div class="flex flex-col md:flex-row gap-3">
            <div class="flex-1">
              <TextInput
                label={__vesloT("plugins.add_label", __vesloCurrentLocale())}
                placeholder="opencode-wakatime"
                value={props.pluginInput}
                onInput={(e) => props.setPluginInput(e.currentTarget.value)}
                hint={__vesloT("plugins.add_hint", __vesloCurrentLocale())}
              />
            </div>
            <Button
              variant="secondary"
              onClick={() => props.addPlugin()}
              disabled={manualAddDisabled()}
              class="md:mt-6"
            >
              {__vesloT("plugins.add", __vesloCurrentLocale())}</Button>
          </div>
          <Show when={props.pluginStatus}>
            <div class="text-xs text-gray-10">{props.pluginStatus}</div>
          </Show>
        </div>
      </div>
    </section>
  );
}
