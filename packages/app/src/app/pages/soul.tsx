import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  HeartPulse,
  History,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  Save,
  User,
  Warehouse,
  X,
} from "lucide-solid";

import type {
  VesloServerClient,
  VesloSoulAuthContext,
  VesloSoulOverviewResponse,
  VesloSoulSummary,
} from "../lib/veslo-server";
import type { WorkspaceInfo } from "../lib/tauri";
import { formatRelativeTime } from "../utils";
import { currentLocale, t } from "../../i18n";
import { createSoulEditorController, type SoulEditorSource } from "./soul-controller";

type SoulViewProps = {
  soulOverview: VesloSoulOverviewResponse | null;
  soulOverviewError: string | null;
  soulOverviewBusy: boolean;
  client: VesloServerClient | null;
  serverConnected: boolean;
  authContext: VesloSoulAuthContext;
  refresh: (options?: { force?: boolean }) => void;
  workspaces: WorkspaceInfo[];
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean;
};

type SoulSource = SoulEditorSource & {
  testId: string;
  label: string;
  description: string;
  icon: typeof Building2;
};

const relativeTime = (value?: string | null) => {
  if (!value) return t("soul.not_available", currentLocale());
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return formatRelativeTime(parsed);
};

const fullTime = (value?: string | null) => {
  if (!value) return t("soul.not_available", currentLocale());
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString(currentLocale());
};

const versionLabel = (summary?: VesloSoulSummary | null) =>
  summary?.currentVersionId?.trim() || t("soul.not_available", currentLocale());

const sourceName = (summary?: VesloSoulSummary | null) =>
  summary?.title?.trim() || summary?.ownerId?.trim() || t("soul.not_available", currentLocale());

export default function SoulView(props: SoulViewProps) {
  const translate = (key: string) => t(key, currentLocale());

  const organizationSummary = createMemo(() => props.soulOverview?.organization ?? null);
  const userSummary = createMemo(() => props.soulOverview?.user ?? null);
  const workspaceById = createMemo(() => new Map(props.workspaces.map((workspace) => [workspace.id, workspace])));
  const workspaceSummaries = createMemo(() =>
    (props.soulOverview?.workspaces ?? []).filter((summary) => {
      const workspace = workspaceById().get(summary.ownerId);
      return !(workspace?.workspaceType === "local" && props.isPrivateWorkspacePath(workspace.path));
    }),
  );
  const [openSourceKey, setOpenSourceKey] = createSignal<string | null>(null);

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

  const sourceOptions = createMemo<SoulSource[]>(() => [
    {
      key: "organization",
      scope: "organization",
      testId: "soul-organization-source",
      label: translate("soul.organization_source"),
      description: translate("soul.organization_description"),
      icon: Building2,
      summary: organizationSummary(),
    },
    {
      key: "user",
      scope: "user",
      testId: "soul-user-source",
      label: translate("soul.user_source"),
      description: translate("soul.user_description"),
      icon: User,
      summary: userSummary(),
    },
    ...workspaceSummaries().map((summary) => ({
      key: `workspace:${summary.ownerId}`,
      scope: "workspace" as const,
      workspaceId: summary.ownerId,
      testId: `soul-workspace-source-${summary.ownerId}`,
      label: sourceName(summary),
      description: summary.ownerId,
      icon: Warehouse,
      summary,
    })),
  ]);

  const primarySources = createMemo(() => sourceOptions().filter((source) => source.scope !== "workspace"));
  const workspaceSources = createMemo(() => sourceOptions().filter((source) => source.scope === "workspace"));
  const activeModalSource = createMemo(() => sourceOptions().find((source) => source.key === openSourceKey()) ?? null);
  const modalSourceOptions = createMemo(() => {
    const source = activeModalSource();
    return source ? [source] : [];
  });
  const openSoulModal = (sourceKey: string) => setOpenSourceKey(sourceKey);
  const closeSoulModal = () => setOpenSourceKey(null);

  createEffect(() => {
    const key = openSourceKey();
    if (key && !sourceOptions().some((source) => source.key === key)) {
      closeSoulModal();
    }
  });

  createEffect(() => {
    if (!activeModalSource() || typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeSoulModal();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  const controller = createSoulEditorController<SoulSource>({
    sources: modalSourceOptions,
    client: () => props.client,
    serverConnected: () => props.serverConnected,
    authContext: () => props.authContext,
    refresh: props.refresh,
    defaultChangeSummary: () => translate("soul.default_change_summary"),
    defaultRestoreSummary: () => translate("soul.restore_default_summary"),
    detailErrorMessage: () => translate("soul.detail_error"),
    historyErrorMessage: () => translate("soul.history_error"),
    previewErrorMessage: () => translate("soul.preview_error"),
  });

  const selectedSourceKey = controller.selectedSourceKey;
  const selectedSource = controller.selectedSource;
  const displaySummary = controller.displaySummary;
  const selectedVersionIsCurrent = controller.selectedVersionIsCurrent;
  const selectedCanEdit = controller.selectedCanEdit;
  const saveDisabled = controller.saveDisabled;
  const savePending = controller.selectedSavePending;
  const saveError = controller.selectedSaveError;
  const detailLoading = controller.detailLoading;
  const detailError = controller.detailError;
  const content = controller.content;
  const setContent = controller.setContent;
  const changeSummary = controller.changeSummary;
  const setChangeSummary = controller.setChangeSummary;
  const versions = controller.versions;
  const currentBaseVersionId = controller.currentBaseVersionId;
  const historyLoading = controller.historyLoading;
  const historyError = controller.historyError;
  const selectedVersionId = controller.selectedVersionId;
  const selectedVersion = controller.selectedVersion;
  const selectedVersionPreview = controller.selectedVersionPreview;
  const previewLoading = controller.previewLoading;
  const previewError = controller.previewError;
  const previewVersion = controller.previewVersion;
  const restoreChangeSummary = controller.restoreChangeSummary;
  const setRestoreChangeSummary = controller.setRestoreChangeSummary;
  const restorePendingVersionId = controller.selectedRestorePendingVersionId;
  const restoreError = controller.selectedRestoreError;
  const restoreDisabled = controller.restoreDisabled;
  const materializationDiagnostic = controller.materializationDiagnostic;
  const heartbeatPendingSourceKey = controller.heartbeatPendingSourceKey;
  const heartbeatError = controller.heartbeatError;
  const saveSelectedSoul = controller.saveSelectedSoul;
  const restoreSelectedVersion = controller.restoreSelectedVersion;
  const toggleWorkspaceHeartbeat = controller.toggleWorkspaceHeartbeat;

  const editabilityLabel = (summary?: VesloSoulSummary | null) =>
    (summary?.canEdit ?? selectedCanEdit()) ? translate("soul.editable") : translate("soul.read_only");

  const heartbeatLabel = (summary?: VesloSoulSummary | null) =>
    summary?.heartbeatEnabled ? translate("soul.heartbeat_enabled") : translate("soul.heartbeat_disabled");

  const metadataCell = (label: string, value: string) => (
    <div class="min-w-0">
      <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{label}</div>
      <div class="mt-1 truncate text-sm text-dls-text" title={value}>
        {value}
      </div>
    </div>
  );

  const sourceButton = (source: SoulSource) => {
    const Icon = source.icon;
    const selected = () => openSourceKey() === source.key;
    const summary = () => source.summary;

    return (
      <div
        data-testid={source.testId}
        class={`w-full rounded-xl border p-4 text-left ${
          selected()
            ? "border-blue-8 bg-blue-3/25"
            : "border-dls-border bg-dls-surface"
        }`}
      >
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <Icon size={16} class="shrink-0 text-dls-secondary" />
              <h3 class="text-sm font-semibold text-dls-text">{source.label}</h3>
            </div>
            <p class="mt-1 text-xs text-dls-secondary">{source.description}</p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <Show when={selected()}>
              <span class="rounded-full border border-blue-7/50 bg-blue-3/50 px-2 py-0.5 text-[11px] font-medium text-blue-11">
                {translate("soul.selected")}
              </span>
            </Show>
            <Show when={summary()}>
              {(current) => (
                <span class={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusTone(current().status)}`}>
                  {statusLabel(current().status)}
                </span>
              )}
            </Show>
          </div>
        </div>

        <Show
          when={summary()}
          fallback={
            <div class="mt-4 rounded-lg border border-dls-border bg-dls-hover/30 px-3 py-3 text-sm text-dls-secondary">
              {translate("soul.source_unavailable")}
            </div>
          }
        >
          {(current) => (
            <div class="mt-4 grid gap-3 sm:grid-cols-2">
              {metadataCell(translate("soul.source"), sourceName(current()))}
              <div>
                <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{translate("soul.access")}</div>
                <div class="mt-1 flex items-center gap-1.5 text-sm text-dls-text">
                  <Show when={current().canEdit} fallback={<LockKeyhole size={13} class="text-dls-secondary" />}>
                    <CheckCircle2 size={13} class="text-emerald-11" />
                  </Show>
                  {editabilityLabel(current())}
                </div>
              </div>
              {metadataCell(translate("soul.updated"), relativeTime(current().updatedAt))}
              {metadataCell(translate("soul.current_version"), versionLabel(current()))}
            </div>
          )}
        </Show>
        <div class="mt-4 flex justify-end">
          <button
            type="button"
            data-testid={
              source.scope === "organization"
                ? "soul-organization-source-open"
                : source.scope === "user"
                  ? "soul-user-source-open"
                  : `${source.testId}-open`
            }
            class="rounded-lg border border-dls-border px-2.5 py-1 text-xs font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            onClick={() => openSoulModal(source.key)}
          >
            {translate("soul.open_source")}
          </button>
        </div>
      </div>
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
        <For each={primarySources()}>{(source) => sourceButton(source)}</For>
      </div>

      <section class="rounded-xl border border-dls-border bg-dls-surface">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-dls-border px-4 py-3">
          <div class="flex items-center gap-2">
            <Warehouse size={16} class="text-dls-secondary" />
            <h3 class="text-sm font-semibold text-dls-text">{translate("soul.workspace_sources")}</h3>
          </div>
          <div class="text-xs text-dls-secondary">
            {translate("soul.workspace_count").replace("{count}", String(workspaceSources().length))}
          </div>
        </div>

        <Show
          when={workspaceSources().length > 0}
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
                  <th class="px-4 py-2 text-right font-medium">{translate("soul.actions")}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-dls-border">
                <For each={workspaceSources()}>
                  {(source) => {
                    const summary = source.summary;
                    return (
                      <tr class={openSourceKey() === source.key ? "bg-blue-3/20 text-dls-text" : "text-dls-text"}>
                        <td class="max-w-[16rem] px-4 py-3">
                          <div class="truncate font-medium">{sourceName(summary)}</div>
                          <div class="truncate text-xs text-dls-secondary">{summary?.ownerId}</div>
                        </td>
                        <td class="px-4 py-3">
                          <span class={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusTone(summary?.status ?? "")}`}>
                            {statusLabel(summary?.status ?? "")}
                          </span>
                        </td>
                        <td class="whitespace-nowrap px-4 py-3 text-dls-secondary">{heartbeatLabel(summary)}</td>
                        <td class="whitespace-nowrap px-4 py-3 text-dls-secondary">{relativeTime(summary?.updatedAt)}</td>
                        <td class="max-w-[12rem] truncate px-4 py-3 text-dls-secondary">{versionLabel(summary)}</td>
                        <td class="px-4 py-3 text-right">
                          <button
                            type="button"
                            data-testid={`${source.testId}-open`}
                            class="rounded-lg border border-dls-border px-2.5 py-1 text-xs font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
                            onClick={() => openSoulModal(source.key)}
                          >
                            {openSourceKey() === source.key ? translate("soul.selected") : translate("soul.open_source")}
                          </button>
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </section>

      <Show when={activeModalSource()}>
        {(modalSource) => (
          <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div
              data-testid="soul-source-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="soul-source-modal-title"
              class="flex max-h-[calc(100vh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-dls-border bg-dls-bg shadow-xl"
            >
              <div class="flex items-start justify-between gap-4 border-b border-dls-border bg-dls-surface px-4 py-3">
                <div class="min-w-0">
                  <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{translate("soul.source_details")}</div>
                  <h2 id="soul-source-modal-title" class="mt-1 truncate text-base font-semibold text-dls-text">
                    {modalSource().label}
                  </h2>
                </div>
                <button
                  type="button"
                  data-testid="soul-source-modal-close"
                  class="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-dls-border text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
                  aria-label={translate("common.close")}
                  onClick={closeSoulModal}
                >
                  <X size={16} />
                </button>
              </div>
              <div class="min-h-0 overflow-y-auto p-4">
                <div class="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.85fr)]">
        <section data-testid="soul-source-detail" class="rounded-xl border border-dls-border bg-dls-surface">
          <div class="flex flex-wrap items-start justify-between gap-3 border-b border-dls-border px-4 py-3">
            <div>
              <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{translate("soul.source_details")}</div>
              <h3 class="mt-1 text-base font-semibold text-dls-text">{selectedSource()?.label ?? translate("soul.detail_title")}</h3>
            </div>
            <Show when={displaySummary()}>
              {(summary) => (
                <span class={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusTone(summary().status)}`}>
                  {statusLabel(summary().status)}
                </span>
              )}
            </Show>
          </div>

          <div class="space-y-4 p-4">
            <Show when={!props.client || !props.serverConnected}>
              <div class="rounded-lg border border-amber-7/40 bg-amber-3/30 px-3 py-2 text-sm text-amber-11">
                {translate("soul.source_unavailable")}
              </div>
            </Show>

            <Show when={detailLoading()}>
              <div class="rounded-lg border border-blue-7/40 bg-blue-3/20 px-3 py-2 text-sm text-blue-11">
                {translate("soul.detail_loading")}
              </div>
            </Show>

            <Show when={detailError()}>
              {(error) => (
                <div class="flex items-start gap-2 rounded-lg border border-red-7/40 bg-red-3/40 px-3 py-2 text-sm text-red-11">
                  <AlertTriangle size={14} class="mt-0.5 shrink-0" />
                  <span>{error()}</span>
                </div>
              )}
            </Show>

            <Show when={saveError()}>
              {(error) => (
                <div class="flex items-start gap-2 rounded-lg border border-red-7/40 bg-red-3/40 px-3 py-2 text-sm text-red-11">
                  <AlertTriangle size={14} class="mt-0.5 shrink-0" />
                  <span>{error()}</span>
                </div>
              )}
            </Show>

            <Show when={materializationDiagnostic()}>
              {(diagnostic) => (
                <div data-testid="soul-materialization-diagnostics" class="space-y-2 rounded-lg border border-amber-7/40 bg-amber-3/25 px-3 py-3 text-sm text-amber-11">
                  <div class="font-medium">{translate("soul.materialization_status")}</div>
                  <div>{diagnostic().message}</div>
                  <Show when={diagnostic().requiresAction}>
                    {(requiresAction) => (
                      <div>
                        <span class="font-medium">{translate("soul.materialization_action")}: </span>
                        {requiresAction()}
                      </div>
                    )}
                  </Show>
                  <Show when={diagnostic().conflicts?.length}>
                    <div>
                      <div class="font-medium">{translate("soul.materialization_conflicts")}</div>
                      <ul class="mt-1 list-disc space-y-1 pl-5">
                        <For each={diagnostic().conflicts ?? []}>
                          {(conflict) => (
                            <li>
                              {conflict.relativePath || conflict.path}: {conflict.reason}
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  </Show>
                </div>
              )}
            </Show>

            <Show when={displaySummary()}>
              {(summary) => (
                <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {metadataCell(translate("soul.access"), editabilityLabel(summary()))}
                  {metadataCell(translate("soul.current_version"), versionLabel(summary()))}
                  {metadataCell(translate("soul.updated"), fullTime(summary().updatedAt))}
                  {metadataCell(translate("soul.updated_by"), summary().updatedBy?.trim() || translate("soul.not_available"))}
                </div>
              )}
            </Show>

            <Show when={selectedSource()?.scope === "workspace"}>
              <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dls-border bg-dls-hover/20 px-3 py-3">
                <div>
                  <div class="text-sm font-medium text-dls-text">{translate("soul.toggle_heartbeat")}</div>
                  <div class="text-xs text-dls-secondary">{translate("soul.workspace_heartbeat_description")}</div>
                  <Show when={heartbeatError()}>
                    {(error) => <div class="mt-1 text-xs text-red-11">{error()}</div>}
                  </Show>
                </div>
                <button
                  type="button"
                  data-testid="soul-workspace-heartbeat-toggle"
                  class="inline-flex items-center gap-2 rounded-lg border border-dls-border px-3 py-1.5 text-xs font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:border-gray-6 disabled:text-gray-8"
                  disabled={!props.client || !props.serverConnected || heartbeatPendingSourceKey() === selectedSourceKey()}
                  onClick={toggleWorkspaceHeartbeat}
                >
                  <HeartPulse size={14} class={heartbeatPendingSourceKey() === selectedSourceKey() ? "animate-pulse" : ""} />
                  {displaySummary()?.heartbeatEnabled ? translate("soul.turn_heartbeat_off") : translate("soul.turn_heartbeat_on")}
                </button>
              </div>
            </Show>

            <label class="block">
              <span class="text-sm font-medium text-dls-text">{translate("soul.editor_content")}</span>
              <textarea
                data-testid="soul-editor-content"
                class="mt-2 min-h-[20rem] w-full resize-y rounded-lg border border-dls-border bg-dls-bg px-3 py-3 font-mono text-sm leading-6 text-dls-text outline-none transition-colors focus:border-blue-8 read-only:text-dls-secondary"
                value={content()}
                placeholder={translate("soul.detail_empty")}
                readOnly={!selectedCanEdit() || detailLoading() || savePending()}
                onInput={(event) => setContent(event.currentTarget.value)}
              />
            </label>

            <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
              <label class="block">
                <span class="text-sm font-medium text-dls-text">{translate("soul.change_summary")}</span>
                <input
                  class="mt-2 w-full rounded-lg border border-dls-border bg-dls-bg px-3 py-2 text-sm text-dls-text outline-none transition-colors focus:border-blue-8 disabled:text-dls-secondary"
                  value={changeSummary()}
                  placeholder={translate("soul.change_summary_placeholder")}
                  disabled={!selectedCanEdit() || savePending()}
                  onInput={(event) => setChangeSummary(event.currentTarget.value)}
                />
              </label>
              <button
                type="button"
                data-testid="soul-save-button"
                class="inline-flex items-center justify-center gap-2 rounded-lg border border-blue-8 bg-blue-9 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-10 disabled:border-gray-6 disabled:bg-gray-4 disabled:text-gray-9"
                disabled={saveDisabled()}
                onClick={saveSelectedSoul}
              >
                <Save size={15} />
                {savePending() ? translate("soul.saving") : translate("soul.save_changes")}
              </button>
            </div>

            <Show when={!selectedCanEdit()}>
              <div class="text-xs text-dls-secondary">{translate("soul.save_blocked_read_only")}</div>
            </Show>
          </div>
        </section>

        <section data-testid="soul-version-history" class="rounded-xl border border-dls-border bg-dls-surface">
          <div class="flex items-center gap-2 border-b border-dls-border px-4 py-3">
            <History size={16} class="text-dls-secondary" />
            <h3 class="text-sm font-semibold text-dls-text">{translate("soul.history_title")}</h3>
          </div>

          <div class="space-y-4 p-4">
            <Show when={historyLoading()}>
              <div class="rounded-lg border border-blue-7/40 bg-blue-3/20 px-3 py-2 text-sm text-blue-11">
                {translate("soul.history_loading")}
              </div>
            </Show>
            <Show when={historyError()}>
              {(error) => (
                <div class="flex items-start gap-2 rounded-lg border border-red-7/40 bg-red-3/40 px-3 py-2 text-sm text-red-11">
                  <AlertTriangle size={14} class="mt-0.5 shrink-0" />
                  <span>{error()}</span>
                </div>
              )}
            </Show>

            <Show
              when={versions().length > 0}
              fallback={<div class="rounded-lg border border-dls-border bg-dls-hover/20 px-3 py-4 text-sm text-dls-secondary">{translate("soul.history_empty")}</div>}
            >
              <div class="max-h-[22rem] space-y-2 overflow-y-auto pr-1">
                <For each={versions()}>
                  {(version) => {
                    const isCurrent = () => version.id === currentBaseVersionId();
                    const selected = () => selectedVersionId() === version.id;
                    return (
                      <button
                        type="button"
                        class={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                          selected()
                            ? "border-blue-8 bg-blue-3/30"
                            : "border-dls-border bg-dls-bg hover:border-blue-7/50 hover:bg-dls-hover/40"
                        }`}
                        onClick={() => previewVersion(version.id)}
                      >
                        <div class="flex items-start justify-between gap-2">
                          <div class="min-w-0">
                            <div class="truncate text-sm font-medium text-dls-text">
                              {version.changeSummary?.trim() || version.id}
                            </div>
                            <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-dls-secondary">
                              <span>
                                {translate("soul.version_created")}: {relativeTime(version.createdAt)}
                              </span>
                              <span>
                                {translate("soul.version_source")}: {version.source}
                              </span>
                            </div>
                          </div>
                          <Show when={isCurrent()}>
                            <span class="shrink-0 rounded-full border border-emerald-7/50 bg-emerald-3/30 px-2 py-0.5 text-[11px] font-medium text-emerald-11">
                              {translate("soul.version_current")}
                            </span>
                          </Show>
                        </div>
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>

            <div class="rounded-lg border border-dls-border bg-dls-bg p-3">
              <div class="mb-2 flex items-center justify-between gap-3">
                <div class="text-sm font-medium text-dls-text">{translate("soul.preview_title")}</div>
                <Show when={selectedVersion()}>
                  {(version) => <div class="max-w-[12rem] truncate text-xs text-dls-secondary">{version().id}</div>}
                </Show>
              </div>

              <Show
                when={selectedVersionId()}
                fallback={<div class="py-8 text-center text-sm text-dls-secondary">{translate("soul.version_preview")}</div>}
              >
                <Show when={previewLoading()}>
                  <div class="mb-2 rounded-lg border border-blue-7/40 bg-blue-3/20 px-3 py-2 text-sm text-blue-11">
                    {translate("soul.preview_loading")}
                  </div>
                </Show>
                <Show when={previewError()}>
                  {(error) => (
                    <div class="mb-2 flex items-start gap-2 rounded-lg border border-red-7/40 bg-red-3/40 px-3 py-2 text-sm text-red-11">
                      <AlertTriangle size={14} class="mt-0.5 shrink-0" />
                      <span>{error()}</span>
                    </div>
                  )}
                </Show>
                <textarea
                  class="min-h-[12rem] w-full resize-y rounded-lg border border-dls-border bg-dls-surface px-3 py-3 font-mono text-xs leading-5 text-dls-text outline-none"
                  readonly
                  value={selectedVersionPreview()?.content ?? ""}
                />
                <label class="mt-3 block">
                  <span class="text-xs font-medium text-dls-text">{translate("soul.restore_change_summary")}</span>
                  <input
                    class="mt-1 w-full rounded-lg border border-dls-border bg-dls-surface px-3 py-2 text-sm text-dls-text outline-none transition-colors focus:border-blue-8 disabled:text-dls-secondary"
                    value={restoreChangeSummary()}
                    placeholder={translate("soul.restore_change_summary_placeholder")}
                    disabled={restoreDisabled()}
                    onInput={(event) => setRestoreChangeSummary(event.currentTarget.value)}
                  />
                </label>
                <Show when={restoreError()}>
                  {(error) => <div class="mt-2 text-xs text-red-11">{error()}</div>}
                </Show>
                <button
                  type="button"
                  data-testid="soul-restore-selected-version"
                  class="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-dls-border px-3 py-2 text-sm font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:border-gray-6 disabled:text-gray-8"
                  disabled={restoreDisabled()}
                  onClick={() => {
                    const versionId = selectedVersionId();
                    if (versionId) void restoreSelectedVersion(versionId);
                  }}
                >
                  <RotateCcw size={14} />
                  {restorePendingVersionId() ? translate("soul.restoring") : translate("soul.restore_selected")}
                </button>
              </Show>
            </div>
          </div>
        </section>
                </div>
              </div>
            </div>
          </div>
        )}
      </Show>
    </section>
  );
}
