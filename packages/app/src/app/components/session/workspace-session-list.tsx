import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Folder, HeartPulse, List, Loader2, MoreHorizontal, Plus, Search, Trash2 } from "lucide-solid";

import type { VesloSoulStatus } from "../../lib/veslo-server";
import type { WorkspaceInfo } from "../../lib/tauri";
import type { WorkspaceConnectionState, WorkspaceSessionGroup } from "../../types";
import {
  formatRelativeTime,
  getWorkspaceTaskLoadErrorDisplay,
  isWindowsPlatform,
} from "../../utils";
import {
  buildProjectGroups,
  buildRecentRows,
  displayTimestamp,
  isProjectCollapsed,
  toggleProjectCollapsed,
  type FlatSessionRow,
  type ProjectSessionGroup,
} from "./workspace-session-list-model";
import { currentLocale, t } from "../../../i18n";

type Props = {
  workspaceSessionGroups: WorkspaceSessionGroup[];
  activeWorkspaceId: string;
  selectedSessionId: string | null;
  sessionStatusById?: Record<string, string>;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  newTaskDisabled: boolean;
  importingWorkspaceConfig: boolean;
  showRemoteActions?: boolean;
  soulStatusByWorkspaceId: Record<string, VesloSoulStatus | null>;
  isPrivateWorkspacePath?: (folder: string | null | undefined) => boolean;
  onActivateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  onDeleteSession?: (workspaceId: string, sessionId: string) => void;
  onCreateTaskInWorkspace: (workspaceId: string) => void;
  onOpenRenameWorkspace: (workspaceId: string) => void;
  onShareWorkspace: (workspaceId: string) => void;
  onOpenSoul: (workspaceId: string) => void;
  onRevealWorkspace: (workspaceId: string) => void;
  onRecoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onTestWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean | void;
  onEditWorkspaceConnection: (workspaceId: string) => void;
  onForgetWorkspace: (workspaceId: string) => void;
  onOpenCreateWorkspace: () => void;
  onOpenCreateRemoteWorkspace: () => void;
  onImportWorkspaceConfig: () => void;
  onQuickNewSession?: () => void;
  onOpenSessionSearch?: () => void;
};

type SidebarViewMode = "by-project" | "recent";

type WorkspaceMenuTarget = {
  workspaceId: string;
  anchorKey: string;
};

const SIDEBAR_VIEW_MODE_KEY = "veslo.sidebar-session-view.v1";

const readSidebarViewMode = (): SidebarViewMode => {
  if (typeof window === "undefined") return "by-project";
  try {
    const raw = window.localStorage.getItem(SIDEBAR_VIEW_MODE_KEY);
    return raw === "recent" ? "recent" : "by-project";
  } catch {
    return "by-project";
  }
};

const writeSidebarViewMode = (value: SidebarViewMode) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SIDEBAR_VIEW_MODE_KEY, value);
  } catch {
    // ignore
  }
};

const workspaceLabel = (workspace: WorkspaceInfo) =>
  workspace.displayName?.trim() ||
  workspace.vesloWorkspaceName?.trim() ||
  workspace.name?.trim() ||
  workspace.directory?.trim() ||
  workspace.path?.trim() ||
  t("sidebar.workspace_fallback", currentLocale());

const workspaceKindLabel = (workspace: WorkspaceInfo) =>
  workspace.workspaceType === "remote"
    ? workspace.sandboxBackend === "docker" ||
      Boolean(workspace.sandboxRunId?.trim()) ||
      Boolean(workspace.sandboxContainerName?.trim())
      ? t("sidebar.workspace_kind_sandbox", currentLocale())
      : t("sidebar.workspace_kind_remote", currentLocale())
    : t("sidebar.workspace_kind_local", currentLocale());

export default function WorkspaceSessionList(props: Props) {
  const tr = (key: string) => t(key, currentLocale());
  const revealLabel = isWindowsPlatform() ? tr("sidebar.reveal_in_explorer") : tr("sidebar.reveal_in_finder");
  const [sidebarModeSignal, setSidebarModeSignal] = createSignal<SidebarViewMode>(readSidebarViewMode());
  const [collapsedProjects, setCollapsedProjects] = createSignal<Record<string, boolean>>({});
  const [workspaceMenuTarget, setWorkspaceMenuTarget] = createSignal<WorkspaceMenuTarget | null>(null);
  const [addWorkspaceMenuOpen, setAddWorkspaceMenuOpen] = createSignal(false);
  let workspaceMenuRef: HTMLDivElement | undefined;
  let addWorkspaceMenuRef: HTMLDivElement | undefined;

  const sidebarMode = createMemo(() => sidebarModeSignal());
  const setSidebarMode = (value: SidebarViewMode) => {
    setSidebarModeSignal(value);
    writeSidebarViewMode(value);
  };
  const toggleProjectCollapse = (projectKey: string) =>
    setCollapsedProjects((previous) => toggleProjectCollapsed(previous, projectKey));

  const recentRows = createMemo<FlatSessionRow[]>(() =>
    buildRecentRows(props.workspaceSessionGroups, props.isPrivateWorkspacePath),
  );

  const projectGroups = createMemo<ProjectSessionGroup[]>(() =>
    buildProjectGroups(props.workspaceSessionGroups, props.isPrivateWorkspacePath),
  );

  const emptyError = createMemo(() => {
    const failedGroup = props.workspaceSessionGroups.find((group) => group.status === "error");
    if (!failedGroup) return null;
    return getWorkspaceTaskLoadErrorDisplay(failedGroup.workspace, failedGroup.error);
  });

  const anyWorkspaceLoading = createMemo(() =>
    props.workspaceSessionGroups.some((group) => group.status === "loading"),
  );

  const hasVisibleRows = createMemo(() =>
    sidebarMode() === "by-project" ? projectGroups().length > 0 : recentRows().length > 0,
  );

  createEffect(() => {
    if (!workspaceMenuTarget()) return;
    const closeMenu = (event: PointerEvent) => {
      if (!workspaceMenuRef) return;
      const target = event.target as Node | null;
      if (target && workspaceMenuRef.contains(target)) return;
      setWorkspaceMenuTarget(null);
    };
    window.addEventListener("pointerdown", closeMenu);
    onCleanup(() => window.removeEventListener("pointerdown", closeMenu));
  });

  createEffect(() => {
    if (!addWorkspaceMenuOpen()) return;
    const closeMenu = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (addWorkspaceMenuRef && target && addWorkspaceMenuRef.contains(target)) return;
      setAddWorkspaceMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeMenu);
    onCleanup(() => window.removeEventListener("pointerdown", closeMenu));
  });

  const workspaceMenuOpen = (anchorKey: string) => workspaceMenuTarget()?.anchorKey === anchorKey;

  const connectionStateFor = (workspaceId: string) =>
    props.workspaceConnectionStateById[workspaceId] ?? { status: "idle", message: null };

  const isConnectingWorkspace = (workspaceId: string) => props.connectingWorkspaceId === workspaceId;

  const isConnectionActionBusyFor = (workspaceId: string) =>
    isConnectingWorkspace(workspaceId) || connectionStateFor(workspaceId).status === "connecting";

  const canRecoverWorkspace = (workspace: WorkspaceInfo) =>
    workspace.workspaceType === "remote" && connectionStateFor(workspace.id).status === "error";

  const taskLoadErrorFor = (workspace: WorkspaceInfo, error: string | null) =>
    getWorkspaceTaskLoadErrorDisplay(workspace, error);

  const workspaceMenu = (
    workspace: WorkspaceInfo,
    anchorKey: string,
    soulEnabled: boolean,
    canRecover: boolean,
    isConnectionActionBusy: boolean,
  ) => {
    const allowRemoteActions = props.showRemoteActions !== false;
    return (
      <Show when={workspaceMenuOpen(anchorKey)}>
        <div
          ref={(el) => (workspaceMenuRef = el)}
          class="absolute right-0 top-[calc(100%+4px)] z-20 w-44 rounded-lg border border-gray-6 bg-gray-1 shadow-lg p-1"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
            onClick={() => {
              props.onOpenRenameWorkspace(workspace.id);
              setWorkspaceMenuTarget(null);
            }}
          >
            {tr("sidebar.edit_name")}
          </button>
          <button
            type="button"
            class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
            onClick={() => {
              props.onShareWorkspace(workspace.id);
              setWorkspaceMenuTarget(null);
            }}
          >
            {tr("sidebar.share")}
          </button>
          <button
            type="button"
            class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
            onClick={() => {
              props.onOpenSoul(workspace.id);
              setWorkspaceMenuTarget(null);
            }}
          >
            {soulEnabled ? tr("sidebar.soul_settings") : tr("sidebar.enable_soul")}
          </button>
          <Show when={workspace.workspaceType === "local"}>
            <button
              type="button"
              class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
              onClick={() => {
                props.onRevealWorkspace(workspace.id);
                setWorkspaceMenuTarget(null);
              }}
            >
              {revealLabel}
            </button>
          </Show>
          <Show when={workspace.workspaceType === "remote" && allowRemoteActions}>
            <Show when={canRecover}>
              <button
                type="button"
                class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
                onClick={() => {
                  void Promise.resolve(props.onRecoverWorkspace(workspace.id));
                  setWorkspaceMenuTarget(null);
                }}
                disabled={isConnectionActionBusy}
              >
                {tr("sidebar.recover")}
              </button>
            </Show>
            <button
              type="button"
              class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
              onClick={() => {
                void Promise.resolve(props.onTestWorkspaceConnection(workspace.id));
                setWorkspaceMenuTarget(null);
              }}
              disabled={isConnectionActionBusy}
            >
              {tr("sidebar.test_connection")}
            </button>
            <button
              type="button"
              class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
              onClick={() => {
                props.onEditWorkspaceConnection(workspace.id);
                setWorkspaceMenuTarget(null);
              }}
              disabled={isConnectionActionBusy}
            >
              {tr("sidebar.edit_connection")}
            </button>
          </Show>
          <button
            type="button"
            class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3 text-red-11"
            onClick={() => {
              props.onForgetWorkspace(workspace.id);
              setWorkspaceMenuTarget(null);
            }}
          >
            {tr("sidebar.remove_workspace")}
          </button>
        </div>
      </Show>
    );
  };

  const emptyState = (
    <Show
      when={anyWorkspaceLoading()}
      fallback={
        <Show
          when={emptyError()}
          fallback={<div class="px-2 py-1.5 text-xs text-gray-10">{tr("sidebar.no_sessions")}</div>}
        >
          {(errorDisplay) => (
            <div
              class={`px-2 py-1.5 text-xs rounded-lg border ${
                errorDisplay().tone === "offline"
                  ? "text-amber-11 bg-amber-3 border-amber-7"
                  : "text-red-11 bg-red-3 border-red-7"
              }`}
              title={errorDisplay().title}
            >
              {errorDisplay().message}
            </div>
          )}
        </Show>
      }
    >
      <div class="px-2 py-1.5 text-xs text-gray-10">{tr("sidebar.loading_tasks")}</div>
    </Show>
  );

  return (
    <>
      <div class="relative mb-3" ref={(el) => (addWorkspaceMenuRef = el)}>
        <button
          type="button"
          class="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-[13px] font-medium text-gray-11 border border-gray-6 bg-gray-1 hover:bg-gray-2 shadow-sm transition-colors"
          onClick={() => {
            if (props.onQuickNewSession) {
              props.onQuickNewSession();
              return;
            }
            setAddWorkspaceMenuOpen((prev) => !prev);
          }}
        >
          <Plus size={14} />
          {tr("sidebar.new_session")}
        </button>

        <Show when={!props.onQuickNewSession && addWorkspaceMenuOpen()}>
          <div class="absolute left-0 right-0 top-full mt-2 rounded-lg border border-gray-6 bg-gray-1 shadow-xl overflow-hidden z-20">
            <button
              type="button"
              class="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-11 hover:text-gray-12 hover:bg-gray-3 transition-colors"
              onClick={() => {
                props.onOpenCreateWorkspace();
                setAddWorkspaceMenuOpen(false);
              }}
            >
              <Plus size={12} />
              {tr("sidebar.new_worker")}
            </button>
            <Show when={props.showRemoteActions !== false}>
              <button
                type="button"
                class="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-11 hover:text-gray-12 hover:bg-gray-3 transition-colors"
                onClick={() => {
                  props.onOpenCreateRemoteWorkspace();
                  setAddWorkspaceMenuOpen(false);
                }}
              >
                <Plus size={12} />
                {tr("sidebar.connect_remote")}
              </button>
            </Show>
            <button
              type="button"
              class="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-11 hover:text-gray-12 hover:bg-gray-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              disabled={props.importingWorkspaceConfig}
              onClick={() => {
                props.onImportWorkspaceConfig();
                setAddWorkspaceMenuOpen(false);
              }}
            >
              <Plus size={12} />
              {tr("sidebar.import_config")}
            </button>
          </div>
        </Show>
      </div>

      <div class="mb-3 flex items-center gap-2">
        <div class="inline-flex items-center gap-1 rounded-full border border-gray-6 bg-gray-1 p-1 shadow-sm">
          <button
            type="button"
            class={`inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
              sidebarMode() === "by-project"
                ? "bg-gray-4/90 text-gray-12"
                : "text-gray-9 hover:bg-gray-3 hover:text-gray-11"
            }`}
            aria-label={tr("sidebar.by_project")}
            title={tr("sidebar.by_project")}
            aria-pressed={sidebarMode() === "by-project"}
            onClick={() => setSidebarMode("by-project")}
          >
            <Folder size={14} />
          </button>
          <button
            type="button"
            class={`inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
              sidebarMode() === "recent"
                ? "bg-gray-4/90 text-gray-12"
                : "text-gray-9 hover:bg-gray-3 hover:text-gray-11"
            }`}
            aria-label={tr("sidebar.recent")}
            title={tr("sidebar.recent")}
            aria-pressed={sidebarMode() === "recent"}
            onClick={() => setSidebarMode("recent")}
          >
            <List size={14} />
          </button>
        </div>
        <Show when={props.onOpenSessionSearch}>
          <button
            type="button"
            class="inline-flex h-9 w-9 items-center justify-center rounded-full border border-gray-6 bg-gray-1 text-gray-9 shadow-sm transition-colors hover:bg-gray-3 hover:text-gray-11"
            aria-label={tr("session.command_palette_search_sessions")}
            title={tr("session.command_palette_search_sessions")}
            onClick={() => props.onOpenSessionSearch?.()}
          >
            <Search size={14} />
          </button>
        </Show>
      </div>

      <div class="space-y-2.5 mb-3">
        <Show when={hasVisibleRows()} fallback={emptyState}>
          <Show when={sidebarMode() === "by-project"} fallback={
            <For each={recentRows()}>
              {(row) => {
                const workspace = () => row.workspace;
                const session = () => row.session;
                const isSelected = () => props.selectedSessionId === session().id;
                const isSessionActive = () => (props.sessionStatusById?.[session().id] ?? "idle") !== "idle";
                const isConnecting = () => isConnectingWorkspace(workspace().id);
                const canRecover = () => canRecoverWorkspace(workspace());
                const soulStatus = () => props.soulStatusByWorkspaceId[workspace().id] ?? null;
                const soulEnabled = () => Boolean(soulStatus()?.enabled);
                const taskLoadError = () => taskLoadErrorFor(workspace(), row.error);
                const anchorKey = `recent:${row.rowKey}`;
                const isConnectionActionBusy = () => isConnectionActionBusyFor(workspace().id);

                return (
                  <div class="relative group/session-row">
                    <button
                      type="button"
                      class={`w-full flex items-center min-h-11 px-3 rounded-xl text-left transition-colors pr-20 ${
                        isSelected() ? "bg-gray-4/90 text-gray-12" : "hover:bg-gray-3/70 text-gray-12"
                      }`}
                      onClick={() => props.onOpenSession(workspace().id, session().id)}
                    >
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-1.5 min-w-0">
                          <Show when={isSessionActive()}>
                            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-9" />
                          </Show>
                          <span class="text-[13px] text-gray-11 truncate font-medium">{session().title}</span>
                        </div>

                        <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-10 min-w-0">
                          <Show when={row.projectLabel}>
                            <span class="truncate">{row.projectLabel}</span>
                          </Show>
                          <Show when={row.projectLabel && workspace().workspaceType === "remote"}>
                            <span aria-hidden>•</span>
                          </Show>
                          <Show when={workspace().workspaceType === "remote"}>
                            <span>{workspaceKindLabel(workspace())}</span>
                          </Show>
                          <Show when={soulEnabled()}>
                            <span class="inline-flex items-center gap-1 rounded-full border border-ruby-7 bg-ruby-3 px-1.5 py-0.5 text-[10px] text-ruby-11">
                              <HeartPulse size={10} />
                              {tr("sidebar.soul_badge")}
                            </span>
                          </Show>
                          <Show when={isConnecting()}>
                            <Loader2 size={11} class="animate-spin text-gray-10" />
                          </Show>
                          <Show when={row.status === "error"}>
                            <span
                              class={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                                taskLoadError().tone === "offline"
                                  ? "border-amber-7 text-amber-11 bg-amber-3"
                                  : "border-red-7 text-red-11 bg-red-3"
                              }`}
                              title={taskLoadError().title}
                            >
                              {taskLoadError().label}
                            </span>
                          </Show>
                        </div>
                      </div>

                      <span class="ml-2 text-[11px] text-gray-9 whitespace-nowrap">
                        {formatRelativeTime(displayTimestamp(session()))}
                      </span>
                    </button>

                    <div class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover/session-row:opacity-100 group-focus-within/session-row:opacity-100 transition-opacity">
                      <Show when={props.onDeleteSession}>
                        <button
                          type="button"
                          class="p-1 rounded-md text-gray-9 hover:text-red-11 hover:bg-red-3/60"
                          onClick={(event) => {
                            event.stopPropagation();
                            props.onDeleteSession?.(workspace().id, session().id);
                          }}
                          aria-label={tr("session.delete_session_action")}
                          title={tr("session.delete_session_action")}
                        >
                          <Trash2 size={14} />
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="p-1 rounded-md text-gray-9 hover:text-gray-11 hover:bg-gray-4/80"
                        onClick={(event) => {
                          event.stopPropagation();
                          setWorkspaceMenuTarget((current) =>
                            current?.anchorKey === anchorKey ? null : { workspaceId: workspace().id, anchorKey },
                          );
                        }}
                        aria-label={tr("sidebar.workspace_options")}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    </div>

                    {workspaceMenu(
                      workspace(),
                      anchorKey,
                      soulEnabled(),
                      canRecover(),
                      isConnectionActionBusy(),
                    )}
                  </div>
                );
              }}
            </For>
          }>
            <For each={projectGroups()}>
              {(project) => {
                const workspace = () => project.workspace;
                const isActiveWorkspace = () => props.activeWorkspaceId === workspace().id;
                const isConnecting = () => isConnectingWorkspace(workspace().id);
                const canRecover = () => canRecoverWorkspace(workspace());
                const soulStatus = () => props.soulStatusByWorkspaceId[workspace().id] ?? null;
                const soulEnabled = () => Boolean(soulStatus()?.enabled);
                const taskLoadError = () => taskLoadErrorFor(workspace(), project.error);
                const isConnectionActionBusy = () => isConnectionActionBusyFor(workspace().id);
                const anchorKey = `project:${workspace().id}`;
                const collapsed = () => isProjectCollapsed(collapsedProjects(), project.key);

                return (
                  <div class="relative group">
                    <div class="flex items-start gap-2">
                      <button
                        type="button"
                        class={`min-w-0 flex-1 rounded-lg px-1.5 py-1 text-left transition-colors ${
                          isActiveWorkspace()
                            ? "text-gray-12"
                            : "text-gray-11 hover:text-gray-12 hover:bg-gray-2/70"
                        }`}
                        title={project.projectTitle}
                        aria-label={project.projectLabel ? `${tr("sidebar.open_project")} ${project.projectLabel}` : tr("sidebar.open_project")}
                        onClick={() => {
                          if (isConnectionActionBusy()) return;
                          if (isActiveWorkspace()) return;
                          void Promise.resolve(props.onActivateWorkspace(workspace().id));
                        }}
                        disabled={isConnectionActionBusy()}
                      >
                        <div class="flex items-center gap-2 min-w-0">
                          <Folder
                            size={13}
                            class="shrink-0 text-gray-8 cursor-pointer"
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleProjectCollapse(project.key);
                            }}
                          />
                          <span
                            class="truncate text-[12px] font-semibold text-gray-10 cursor-pointer"
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleProjectCollapse(project.key);
                            }}
                          >
                            {project.projectLabel}
                          </span>
                          <Show when={workspace().workspaceType === "remote"}>
                            <span class="shrink-0 text-[10px] text-gray-8 uppercase tracking-[0.12em]">
                              {workspaceKindLabel(workspace())}
                            </span>
                          </Show>
                          <Show when={soulEnabled()}>
                            <span class="inline-flex items-center gap-1 rounded-full border border-ruby-7 bg-ruby-3 px-1.5 py-0.5 text-[10px] text-ruby-11">
                              <HeartPulse size={10} />
                              {tr("sidebar.soul_badge")}
                            </span>
                          </Show>
                          <Show when={isConnecting()}>
                            <Loader2 size={11} class="animate-spin text-gray-10" />
                          </Show>
                          <Show when={project.status === "error"}>
                            <span
                              class={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                                taskLoadError().tone === "offline"
                                  ? "border-amber-7 text-amber-11 bg-amber-3"
                                  : "border-red-7 text-red-11 bg-red-3"
                              }`}
                              title={taskLoadError().title}
                            >
                              {taskLoadError().label}
                            </span>
                          </Show>
                        </div>
                      </button>

                      <div class="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          class="p-1 rounded-md text-gray-8 hover:text-gray-11 hover:bg-gray-3"
                          onClick={() => props.onCreateTaskInWorkspace(workspace().id)}
                          disabled={props.newTaskDisabled}
                          aria-label={tr("sidebar.create_session_in_project")}
                          title={tr("sidebar.create_session_in_project")}
                        >
                          <Plus size={14} />
                        </button>
                        <button
                          type="button"
                          class="p-1 rounded-md text-gray-8 hover:text-gray-11 hover:bg-gray-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                          onClick={(event) => {
                            event.stopPropagation();
                            setWorkspaceMenuTarget((current) =>
                              current?.anchorKey === anchorKey ? null : { workspaceId: workspace().id, anchorKey },
                            );
                          }}
                          aria-label={tr("sidebar.workspace_options")}
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      </div>
                    </div>

                    <Show when={!collapsed()}>
                      <div class="pl-5 pt-1 space-y-1">
                        <For each={project.sessions}>
                          {(row) => {
                            const session = () => row.session;
                            const isSelected = () => props.selectedSessionId === session().id;
                            const isSessionActive = () =>
                              (props.sessionStatusById?.[session().id] ?? "idle") !== "idle";

                            return (
                              <div class="relative group/session-row">
                                <button
                                  type="button"
                                  class={`w-full flex items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors pr-10 ${
                                    isSelected() ? "bg-gray-4/90 text-gray-12" : "hover:bg-gray-3/70 text-gray-12"
                                  }`}
                                  onClick={() => props.onOpenSession(row.workspace.id, session().id)}
                                >
                                  <div class="min-w-0 flex-1">
                                    <div class="flex items-center gap-1.5 min-w-0">
                                      <Show when={isSessionActive()}>
                                        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-9" />
                                      </Show>
                                      <span class="text-[13px] text-gray-11 truncate font-medium">
                                        {session().title}
                                      </span>
                                    </div>
                                  </div>

                                  <span class="text-[11px] text-gray-9 whitespace-nowrap">
                                    {formatRelativeTime(displayTimestamp(session()))}
                                  </span>
                                </button>

                                <Show when={props.onDeleteSession}>
                                  <div class="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover/session-row:opacity-100 group-focus-within/session-row:opacity-100 transition-opacity">
                                    <button
                                      type="button"
                                      class="p-1 rounded-md text-gray-9 hover:text-red-11 hover:bg-red-3/60"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        props.onDeleteSession?.(row.workspace.id, session().id);
                                      }}
                                      aria-label={tr("session.delete_session_action")}
                                      title={tr("session.delete_session_action")}
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                </Show>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    </Show>

                    {workspaceMenu(
                      workspace(),
                      anchorKey,
                      soulEnabled(),
                      canRecover(),
                      isConnectionActionBusy(),
                    )}
                  </div>
                );
              }}
            </For>
          </Show>
        </Show>
      </div>
    </>
  );
}
