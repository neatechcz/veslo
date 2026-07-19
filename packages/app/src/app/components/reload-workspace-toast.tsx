import { Show } from "solid-js";
import { AlertTriangle, RefreshCcw, X } from "lucide-solid";

import Button from "./button";
import type { ReloadTrigger } from "../types";
import { currentLocale as __vesloCurrentLocale, t as __vesloT } from "../../i18n";

export type ReloadWorkspaceToastProps = {
  open: boolean;
  title: string;
  description: string;
  trigger?: ReloadTrigger | null;
  warning?: string;
  blockedReason?: string | null;
  error?: string | null;
  reloadLabel: string;
  dismissLabel: string;
  busy?: boolean;
  canReload: boolean;
  hasActiveRuns: boolean;
  onReload: () => void;
  onDismiss: () => void;
};

export default function ReloadWorkspaceToast(props: ReloadWorkspaceToastProps) {
  const getDescription = () => {
    if (!props.trigger) return props.description;
    const { type, name, action } = props.trigger;
    const trimmedName = name?.trim();
    const verbKey =
      action === "removed"
        ? "reload.trigger_removed"
        : action === "added"
        ? "reload.trigger_added"
        : action === "updated"
        ? "reload.trigger_updated"
        : "reload.trigger_changed";
    const verb = __vesloT(verbKey, __vesloCurrentLocale());

    if (type === "skill") {
      return trimmedName
        ? __vesloT("reload.trigger_skill_named", __vesloCurrentLocale()).replace("{name}", trimmedName).replace("{verb}", verb)
        : __vesloT("reload.trigger_skills_changed", __vesloCurrentLocale());
    }

    if (type === "plugin") {
      return trimmedName
        ? __vesloT("reload.trigger_plugin_named", __vesloCurrentLocale()).replace("{name}", trimmedName).replace("{verb}", verb)
        : __vesloT("reload.trigger_plugins_changed", __vesloCurrentLocale());
    }

    if (type === "mcp") {
      return trimmedName
        ? __vesloT("reload.trigger_mcp_named", __vesloCurrentLocale()).replace("{name}", trimmedName).replace("{verb}", verb)
        : __vesloT("reload.trigger_mcp_changed", __vesloCurrentLocale());
    }

    if (type === "config") {
      return trimmedName
        ? __vesloT("reload.trigger_config_named", __vesloCurrentLocale()).replace("{name}", trimmedName).replace("{verb}", verb)
        : __vesloT("reload.trigger_config_changed", __vesloCurrentLocale());
    }

    if (type === "agent") {
      return trimmedName
        ? __vesloT("reload.trigger_agent_named", __vesloCurrentLocale()).replace("{name}", trimmedName).replace("{verb}", verb)
        : __vesloT("reload.trigger_agents_changed", __vesloCurrentLocale());
    }

    return trimmedName
      ? __vesloT("reload.trigger_command_named", __vesloCurrentLocale()).replace("{name}", trimmedName).replace("{verb}", verb)
      : __vesloT("reload.trigger_commands_changed", __vesloCurrentLocale());
  };

  return (
    <Show when={props.open}>
      <div class="fixed top-6 left-1/2 -translate-x-1/2 z-50 w-[min(480px,calc(100vw-2rem))]">
        <div 
          class="
            flex items-center gap-3 p-2 pr-3 rounded-full 
            border border-gray-6/50 bg-gray-2/95 shadow-xl backdrop-blur-md 
            animate-in fade-in slide-in-from-top-4 duration-300
          "
        >
          {/* Icon Circle */}
          <div class={`
            flex h-9 w-9 shrink-0 items-center justify-center rounded-full 
            ${props.hasActiveRuns ? 'bg-amber-3 text-amber-11' : 'bg-blue-3 text-blue-11'}
          `}>
            <RefreshCcw size={16} class={props.busy ? "animate-spin" : ""} />
          </div>

          {/* Text Content */}
          <div class="flex-1 min-w-0 flex flex-col justify-center">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-gray-12 truncate">
                {props.title}
              </span>
              <Show when={props.hasActiveRuns}>
                <span class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider bg-amber-4 text-amber-11">
                  {__vesloT("ui.literal.active_tasks_1umt96", __vesloCurrentLocale())}</span>
              </Show>
            </div>
            
            <Show when={props.description || props.error || props.warning || props.blockedReason}>
              <div class="text-xs text-gray-10 leading-snug mt-0.5 space-y-1">
                <div>
                  {props.hasActiveRuns 
                    ? <span class="text-amber-11 font-medium">{__vesloT("ui.literal.reloading_will_stop_active_tasks_4xmwru", __vesloCurrentLocale())}</span>
                    : props.error 
                    ? <span class="text-red-9 font-medium">{props.error}</span>
                    : getDescription()
                  }
                </div>
                <Show when={props.warning}>
                  <div class="text-amber-11">{props.warning}</div>
                </Show>
                <Show when={props.blockedReason}>
                  <div class="text-gray-9">{__vesloT("ui.literal.blocked_zi7yob", __vesloCurrentLocale())}{" "}{props.blockedReason}</div>
                </Show>
              </div>
            </Show>
          </div>

          {/* Actions */}
          <div class="flex items-center gap-2 shrink-0 pl-2 border-l border-gray-5/50">
             <button 
              onClick={() => props.onDismiss()}
              class="px-2 py-1.5 text-xs font-medium text-gray-10 hover:text-gray-12 transition-colors"
            >
              {props.dismissLabel}
            </button>
            <Button
              variant={props.hasActiveRuns ? "danger" : "primary"}
              class="h-7 px-3 text-xs rounded-full font-medium"
              onClick={() => props.onReload()}
              disabled={props.busy || !props.canReload}
            >
              {props.reloadLabel}
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
