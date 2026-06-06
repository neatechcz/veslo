import { For, Show, createMemo } from "solid-js";
import { AlertTriangle, Building2, CheckCircle2, HeartPulse, LockKeyhole, RefreshCw, User, Warehouse } from "lucide-solid";

import type { VesloSoulOverviewResponse, VesloSoulSummary } from "../lib/veslo-server";
import { formatRelativeTime } from "../utils";
import { currentLocale, t } from "../../i18n";

type SoulViewProps = {
  soulOverview: VesloSoulOverviewResponse | null;
  soulOverviewError: string | null;
  soulOverviewBusy: boolean;
  refresh: (options?: { force?: boolean }) => void;
};

const relativeTime = (value?: string | null) => {
  if (!value) return t("soul.not_available", currentLocale());
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return formatRelativeTime(parsed);
};

const versionLabel = (summary: VesloSoulSummary) =>
  summary.currentVersionId?.trim() || t("soul.not_available", currentLocale());

const sourceName = (summary: VesloSoulSummary) =>
  summary.title?.trim() || summary.ownerId?.trim() || t("soul.not_available", currentLocale());

export default function SoulView(props: SoulViewProps) {
  const translate = (key: string) => t(key, currentLocale());

  const organizationSummary = createMemo(() => props.soulOverview?.organization ?? null);
  const userSummary = createMemo(() => props.soulOverview?.user ?? null);
  const workspaceSummaries = createMemo(() => props.soulOverview?.workspaces ?? []);

  const statusLabel = (status: string) => {
    switch (status) {
      case "active":
        return translate("soul.status_active");
      case "pending":
        return translate("soul.status_pending");
      case "conflict":
        return translate("soul.status_conflict");
      case "not_configured":
        return translate("soul.status_not_configured");
      default:
        return status || translate("soul.not_available");
    }
  };

  const statusTone = (status: string) => {
    switch (status) {
      case "active":
        return "border-emerald-7/50 bg-emerald-3/30 text-emerald-11";
      case "pending":
        return "border-blue-7/50 bg-blue-3/30 text-blue-11";
      case "conflict":
        return "border-red-7/50 bg-red-3/30 text-red-11";
      case "not_configured":
        return "border-gray-6 bg-gray-2 text-gray-10";
      default:
        return "border-amber-7/50 bg-amber-3/30 text-amber-11";
    }
  };

  const editabilityLabel = (summary: VesloSoulSummary) =>
    summary.canEdit ? translate("soul.editable") : translate("soul.read_only");

  const heartbeatLabel = (summary: VesloSoulSummary) =>
    summary.heartbeatEnabled ? translate("soul.heartbeat_enabled") : translate("soul.heartbeat_disabled");

  const sourceCard = (input: {
    testId: string;
    label: string;
    description: string;
    icon: typeof Building2;
    summary: () => VesloSoulSummary | null;
  }) => {
    const Icon = input.icon;

    return (
      <article data-testid={input.testId} class="rounded-xl border border-dls-border bg-dls-surface p-4">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <Icon size={16} class="shrink-0 text-dls-secondary" />
              <h3 class="text-sm font-semibold text-dls-text">{input.label}</h3>
            </div>
            <p class="mt-1 text-xs text-dls-secondary">{input.description}</p>
          </div>
          <Show when={input.summary()}>
            {(summary) => (
              <span class={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusTone(summary().status)}`}>
                {statusLabel(summary().status)}
              </span>
            )}
          </Show>
        </div>

        <Show
          when={input.summary()}
          fallback={
            <div class="mt-4 rounded-lg border border-dls-border bg-dls-hover/30 px-3 py-3 text-sm text-dls-secondary">
              {translate("soul.not_available")}
            </div>
          }
        >
          {(summary) => (
            <div class="mt-4 grid gap-3 sm:grid-cols-2">
              <div class="min-w-0">
                <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{translate("soul.source")}</div>
                <div class="mt-1 truncate text-sm text-dls-text">{sourceName(summary())}</div>
              </div>
              <div>
                <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{translate("soul.access")}</div>
                <div class="mt-1 flex items-center gap-1.5 text-sm text-dls-text">
                  <Show when={summary().canEdit} fallback={<LockKeyhole size={13} class="text-dls-secondary" />}>
                    <CheckCircle2 size={13} class="text-emerald-11" />
                  </Show>
                  {editabilityLabel(summary())}
                </div>
              </div>
              <div>
                <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{translate("soul.updated")}</div>
                <div class="mt-1 text-sm text-dls-text">{relativeTime(summary().updatedAt)}</div>
              </div>
              <div class="min-w-0">
                <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{translate("soul.current_version")}</div>
                <div class="mt-1 truncate text-sm text-dls-text">{versionLabel(summary())}</div>
              </div>
            </div>
          )}
        </Show>
      </article>
    );
  };

  return (
    <section class="space-y-6">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="space-y-2">
          <div class="flex items-center gap-2">
            <HeartPulse size={18} class="text-dls-secondary" />
            <h2 class="text-xl font-semibold text-dls-text">{translate("soul.source_title")}</h2>
          </div>
          <p class="max-w-2xl text-sm text-dls-secondary">{translate("soul.source_subtitle")}</p>
        </div>
        <button
          type="button"
          class={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            props.soulOverviewBusy
              ? "border-gray-6 text-gray-8"
              : "border-dls-border text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
          }`}
          disabled={props.soulOverviewBusy}
          onClick={() => props.refresh({ force: true })}
        >
          <RefreshCw size={14} class={props.soulOverviewBusy ? "animate-spin" : ""} />
          {props.soulOverviewBusy ? translate("soul.refreshing") : translate("soul.refresh")}
        </button>
      </header>

      <Show when={props.soulOverviewBusy}>
        <div class="rounded-xl border border-blue-7/40 bg-blue-3/20 px-4 py-3 text-sm text-blue-11">
          {translate("soul.loading_overview")}
        </div>
      </Show>

      <Show when={props.soulOverviewError}>
        {(error) => (
          <div class="flex items-start gap-2 rounded-xl border border-red-7/40 bg-red-3/40 px-4 py-3 text-sm text-red-11">
            <AlertTriangle size={15} class="mt-0.5 shrink-0" />
            <span>{error()}</span>
          </div>
        )}
      </Show>

      <div class="grid gap-4 lg:grid-cols-2">
        {sourceCard({
          testId: "soul-organization-source",
          label: translate("soul.organization_source"),
          description: translate("soul.organization_description"),
          icon: Building2,
          summary: organizationSummary,
        })}
        {sourceCard({
          testId: "soul-user-source",
          label: translate("soul.user_source"),
          description: translate("soul.user_description"),
          icon: User,
          summary: userSummary,
        })}
      </div>

      <section class="rounded-xl border border-dls-border bg-dls-surface">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-dls-border px-4 py-3">
          <div class="flex items-center gap-2">
            <Warehouse size={16} class="text-dls-secondary" />
            <h3 class="text-sm font-semibold text-dls-text">{translate("soul.workspace_sources")}</h3>
          </div>
          <div class="text-xs text-dls-secondary">
            {translate("soul.workspace_count").replace("{count}", String(workspaceSummaries().length))}
          </div>
        </div>

        <Show
          when={workspaceSummaries().length > 0}
          fallback={<div class="px-4 py-8 text-sm text-dls-secondary">{translate("soul.empty_workspaces")}</div>}
        >
          <div class="overflow-x-auto">
            <table data-testid="soul-workspace-sources-table" class="min-w-full text-left text-sm">
              <thead class="border-b border-dls-border text-[11px] uppercase tracking-wide text-dls-secondary">
                <tr>
                  <th class="px-4 py-2 font-medium">{translate("soul.source")}</th>
                  <th class="px-4 py-2 font-medium">{translate("soul.status")}</th>
                  <th class="px-4 py-2 font-medium">{translate("soul.heartbeat")}</th>
                  <th class="px-4 py-2 font-medium">{translate("soul.updated")}</th>
                  <th class="px-4 py-2 font-medium">{translate("soul.current_version")}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-dls-border">
                <For each={workspaceSummaries()}>
                  {(summary) => (
                    <tr class="text-dls-text">
                      <td class="max-w-[16rem] px-4 py-3">
                        <div class="truncate font-medium">{sourceName(summary)}</div>
                        <div class="truncate text-xs text-dls-secondary">{summary.ownerId}</div>
                      </td>
                      <td class="px-4 py-3">
                        <span class={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusTone(summary.status)}`}>
                          {statusLabel(summary.status)}
                        </span>
                      </td>
                      <td class="whitespace-nowrap px-4 py-3 text-dls-secondary">{heartbeatLabel(summary)}</td>
                      <td class="whitespace-nowrap px-4 py-3 text-dls-secondary">{relativeTime(summary.updatedAt)}</td>
                      <td class="max-w-[12rem] truncate px-4 py-3 text-dls-secondary">{versionLabel(summary)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </section>
    </section>
  );
}
