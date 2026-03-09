import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { HeartPulse, Loader2, MoreHorizontal, Plus } from "lucide-solid";

import type { VesloSoulStatus } from "../../lib/veslo-server";
import type { WorkspaceInfo } from "../../lib/tauri";
import type { WorkspaceConnectionState, WorkspaceSessionGroup } from "../../types";
import { formatRelativeTime, getWorkspaceTaskLoadErrorDisplay, isWindowsPlatform } from "../../utils";

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
  onActivateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
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
};

type FlatSessionRow = {
  rowKey: string;
  workspace: WorkspaceInfo;
  session: WorkspaceSessionGroup["sessions"][number];
  status: WorkspaceSessionGroup["status"];
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

const workspaceLabel = (workspace: WorkspaceInfo) =>
  workspace.displayName?.trim() ||
  workspace.vesloWorkspaceName?.trim() ||
  workspace.name?.trim() ||
  workspace.path?.trim() ||
  "Worker";

const workspaceKindLabel = (workspace: WorkspaceInfo) =>
  workspace.workspaceType === "remote"
    ? workspace.sandboxBackend === "docker" ||
      Boolean(workspace.sandboxRunId?.trim()) ||
      Boolean(workspace.sandboxContainerName?.trim())
      ? "Sandbox"
      : "Remote"
    : "Local";

const creationTimestamp = (session: WorkspaceSessionGroup["sessions"][number]) =>
  session.time?.created ?? 0;

const updatedTimestamp = (session: WorkspaceSessionGroup["sessions"][number]) =>
  session.time?.updated ?? 0;

const displayTimestamp = (session: WorkspaceSessionGroup["sessions"][number]) =>
  session.time?.created ?? session.time?.updated ?? Date.now();

export default function WorkspaceSessionList(props: Props) {
  const revealLabel = isWindowsPlatform() ? "Reveal in Explorer" : "Reveal in Finder";
  const [workspaceMenuTarget, setWorkspaceMenuTarget] = createSignal<{
    workspaceId: string;
    rowKey: string;
  } | null>(null);
  const [addWorkspaceMenuOpen, setAddWorkspaceMenuOpen] = createSignal(false);
  let workspaceMenuRef: HTMLDivElement | undefined;
  let addWorkspaceMenuRef: HTMLDivElement | undefined;

  const sessionRows = createMemo<FlatSessionRow[]>(() => {
    const rows = props.workspaceSessionGroups.flatMap((group) =>
      group.sessions.map((session) => ({
        rowKey: `${group.workspace.id}:${session.id}`,
        workspace: group.workspace,
        session,
        status: group.status,
        error: group.error ?? null,
        createdAt: creationTimestamp(session),
        updatedAt: updatedTimestamp(session),
      })),
    );

    rows.sort((a, b) => {
      const byCreated = b.createdAt - a.createdAt;
      if (byCreated !== 0) return byCreated;

      const byUpdated = b.updatedAt - a.updatedAt;
      if (byUpdated !== 0) return byUpdated;

      return a.session.id.localeCompare(b.session.id);
    });

    return rows;
  });

  const emptyError = createMemo(() => {
    const failedGroup = props.workspaceSessionGroups.find((group) => group.status === "error");
    if (!failedGroup) return null;
    return getWorkspaceTaskLoadErrorDisplay(failedGroup.workspace, failedGroup.error);
  });

  const anyWorkspaceLoading = createMemo(() =>
    props.workspaceSessionGroups.some((group) => group.status === "loading"),
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

  return (
    <>
      <div class="space-y-1.5 mb-3">
        <Show
          when={sessionRows().length > 0}
          fallback={
            <Show
              when={anyWorkspaceLoading()}
              fallback={
                <Show
                  when={emptyError()}
                  fallback={<div class="px-2 py-1.5 text-xs text-gray-10">No sessions yet.</div>}
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
              <div class="px-2 py-1.5 text-xs text-gray-10">Loading tasks...</div>
            </Show>
          }
        >
          <For each={sessionRows()}>
            {(row) => {
              const workspace = () => row.workspace;
              const session = () => row.session;
              const isSelected = () => props.selectedSessionId === session().id;
              const isSessionActive = () => (props.sessionStatusById?.[session().id] ?? "idle") !== "idle";
              const isConnecting = () => props.connectingWorkspaceId === workspace().id;
              const connectionState = () =>
                props.workspaceConnectionStateById[workspace().id] ?? { status: "idle", message: null };
              const isConnectionActionBusy = () =>
                isConnecting() || connectionState().status === "connecting";
              const canRecover = () =>
                workspace().workspaceType === "remote" && connectionState().status === "error";
              const soulStatus = () => props.soulStatusByWorkspaceId[workspace().id] ?? null;
              const soulEnabled = () => Boolean(soulStatus()?.enabled);
              const taskLoadError = () => getWorkspaceTaskLoadErrorDisplay(workspace(), row.error);
              const isMenuOpen = () => workspaceMenuTarget()?.rowKey === row.rowKey;
              const allowRemoteActions = () => props.showRemoteActions !== false;

              return (
                <div class="relative group">
                  <div
                    role="button"
                    tabIndex={0}
                    class={`w-full flex items-center min-h-11 px-3 rounded-xl text-left transition-colors pr-16 ${
                      isSelected() ? "bg-gray-4/90 text-gray-12" : "hover:bg-gray-3/70 text-gray-12"
                    }`}
                    onClick={() => props.onOpenSession(workspace().id, session().id)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      if (event.isComposing || event.keyCode === 229) return;
                      event.preventDefault();
                      props.onOpenSession(workspace().id, session().id);
                    }}
                  >
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-1.5 min-w-0">
                        <Show when={isSessionActive()}>
                          <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-9" />
                        </Show>
                        <span class="text-[13px] text-gray-11 truncate font-medium">{session().title}</span>
                      </div>

                      <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-10 min-w-0">
                        <span class="truncate">{workspaceLabel(workspace())}</span>
                        <span aria-hidden>•</span>
                        <span>{workspaceKindLabel(workspace())}</span>
                        <Show when={soulEnabled()}>
                          <span class="inline-flex items-center gap-1 rounded-full border border-ruby-7 bg-ruby-3 px-1.5 py-0.5 text-[10px] text-ruby-11">
                            <HeartPulse size={10} />
                            Soul
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
                  </div>

                  <div class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                    <button
                      type="button"
                      class="p-1 rounded-md text-gray-9 hover:text-gray-11 hover:bg-gray-4/80"
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onCreateTaskInWorkspace(workspace().id);
                      }}
                      disabled={props.newTaskDisabled}
                      aria-label="New task"
                    >
                      <Plus size={14} />
                    </button>

                    <button
                      type="button"
                      class="p-1 rounded-md text-gray-9 hover:text-gray-11 hover:bg-gray-4/80"
                      onClick={(event) => {
                        event.stopPropagation();
                        setWorkspaceMenuTarget((current) =>
                          current?.rowKey === row.rowKey
                            ? null
                            : { workspaceId: workspace().id, rowKey: row.rowKey },
                        );
                      }}
                      aria-label="Worker options"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </div>

                  <Show when={isMenuOpen()}>
                    <div
                      ref={(el) => (workspaceMenuRef = el)}
                      class="absolute right-2 top-[calc(100%+4px)] z-20 w-44 rounded-lg border border-gray-6 bg-gray-1 shadow-lg p-1"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
                        onClick={() => {
                          props.onOpenRenameWorkspace(workspace().id);
                          setWorkspaceMenuTarget(null);
                        }}
                      >
                        Edit name
                      </button>
                      <button
                        type="button"
                        class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
                        onClick={() => {
                          props.onShareWorkspace(workspace().id);
                          setWorkspaceMenuTarget(null);
                        }}
                      >
                        Share...
                      </button>
                      <button
                        type="button"
                        class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
                        onClick={() => {
                          props.onOpenSoul(workspace().id);
                          setWorkspaceMenuTarget(null);
                        }}
                      >
                        {soulEnabled() ? "Soul settings" : "Enable soul"}
                      </button>
                      <Show when={workspace().workspaceType === "local"}>
                        <button
                          type="button"
                          class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
                          onClick={() => {
                            props.onRevealWorkspace(workspace().id);
                            setWorkspaceMenuTarget(null);
                          }}
                        >
                          {revealLabel}
                        </button>
                      </Show>
                      <Show when={workspace().workspaceType === "remote" && allowRemoteActions()}>
                        <Show when={canRecover()}>
                          <button
                            type="button"
                            class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
                            onClick={() => {
                              void Promise.resolve(props.onRecoverWorkspace(workspace().id));
                              setWorkspaceMenuTarget(null);
                            }}
                            disabled={isConnectionActionBusy()}
                          >
                            Recover
                          </button>
                        </Show>
                        <button
                          type="button"
                          class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
                          onClick={() => {
                            void Promise.resolve(props.onTestWorkspaceConnection(workspace().id));
                            setWorkspaceMenuTarget(null);
                          }}
                          disabled={isConnectionActionBusy()}
                        >
                          Test connection
                        </button>
                        <button
                          type="button"
                          class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
                          onClick={() => {
                            props.onEditWorkspaceConnection(workspace().id);
                            setWorkspaceMenuTarget(null);
                          }}
                          disabled={isConnectionActionBusy()}
                        >
                          Edit connection
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3 text-red-11"
                        onClick={() => {
                          props.onForgetWorkspace(workspace().id);
                          setWorkspaceMenuTarget(null);
                        }}
                      >
                        Remove workspace
                      </button>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>
      </div>

      <div class="relative" ref={(el) => (addWorkspaceMenuRef = el)}>
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
          New session
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
              New worker
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
                Connect remote
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
              Import config
            </button>
          </div>
        </Show>
      </div>
    </>
  );
}
