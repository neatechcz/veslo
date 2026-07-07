import { For, Show, createSignal } from "solid-js";
import { ChevronDown, Package, Plug2 } from "lucide-solid";

import { t as tr } from "../../../i18n";
import type {
  SessionCapabilityScope,
  SessionMcpCapabilityRow,
  SessionSkillCapabilityRow,
} from "../../lib/session-capabilities";

export type SessionCapabilitiesPanelState = "idle" | "loading" | "ready" | "error";

export type SessionCapabilitiesPanelProps = {
  state: SessionCapabilitiesPanelState;
  skills: SessionSkillCapabilityRow[];
  mcp: SessionMcpCapabilityRow[];
  error: string | null;
  onRefresh?: () => void;
};

const scopeLabel = (scope: SessionCapabilityScope) =>
  scope === "workspace"
    ? tr("session.capabilities_scope_workspace")
    : tr("session.capabilities_scope_global");

const statusLabel = (status: SessionMcpCapabilityRow["status"]) => {
  if (status === "connected") return tr("mcp.connected");
  if (status === "disabled") return tr("mcp.status_disabled");
  if (status === "failed") return tr("mcp.failed");
  if (status === "needs_auth") return tr("mcp.needs_auth");
  if (status === "needs_client_registration") return tr("mcp.register_client");
  return tr("mcp.disconnected");
};

const statusDotClass = (status: SessionMcpCapabilityRow["status"]) => {
  if (status === "connected") return "bg-green-9";
  if (status === "needs_auth" || status === "needs_client_registration") return "bg-amber-9";
  if (status === "failed") return "bg-red-9";
  return "bg-gray-7";
};

const fallbackText = (
  state: SessionCapabilitiesPanelState,
  error: string | null,
  emptyKey: string,
) => {
  if (state === "loading") return tr("session.capabilities_loading");
  if (state === "error") return error?.trim() || tr("session.capabilities_unavailable");
  if (state === "idle") return tr("session.capabilities_unavailable");
  return tr(emptyKey);
};

export default function SessionCapabilitiesPanel(props: SessionCapabilitiesPanelProps) {
  const [skillsExpanded, setSkillsExpanded] = createSignal(true);
  const [mcpExpanded, setMcpExpanded] = createSignal(true);
  const ready = () => props.state === "ready";
  const totalCount = () => (ready() ? props.skills.length + props.mcp.length : 0);

  return (
    <div data-testid="session-capabilities-panel" class="space-y-3">
      <div class="flex items-center justify-between px-2">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-gray-10">
          {tr("session.capabilities")}
        </span>
        <Show when={totalCount() > 0}>
          <span class="rounded bg-gray-4/60 px-1.5 text-[11px] font-medium text-gray-10">
            {totalCount()}
          </span>
        </Show>
      </div>

      <section
        data-testid="session-capabilities-skills"
        class="rounded-xl border border-gray-5/80 bg-gray-2/40"
      >
        <button
          type="button"
          aria-expanded={skillsExpanded()}
          aria-controls="session-capabilities-skills-content"
          class="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left"
          onClick={() => setSkillsExpanded((expanded) => !expanded)}
        >
          <span class="flex min-w-0 items-center gap-2">
            <Package size={14} class="shrink-0 text-gray-10" />
            <span class="truncate text-xs font-semibold text-gray-11">
              {tr("session.capabilities_skills")}
            </span>
          </span>
          <span class="flex shrink-0 items-center gap-2">
            <span class="rounded-md border border-gray-5 bg-gray-1 px-1.5 py-0.5 text-[10px] font-medium text-gray-10">
              {ready() ? props.skills.length : "-"}
            </span>
            <ChevronDown
              size={14}
              class={`text-gray-10 transition-transform ${skillsExpanded() ? "rotate-180" : ""}`.trim()}
            />
          </span>
        </button>

        <Show when={skillsExpanded()}>
          <div id="session-capabilities-skills-content" class="space-y-1 px-2 pb-2">
            <Show
              when={ready() && props.skills.length > 0}
              fallback={
                <div class="px-2 py-1.5 text-xs text-gray-9">
                  {fallbackText(props.state, props.error, "session.capabilities_no_skills")}
                </div>
              }
            >
              <For each={props.skills}>
                {(skill) => {
                  const disabled = () => skill.enabled === false;
                  const subtitle = () => skill.trigger?.trim() || skill.description?.trim() || "";
                  const title = () =>
                    disabled()
                      ? `${skill.name} · ${tr("skills.disabled_status")}`
                      : skill.name;
                  return (
                    <div class="flex min-w-0 items-start gap-2 rounded-lg px-2 py-1.5">
                      <Package size={12} class={`mt-0.5 shrink-0 ${disabled() ? "text-gray-7" : "text-gray-9"}`} />
                      <div class="min-w-0 flex-1">
                        <div class="flex min-w-0 items-center gap-1.5">
                          <span
                            class={`truncate text-xs font-medium ${disabled() ? "text-gray-9" : "text-gray-11"}`}
                            title={title()}
                          >
                            {skill.name}
                          </span>
                          <span class="shrink-0 rounded-md border border-gray-6 bg-gray-2 px-1 py-0.5 text-[9px] font-medium uppercase text-gray-9">
                            {scopeLabel(skill.scope)}
                          </span>
                          <Show when={disabled()}>
                            <span class="shrink-0 rounded-md border border-gray-6 bg-gray-3 px-1 py-0.5 text-[9px] font-medium uppercase text-gray-9">
                              {tr("skills.disabled_status")}
                            </span>
                          </Show>
                        </div>
                        <Show when={subtitle()}>
                          {(text) => (
                            <div class="truncate text-[11px] text-gray-9" title={text()}>
                              {text()}
                            </div>
                          )}
                        </Show>
                      </div>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
        </Show>
      </section>

      <section data-testid="session-capabilities-mcp" class="rounded-xl border border-gray-5/80 bg-gray-2/40">
        <button
          type="button"
          aria-expanded={mcpExpanded()}
          aria-controls="session-capabilities-mcp-content"
          class="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left"
          onClick={() => setMcpExpanded((expanded) => !expanded)}
        >
          <span class="flex min-w-0 items-center gap-2">
            <Plug2 size={14} class="shrink-0 text-gray-10" />
            <span class="truncate text-xs font-semibold text-gray-11">
              {tr("session.capabilities_mcp")}
            </span>
          </span>
          <span class="flex shrink-0 items-center gap-2">
            <span class="rounded-md border border-gray-5 bg-gray-1 px-1.5 py-0.5 text-[10px] font-medium text-gray-10">
              {ready() ? props.mcp.length : "-"}
            </span>
            <ChevronDown
              size={14}
              class={`text-gray-10 transition-transform ${mcpExpanded() ? "rotate-180" : ""}`.trim()}
            />
          </span>
        </button>

        <Show when={mcpExpanded()}>
          <div id="session-capabilities-mcp-content" class="space-y-1 px-2 pb-2">
            <Show
              when={ready() && props.mcp.length > 0}
              fallback={
                <div class="px-2 py-1.5 text-xs text-gray-9">
                  {fallbackText(props.state, props.error, "session.capabilities_no_mcp")}
                </div>
              }
            >
              <For each={props.mcp}>
                {(entry) => {
                  const detail = () => entry.statusDetail?.trim() || entry.detail?.trim() || "";
                  return (
                    <div class="flex min-w-0 items-start gap-2 rounded-lg px-2 py-1.5">
                      <span class={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusDotClass(entry.status)}`} />
                      <div class="min-w-0 flex-1">
                        <div class="flex min-w-0 items-center gap-1.5">
                          <span class="truncate text-xs font-medium text-gray-11" title={entry.name}>
                            {entry.name}
                          </span>
                          <span class="shrink-0 rounded-md border border-gray-6 bg-gray-2 px-1 py-0.5 text-[9px] font-medium uppercase text-gray-9">
                            {scopeLabel(entry.scope)}
                          </span>
                        </div>
                        <div class="flex min-w-0 items-center gap-1.5 text-[11px] text-gray-9">
                          <span class="shrink-0">{statusLabel(entry.status)}</span>
                          <Show when={detail()}>
                            {(text) => (
                              <span class="truncate" title={text()}>
                                {text()}
                              </span>
                            )}
                          </Show>
                        </div>
                      </div>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
        </Show>
      </section>
    </div>
  );
}
