import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  HeartPulse,
  List,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
} from "lucide-solid";

import type { VesloSoulStatus } from "../../lib/veslo-server";
import type { WorkspaceInfo } from "../../lib/tauri";
import type {
  LoadedSessionPrefetchInterestChangeHandler,
  SidebarSubagentDecoration,
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../types";
import {
  getWorkspaceTaskLoadErrorDisplay,
  isWindowsPlatform,
} from "../../utils";
import {
  buildRowHierarchyLookup,
  buildProjectGroups,
  buildRecentRows,
  displayTimestamp,
  formatSessionRelativeAge,
  formatSessionTimestampTooltip,
  isProjectCollapsed,
  resolveSessionRowClickAction,
  requiredVisibleCountForExpandedSession,
  rowVisibleByExpansion,
  shouldShowNewSessionLabelText,
  shouldUseExpandedNewSessionLabel,
  splitSessionDisplayLabel,
  toggleProjectCollapsed,
  type FlatSessionRow,
  type ProjectSessionGroup,
} from "./workspace-session-list-model";
import {
  PROJECT_VISIBLE_DEFAULT,
  RECENT_ESTIMATED_ROW_HEIGHT,
  RECENT_LOAD_MORE_THRESHOLD_PX,
  VIEW_LOAD_MORE_STEP,
  computeInitialRecentVisibleCount,
  nextProjectVisibleCount,
  shouldLoadMoreRecentRowsOnScroll,
} from "./workspace-session-list-windowing";
import {
  applyProjectOrder,
  mergeVisibleOrder,
  type ProjectDropPosition,
  reorderProjectKeys,
} from "./workspace-session-list-order";
import { resolveRenderableProjectGroups } from "./workspace-session-list-render-model";
import {
  readCollapsedProjectMap,
  readProjectOrder,
  readShowArchivedSessions,
  readSidebarViewMode,
  writeCollapsedProjectMap,
  writeProjectOrder,
  writeShowArchivedSessions,
  writeSidebarViewMode,
  type SidebarViewMode,
} from "./workspace-session-list-prefs";
import { deriveLoadedSidebarPrefetchInterest } from "./workspace-session-list-prefetch-interest";
import { currentLocale, t } from "../../../i18n";

type Props = {
  workspaceSessionGroups: WorkspaceSessionGroup[];
  workspaceSessionPagingById?: Record<string, { hasMore: boolean; loadingMore: boolean }>;
  subagentDecorationsBySessionId?: Record<string, SidebarSubagentDecoration>;
  activeWorkspaceId: string;
  selectedSessionId: string | null;
  pendingSelectedSessionId?: string | null;
  pendingSelectedWorkspaceId?: string | null;
  suspendProjectReorder?: boolean;
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
  onAddDirectorySession?: () => void;
  onLoadMoreWorkspaceSessions?: (workspaceId: string) => Promise<boolean> | boolean | Promise<void> | void;
  archivedSessionIds?: string[];
  onArchiveSession?: (workspaceId: string, sessionId: string) => Promise<void> | void;
  onUnarchiveSession?: (workspaceId: string, sessionId: string) => Promise<void> | void;
  onLoadedSessionPrefetchInterestChange?: LoadedSessionPrefetchInterestChangeHandler;
};

type WorkspaceMenuTarget = {
  workspaceId: string;
  anchorKey: string;
};

type ProjectDropIndicator = {
  key: string;
  position: ProjectDropPosition;
};

type ProjectPointerDragState = {
  sourceKey: string;
  label: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
};

type ProjectDragPreviewState = {
  x: number;
  y: number;
  label: string;
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

const sidebarControlTooltipClass =
  "relative after:pointer-events-none after:absolute after:left-1/2 after:bottom-full after:z-30 after:mb-1 after:-translate-x-1/2 after:rounded-md after:border after:border-gray-6 after:bg-gray-1 after:px-2 after:py-1 after:text-[10px] after:font-medium after:leading-none after:text-gray-11 after:whitespace-nowrap after:opacity-0 after:shadow-lg after:transition-opacity after:duration-150 after:delay-[250ms] hover:after:opacity-100 focus-visible:after:opacity-100 after:content-[attr(data-tooltip)]";

export default function WorkspaceSessionList(props: Props) {
  const tr = (key: string) => t(key, currentLocale());
  const revealLabel = isWindowsPlatform() ? tr("sidebar.reveal_in_explorer") : tr("sidebar.reveal_in_finder");
  const [sidebarModeSignal, setSidebarModeSignal] = createSignal<SidebarViewMode>(readSidebarViewMode());
  const [collapsedProjects, setCollapsedProjects] = createSignal<Record<string, boolean>>(
    readCollapsedProjectMap(),
  );
  const [projectOrder, setProjectOrder] = createSignal<string[]>(readProjectOrder());
  const [projectVisibleByKey, setProjectVisibleByKey] = createSignal<Record<string, number>>({});
  const [recentVisibleCount, setRecentVisibleCount] = createSignal(3);
  const [recentLoadMoreBusy, setRecentLoadMoreBusy] = createSignal(false);
  const [expandedParentSessionIds, setExpandedParentSessionIds] = createSignal<Set<string>>(new Set());
  const [draggingProjectKey, setDraggingProjectKey] = createSignal<string | null>(null);
  const [dragOverProjectKey, setDragOverProjectKey] = createSignal<string | null>(null);
  const [projectDropIndicator, setProjectDropIndicator] = createSignal<ProjectDropIndicator | null>(null);
  const [projectPointerDrag, setProjectPointerDrag] = createSignal<ProjectPointerDragState | null>(null);
  const [projectDragPreview, setProjectDragPreview] = createSignal<ProjectDragPreviewState | null>(null);
  const [lastClickedSessionId, setLastClickedSessionId] = createSignal<string | null>(null);
  const [workspaceMenuTarget, setWorkspaceMenuTarget] = createSignal<WorkspaceMenuTarget | null>(null);
  const [addWorkspaceMenuOpen, setAddWorkspaceMenuOpen] = createSignal(false);
  const [showArchivedSessions, setShowArchivedSessions] = createSignal<boolean>(readShowArchivedSessions());
  const [pendingArchiveConfirmationSessionId, setPendingArchiveConfirmationSessionId] = createSignal<string | null>(
    null,
  );
  const [sidebarControlsWidth, setSidebarControlsWidth] = createSignal(0);
  let workspaceMenuRef: HTMLDivElement | undefined;
  let addWorkspaceMenuRef: HTMLDivElement | undefined;
  let pendingArchiveConfirmButtonRef: HTMLButtonElement | undefined;
  let sidebarControlsRef: HTMLDivElement | undefined;
  let scrollContainerRef: HTMLDivElement | undefined;
  let recentSentinelRef: HTMLDivElement | undefined;
  let projectDragPreviewElement: HTMLDivElement | null = null;

  const sidebarMode = createMemo(() => sidebarModeSignal());
  const setSidebarMode = (value: SidebarViewMode) => {
    setSidebarModeSignal(value);
    writeSidebarViewMode(value);
  };
  const toggleProjectCollapse = (projectKey: string) =>
    setCollapsedProjects((previous) => {
      const next = toggleProjectCollapsed(previous, projectKey);
      writeCollapsedProjectMap(next);
      return next;
    });
  const rowIndentStyle = (row: FlatSessionRow) =>
    row.nestingLevel > 0 ? { "padding-left": `${12 + Math.min(row.nestingLevel, 6) * 14}px` } : undefined;

  const archivedSessionIds = () => props.archivedSessionIds ?? [];
  const sessionWorkspaceById = createMemo(() => {
    const map = new Map<string, string>();
    for (const group of props.workspaceSessionGroups) {
      const workspaceId = group.workspace.id;
      for (const session of group.sessions) {
        map.set(session.id, workspaceId);
      }
    }
    return map;
  });
  const archivedSessionIdSet = createMemo(
    () => new Set(archivedSessionIds().map((sessionId) => sessionId.trim()).filter(Boolean)),
  );
  const isSessionArchived = (sessionId: string) => archivedSessionIdSet().has(sessionId.trim());
  const isArchiveConfirmationPending = (sessionId: string) =>
    pendingArchiveConfirmationSessionId() === sessionId.trim();
  const shouldShowSessionRow = (row: FlatSessionRow) =>
    showArchivedSessions() || !isSessionArchived(row.session.id);

  const recentRows = createMemo<FlatSessionRow[]>(() =>
    buildRecentRows(props.workspaceSessionGroups, props.isPrivateWorkspacePath),
  );
  const visibleRecentRows = createMemo<FlatSessionRow[]>(() =>
    recentRows().filter((row) => shouldShowSessionRow(row)),
  );

  const projectGroups = createMemo<ProjectSessionGroup[]>(() =>
    buildProjectGroups(props.workspaceSessionGroups, props.isPrivateWorkspacePath),
  );
  const visibleProjectGroups = createMemo<ProjectSessionGroup[]>(() =>
    projectGroups()
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((row) => shouldShowSessionRow(row)),
      }))
      .filter((group) => group.sessions.length > 0),
  );
  const orderedProjectGroups = createMemo(() => applyProjectOrder(visibleProjectGroups(), projectOrder()));
  const [frozenProjectGroups, setFrozenProjectGroups] = createSignal<ProjectSessionGroup[]>([]);
  const suspendProjectReorder = createMemo(() => Boolean(props.suspendProjectReorder));

  createEffect(() => {
    const next = orderedProjectGroups();
    const suspended = suspendProjectReorder();
    setFrozenProjectGroups((previous) =>
      resolveRenderableProjectGroups({
        suspended,
        previousGroups: previous,
        nextGroups: next,
      }),
    );
  });

  const renderProjectGroups = createMemo(() =>
    resolveRenderableProjectGroups({
      suspended: suspendProjectReorder(),
      previousGroups: frozenProjectGroups(),
      nextGroups: orderedProjectGroups(),
    }),
  );

  const recentHierarchy = createMemo(() => buildRowHierarchyLookup(visibleRecentRows()));

  const recentRowsTreeVisible = createMemo(() =>
    visibleRecentRows().filter((row) =>
      rowVisibleByExpansion(row, recentHierarchy(), expandedParentSessionIds()),
    ),
  );
  const recentRowsLoaded = createMemo(() => recentRowsTreeVisible());

  const recentRowsVisible = createMemo(() => recentRowsTreeVisible().slice(0, recentVisibleCount()));
  const projectRowsLoaded = createMemo<FlatSessionRow[]>(() => {
    const expandedParentIds = expandedParentSessionIds();
    return renderProjectGroups().flatMap((group) => {
      const projectHierarchy = buildRowHierarchyLookup(group.sessions);
      return group.sessions.filter((row) =>
        rowVisibleByExpansion(row, projectHierarchy, expandedParentIds),
      );
    });
  });
  const visibleProjectRows = createMemo<FlatSessionRow[]>(() => {
    const expandedParentIds = expandedParentSessionIds();
    const visibleByProject = projectVisibleByKey();
    return renderProjectGroups().flatMap((group) => {
      const projectHierarchy = buildRowHierarchyLookup(group.sessions);
      const projectTreeVisibleRows = group.sessions.filter((row) =>
        rowVisibleByExpansion(row, projectHierarchy, expandedParentIds),
      );
      const visibleCount = visibleByProject[group.key] ?? PROJECT_VISIBLE_DEFAULT;
      return projectTreeVisibleRows.slice(0, visibleCount);
    });
  });

  const recentHasHiddenRows = createMemo(() => recentRowsTreeVisible().length > recentVisibleCount());

  const recentHasMoreServerRows = createMemo(() =>
    Object.values(props.workspaceSessionPagingById ?? {}).some((entry) => entry.hasMore),
  );

  const recentCanLoadMore = createMemo(() => recentHasHiddenRows() || recentHasMoreServerRows());

  const recentLoadingMore = createMemo(() =>
    recentLoadMoreBusy() || Object.values(props.workspaceSessionPagingById ?? {}).some((entry) => entry.loadingMore),
  );

  const initialRecentVisibleCount = () =>
    computeInitialRecentVisibleCount(scrollContainerRef?.clientHeight ?? 0, RECENT_ESTIMATED_ROW_HEIGHT);

  const syncRecentVisibleFromViewport = () => {
    const initialVisible = initialRecentVisibleCount();
    setRecentVisibleCount((current) => Math.max(current, initialVisible));
  };

  const nextWorkspaceToLoadForRecent = () => {
    const paging = props.workspaceSessionPagingById ?? {};
    const active = props.activeWorkspaceId.trim();
    const workspaceIds = [
      active,
      ...Object.keys(paging).filter((workspaceId) => workspaceId !== active),
    ];
    return workspaceIds.find((workspaceId) => {
      const entry = paging[workspaceId];
      return Boolean(entry?.hasMore) && !entry.loadingMore;
    }) ?? null;
  };

  const loadMoreRecentRows = async () => {
    if (recentLoadMoreBusy()) return;
    if (recentHasHiddenRows()) {
      setRecentVisibleCount((current) =>
        Math.min(visibleRecentRows().length, current + VIEW_LOAD_MORE_STEP),
      );
      return;
    }
    if (!recentHasMoreServerRows() || !props.onLoadMoreWorkspaceSessions) return;

    const workspaceId = nextWorkspaceToLoadForRecent();
    if (!workspaceId) return;
    setRecentLoadMoreBusy(true);
    try {
      await Promise.resolve(props.onLoadMoreWorkspaceSessions(workspaceId));
      setRecentVisibleCount((current) =>
        Math.min(visibleRecentRows().length, current + VIEW_LOAD_MORE_STEP),
      );
    } finally {
      setRecentLoadMoreBusy(false);
    }
  };

  createEffect(() => {
    const nextGroups = visibleProjectGroups();
    setProjectVisibleByKey((current) => {
      const next: Record<string, number> = {};
      let changed = false;
      for (const group of nextGroups) {
        const previousValue = current[group.key];
        const normalized = Number.isFinite(previousValue) && (previousValue ?? 0) > 0
          ? Math.floor(previousValue as number)
          : PROJECT_VISIBLE_DEFAULT;
        next[group.key] = normalized;
        if (normalized !== previousValue) changed = true;
      }
      if (Object.keys(current).length !== Object.keys(next).length) changed = true;
      return changed ? next : current;
    });
  });

  createEffect(() => {
    props.activeWorkspaceId;
    setProjectVisibleByKey({});
    setRecentVisibleCount(initialRecentVisibleCount());
  });

  createEffect(() => {
    if (sidebarMode() !== "recent") return;
    syncRecentVisibleFromViewport();
  });

  createEffect(() => {
    if (sidebarMode() !== "recent") return;
    const container = scrollContainerRef;
    if (!container) return;

    syncRecentVisibleFromViewport();

    if (typeof ResizeObserver === "undefined") {
      const onResize = () => syncRecentVisibleFromViewport();
      window.addEventListener("resize", onResize);
      onCleanup(() => window.removeEventListener("resize", onResize));
      return;
    }

    const observer = new ResizeObserver(() => syncRecentVisibleFromViewport());
    observer.observe(container);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    if (sidebarMode() !== "recent") return;
    const sentinel = recentSentinelRef;
    const root = scrollContainerRef;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      void loadMoreRecentRows();
    }, {
      root,
      rootMargin: `${RECENT_LOAD_MORE_THRESHOLD_PX}px 0px`,
      threshold: 0,
    });

    observer.observe(sentinel);
    onCleanup(() => observer.disconnect());
  });

  const handleRecentScroll = (event: Event) => {
    if (sidebarMode() !== "recent") return;
    if (!recentCanLoadMore() || recentLoadingMore()) return;

    const currentTarget = event.currentTarget;
    if (!(currentTarget instanceof HTMLDivElement)) return;

    if (
      !shouldLoadMoreRecentRowsOnScroll(
        currentTarget.scrollTop,
        currentTarget.clientHeight,
        currentTarget.scrollHeight,
        RECENT_LOAD_MORE_THRESHOLD_PX,
      )
    ) {
      return;
    }

    void loadMoreRecentRows();
  };

  createEffect(() => {
    const element = sidebarControlsRef;
    if (!element) return;

    const measure = () => setSidebarControlsWidth(element.clientWidth ?? 0);
    measure();

    if (typeof ResizeObserver === "undefined") {
      const onResize = () => measure();
      window.addEventListener("resize", onResize);
      onCleanup(() => window.removeEventListener("resize", onResize));
      return;
    }

    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });

  const emptyError = createMemo(() => {
    const failedGroup = props.workspaceSessionGroups.find((group) => group.status === "error");
    if (!failedGroup) return null;
    return getWorkspaceTaskLoadErrorDisplay(failedGroup.workspace, failedGroup.error);
  });

  const anyWorkspaceLoading = createMemo(() =>
    props.workspaceSessionGroups.some((group) => group.status === "loading"),
  );

  const hasVisibleRows = createMemo(() =>
    sidebarMode() === "by-project" ? visibleProjectGroups().length > 0 : recentRowsTreeVisible().length > 0,
  );

  const sessionDecorationFor = (sessionId: string): SidebarSubagentDecoration | null => {
    const entry = props.subagentDecorationsBySessionId?.[sessionId];
    if (!entry) return null;
    const label = entry.label?.trim() ?? "";
    const color = entry.color?.trim() ?? "";
    if (!label || !color) return null;
    return { label, color };
  };

  const sessionLabelParts = (row: FlatSessionRow) => {
    const decorated = sessionDecorationFor(row.session.id)?.label;
    return splitSessionDisplayLabel(row.session.title, decorated);
  };

  const sessionLabelTitle = (row: FlatSessionRow) => sessionLabelParts(row).tooltip;

  const sessionLabelColor = (row: FlatSessionRow) => {
    const color = sessionDecorationFor(row.session.id)?.color?.trim() ?? "";
    if (!color || !row.isSubagent) return "";
    return color;
  };

  const isRowSelected = (workspaceId: string, sessionId: string) => {
    const selectedSessionId = props.selectedSessionId?.trim() ?? "";
    if (selectedSessionId && selectedSessionId === sessionId) return true;

    const pendingSessionId = props.pendingSelectedSessionId?.trim() ?? "";
    if (!pendingSessionId || pendingSessionId !== sessionId) return false;

    const pendingWorkspaceId = props.pendingSelectedWorkspaceId?.trim() ?? "";
    return !pendingWorkspaceId || pendingWorkspaceId === workspaceId;
  };

  const ensureExpandedSessionChildrenVisible = (
    sessionId: string,
    expandedParentSessionIds: ReadonlySet<string>,
  ) => {
    if (sidebarMode() === "recent") {
      const required = requiredVisibleCountForExpandedSession(
        visibleRecentRows(),
        expandedParentSessionIds,
        sessionId,
      );
      if (required == null) return;
      setRecentVisibleCount((current) => Math.max(current, required));
      return;
    }

    const groups = renderProjectGroups();
    for (const group of groups) {
      if (!group.sessions.some((row) => row.session.id === sessionId)) continue;
      const required = requiredVisibleCountForExpandedSession(
        group.sessions,
        expandedParentSessionIds,
        sessionId,
      );
      if (required == null) return;
      setProjectVisibleByKey((current) => {
        const baseline = current[group.key] ?? PROJECT_VISIBLE_DEFAULT;
        if (baseline >= required) return current;
        return {
          ...current,
          [group.key]: required,
        };
      });
      return;
    }
  };

  const toggleExpandedParentSession = (sessionId: string) =>
    setExpandedParentSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
        ensureExpandedSessionChildrenVisible(sessionId, next);
      }
      return next;
    });

  const handleSessionRowClick = (
    row: FlatSessionRow,
    hasChildren: (sessionId: string) => boolean,
  ) => {
    setLastClickedSessionId(row.session.id);
    const action = resolveSessionRowClickAction({
      selectedSessionId: props.selectedSessionId,
      clickedSessionId: row.session.id,
      hasChildren: hasChildren(row.session.id),
    });

    if (action.toggleExpandedParent) {
      toggleExpandedParentSession(row.session.id);
    }
    if (action.openSession) {
      props.onOpenSession(row.workspace.id, row.session.id);
    }
  };

  const handleSessionRowKeyDown = (
    event: KeyboardEvent,
    row: FlatSessionRow,
    hasChildren: (sessionId: string) => boolean,
  ) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleSessionRowClick(row, hasChildren);
  };

  const isParentExpanded = (sessionId: string) => expandedParentSessionIds().has(sessionId.trim());

  const sessionBranchToggleLabel = (sessionId: string) =>
    isParentExpanded(sessionId) ? tr("sidebar.collapse_session_branch") : tr("sidebar.expand_session_branch");

  const handleSessionExpandToggle = (event: MouseEvent, sessionId: string) => {
    event.stopPropagation();
    const normalizedId = sessionId.trim();
    if (!normalizedId) return;
    toggleExpandedParentSession(normalizedId);
  };

  const sessionBranchToggle = (sessionId: string, hasChildren: boolean) => {
    if (!hasChildren) return null;

    return (
      <div class="pointer-events-none absolute left-1/2 top-[1.375rem] -translate-x-1/2 -translate-y-1/2">
        <button
          type="button"
          class="pointer-events-auto inline-flex h-4 w-4 items-center justify-center rounded-[4px] text-gray-9 transition-colors hover:bg-gray-4/70 hover:text-gray-11 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-7"
          aria-label={sessionBranchToggleLabel(sessionId)}
          title={sessionBranchToggleLabel(sessionId)}
          onClick={(event) => handleSessionExpandToggle(event, sessionId)}
        >
          <Show when={isParentExpanded(sessionId)} fallback={<ChevronRight size={12} />}>
            <ChevronDown size={12} />
          </Show>
        </button>
      </div>
    );
  };

  const handleSessionArchiveAction = async (event: MouseEvent, sessionId: string) => {
    event.stopPropagation();
    const id = sessionId.trim();
    if (!id) return;
    const archived = isSessionArchived(id);
    const workspaceId = sessionWorkspaceById().get(id) ?? "";
    if (!workspaceId) return;

    if (archived) {
      await Promise.resolve(props.onUnarchiveSession?.(workspaceId, id));
      return;
    }

    if (!isArchiveConfirmationPending(id)) {
      if (event.currentTarget instanceof HTMLButtonElement) {
        pendingArchiveConfirmButtonRef = event.currentTarget;
      }
      setPendingArchiveConfirmationSessionId(id);
      return;
    }

    setPendingArchiveConfirmationSessionId(null);
    await Promise.resolve(props.onArchiveSession?.(workspaceId, id));
  };

  const toggleShowArchived = () => {
    setShowArchivedSessions((current) => {
      const next = !current;
      writeShowArchivedSessions(next);
      return next;
    });
  };

  const handleSessionRowContextMenu = (
    event: MouseEvent,
    workspaceId: string,
    anchorKey: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setWorkspaceMenuTarget({ workspaceId, anchorKey });
  };

  const PROJECT_POINTER_DRAG_START_THRESHOLD_PX = 2;

  const clearProjectDragState = () => {
    if (projectDragPreviewElement) {
      projectDragPreviewElement.remove();
      projectDragPreviewElement = null;
    }
    setDraggingProjectKey(null);
    setDragOverProjectKey(null);
    setProjectDropIndicator(null);
    setProjectDragPreview(null);
  };

  const applyProjectReorder = (
    sourceKeyRaw: string,
    targetKeyRaw: string,
    dropPosition: ProjectDropPosition = "before",
  ) => {
    const sourceKey = sourceKeyRaw.trim();
    const targetKey = targetKeyRaw.trim();
    if (!sourceKey || !targetKey || sourceKey === targetKey) return;

    const visibleKeys = orderedProjectGroups().map((group) => group.key);
    const reorderedVisibleKeys = reorderProjectKeys(visibleKeys, sourceKey, targetKey, dropPosition);
    const mergedProjectOrder = mergeVisibleOrder(projectOrder(), reorderedVisibleKeys);
    setProjectOrder(mergedProjectOrder);
    writeProjectOrder(mergedProjectOrder);
  };

  const resolveProjectDropIndicatorFromPoint = (
    clientX: number,
    clientY: number,
    sourceProjectKey: string,
  ): ProjectDropIndicator | null => {
    if (typeof document === "undefined") return null;
    const hit = document.elementFromPoint(clientX, clientY);
    const targetNode = hit instanceof HTMLElement ? hit.closest("[data-project-key]") : null;
    if (!(targetNode instanceof HTMLElement)) {
      return null;
    }

    const targetKey = targetNode.dataset.projectKey?.trim() ?? "";
    if (!targetKey || targetKey === sourceProjectKey) {
      return null;
    }

    const rect = targetNode.getBoundingClientRect();
    const position: ProjectDropPosition = clientY < rect.top + rect.height / 2 ? "before" : "after";
    return { key: targetKey, position };
  };

  const updateProjectDropIndicatorFromPoint = (
    clientX: number,
    clientY: number,
    sourceProjectKey: string,
  ) => {
    const indicator = resolveProjectDropIndicatorFromPoint(clientX, clientY, sourceProjectKey);
    if (!indicator) {
      setDragOverProjectKey(null);
      setProjectDropIndicator(null);
      return;
    }

    const { key, position } = indicator;
    setDragOverProjectKey(key);
    setProjectDropIndicator({ key, position });
  };

  const handleProjectDragStart = (event: DragEvent, projectKey: string) => {
    setProjectPointerDrag(null);
    setProjectDragPreview(null);
    setDragOverProjectKey(null);
    setProjectDropIndicator(null);
    const key = projectKey.trim();
    if (!key) return;
    event.dataTransfer?.setData("text/plain", key);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      const target = event.currentTarget;
      if (target instanceof HTMLElement) {
        const previewSource = target.closest("[data-project-drag-preview]");
        if (previewSource instanceof HTMLElement) {
          const preview = previewSource.cloneNode(true);
          if (preview instanceof HTMLDivElement) {
            preview.style.position = "fixed";
            preview.style.top = "-9999px";
            preview.style.left = "-9999px";
            preview.style.margin = "0";
            preview.style.pointerEvents = "none";
            preview.style.opacity = "0.98";
            preview.style.width = `${Math.max(previewSource.getBoundingClientRect().width, 220)}px`;
            preview.style.boxShadow = "0 10px 28px rgba(0, 0, 0, 0.28)";
            preview.style.zIndex = "2147483647";
            document.body.appendChild(preview);
            projectDragPreviewElement = preview;

            const rect = previewSource.getBoundingClientRect();
            const offsetX = Math.min(24, Math.max(8, rect.width / 10));
            const offsetY = Math.min(20, Math.max(8, rect.height / 2));
            event.dataTransfer.setDragImage(preview, offsetX, offsetY);
          }
        }
      }
    }
    setDraggingProjectKey(key);
  };

  const handleProjectDragOver = (event: DragEvent, projectKey: string) => {
    if (!draggingProjectKey()) return;
    event.preventDefault();
    const normalizedProjectKey = projectKey.trim();
    if (!normalizedProjectKey) return;
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    const currentTarget = event.currentTarget;
    let position: ProjectDropPosition = "before";
    if (currentTarget instanceof HTMLElement) {
      const rect = currentTarget.getBoundingClientRect();
      position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    }

    setDragOverProjectKey(normalizedProjectKey);
    setProjectDropIndicator({ key: normalizedProjectKey, position });
  };

  const handleProjectDragLeave = (event: DragEvent, projectKey: string) => {
    const key = projectKey.trim();
    if (!key) return;
    const currentTarget = event.currentTarget;
    const relatedTarget = event.relatedTarget;
    if (
      currentTarget instanceof HTMLElement &&
      relatedTarget instanceof Node &&
      currentTarget.contains(relatedTarget)
    ) {
      return;
    }
    if (dragOverProjectKey() === key) {
      setDragOverProjectKey(null);
    }
    if (projectDropIndicator()?.key === key) {
      setProjectDropIndicator(null);
    }
  };

  const handleProjectDrop = (event: DragEvent, targetKey: string) => {
    event.preventDefault();
    const sourceKey = (draggingProjectKey() ?? event.dataTransfer?.getData("text/plain") ?? "").trim();
    const normalizedTargetKey = targetKey.trim();
    if (!sourceKey || !normalizedTargetKey) {
      clearProjectDragState();
      return;
    }
    if (sourceKey === normalizedTargetKey) {
      clearProjectDragState();
      return;
    }

    const dropPosition = projectDropIndicator()?.key === normalizedTargetKey
      ? projectDropIndicator()?.position ?? "before"
      : "before";
    applyProjectReorder(sourceKey, normalizedTargetKey, dropPosition);
    clearProjectDragState();
  };

  const handleProjectDragEnd = () => {
    clearProjectDragState();
  };

  const handleProjectPointerDown = (
    event: PointerEvent,
    projectKey: string,
    projectLabel: string,
  ) => {
    if (event.button !== 0 && event.button !== -1) return;
    const sourceKey = projectKey.trim();
    if (!sourceKey) return;

    const label = projectLabel.trim() || sourceKey;
    setProjectPointerDrag({
      sourceKey,
      label,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    });
  };

  const handleProjectPointerMove = (event: PointerEvent) => {
    const drag = projectPointerDrag();
    if (!drag || event.pointerId !== drag.pointerId) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const movedEnough = (deltaX * deltaX) + (deltaY * deltaY) >= PROJECT_POINTER_DRAG_START_THRESHOLD_PX ** 2;
    const active = drag.active || movedEnough;
    if (!active) return;

    if (!drag.active) {
      setProjectPointerDrag({ ...drag, active: true });
      setDraggingProjectKey(drag.sourceKey);
    }

    event.preventDefault();
    setProjectDragPreview({
      x: event.clientX,
      y: event.clientY,
      label: drag.label,
    });
    updateProjectDropIndicatorFromPoint(event.clientX, event.clientY, drag.sourceKey);
  };

  const finishProjectPointerDrag = (event: PointerEvent) => {
    const drag = projectPointerDrag();
    if (!drag || event.pointerId !== drag.pointerId) return;

    if (drag.active) {
      const indicator = resolveProjectDropIndicatorFromPoint(event.clientX, event.clientY, drag.sourceKey) ??
        projectDropIndicator();
      if (indicator && indicator.key !== drag.sourceKey) {
        applyProjectReorder(drag.sourceKey, indicator.key, indicator.position);
      }
    }

    setProjectPointerDrag(null);
    clearProjectDragState();
  };

  createEffect(() => {
    const drag = projectPointerDrag();
    if (!drag) return;

    const onPointerMove = (event: PointerEvent) => handleProjectPointerMove(event);
    const onPointerUp = (event: PointerEvent) => finishProjectPointerDrag(event);
    const onPointerCancel = (event: PointerEvent) => finishProjectPointerDrag(event);

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);

    onCleanup(() => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    });
  });

  createEffect(() => {
    const validSessionIds = new Set(
      projectRowsLoaded().flatMap((row) => [row.session.id]),
    );
    for (const row of recentRowsLoaded()) validSessionIds.add(row.session.id);
    const pendingId = pendingArchiveConfirmationSessionId();
    if (pendingId && !validSessionIds.has(pendingId)) {
      setPendingArchiveConfirmationSessionId(null);
    }

    setExpandedParentSessionIds((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (validSessionIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  });

  const lastReportedLoadedInterestByWorkspace = new Map<string, string>();

  createEffect(() => {
    const callback = props.onLoadedSessionPrefetchInterestChange;
    if (!callback) return;

    const currentRows = sidebarMode() === "by-project" ? visibleProjectRows() : recentRowsVisible();
    const loadedTopLevelRows = currentRows
      .filter((row) => row.nestingLevel === 0)
      .map((row) => ({
        workspaceId: row.workspace.id,
        sessionId: row.session.id,
        updatedAt: row.updatedAt,
      }));
    const expandedSubagentRows = currentRows
      .filter((row) => row.nestingLevel > 0)
      .map((row) => ({
        workspaceId: row.workspace.id,
        sessionId: row.session.id,
        updatedAt: row.updatedAt,
      }));
    const loadedInterest = deriveLoadedSidebarPrefetchInterest({
      selectedSessionId: props.selectedSessionId?.trim() || null,
      clickedSessionId: lastClickedSessionId(),
      loadedTopLevelRows,
      expandedSubagentRows,
    });
    const currentWorkspaceIds = new Set(props.workspaceSessionGroups.map((group) => group.workspace.id));

    for (const workspaceId of currentWorkspaceIds) {
      const interest = loadedInterest.get(workspaceId) ?? {
        clickedSessionId: null,
        selectedSessionId: null,
        loadedTopLevelSessionIds: [],
        expandedSubagentSessionIds: [],
      };
      const signature = JSON.stringify(interest);
      if (lastReportedLoadedInterestByWorkspace.get(workspaceId) === signature) continue;
      lastReportedLoadedInterestByWorkspace.set(workspaceId, signature);
      callback(workspaceId, interest);
    }

    for (const workspaceId of Array.from(lastReportedLoadedInterestByWorkspace.keys())) {
      if (currentWorkspaceIds.has(workspaceId)) continue;
      lastReportedLoadedInterestByWorkspace.delete(workspaceId);
      callback(workspaceId, {
        clickedSessionId: null,
        selectedSessionId: null,
        loadedTopLevelSessionIds: [],
        expandedSubagentSessionIds: [],
      });
    }
  });

  onCleanup(() => {
    if (!props.onLoadedSessionPrefetchInterestChange) return;
    for (const workspaceId of Array.from(lastReportedLoadedInterestByWorkspace.keys())) {
      props.onLoadedSessionPrefetchInterestChange?.(workspaceId, {
        clickedSessionId: null,
        selectedSessionId: null,
        loadedTopLevelSessionIds: [],
        expandedSubagentSessionIds: [],
      });
    }
    lastReportedLoadedInterestByWorkspace.clear();
  });

  const showNewSessionLabelText = createMemo(() =>
    shouldShowNewSessionLabelText(sidebarControlsWidth()),
  );

  const newSessionLabel = createMemo(() => {
    if (!showNewSessionLabelText()) return "";
    return shouldUseExpandedNewSessionLabel(sidebarControlsWidth()) ? tr("sidebar.new_session") : tr("sidebar.new");
  });

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
    const pendingArchiveId = pendingArchiveConfirmationSessionId();
    if (!pendingArchiveId) {
      pendingArchiveConfirmButtonRef = undefined;
      return;
    }
    const cancelPendingArchive = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (pendingArchiveConfirmButtonRef && target && pendingArchiveConfirmButtonRef.contains(target)) return;
      setPendingArchiveConfirmationSessionId(null);
    };
    window.addEventListener("pointerdown", cancelPendingArchive);
    onCleanup(() => window.removeEventListener("pointerdown", cancelPendingArchive));
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
    <div class="flex h-full min-h-0 flex-col">
      <div class="mb-3 flex flex-nowrap items-center gap-1" ref={(el) => (sidebarControlsRef = el)}>
        <div class="relative flex min-w-0 flex-1" ref={(el) => (addWorkspaceMenuRef = el)}>
          <button
            type="button"
            class={`inline-flex h-8 w-full min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-gray-6 bg-gray-1 px-2 text-[12px] font-medium text-gray-11 shadow-sm transition-colors hover:bg-gray-2 ${sidebarControlTooltipClass}`}
            data-tooltip={tr("sidebar.new_session")}
            onClick={() => {
              if (props.onQuickNewSession) {
                props.onQuickNewSession();
                return;
              }
              setAddWorkspaceMenuOpen((prev) => !prev);
            }}
          >
            <span class="sr-only">{tr("sidebar.new_session")}</span>
            <Plus size={12} />
            <Show when={showNewSessionLabelText()}>
              <span class="whitespace-nowrap">{newSessionLabel()}</span>
            </Show>
          </button>

          <Show when={!props.onQuickNewSession && addWorkspaceMenuOpen()}>
            <div class="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-lg border border-gray-6 bg-gray-1 shadow-xl">
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
        <div class="inline-flex shrink-0 items-center gap-1 rounded-full border border-gray-6 bg-gray-1 p-0.5 shadow-sm">
          <button
            type="button"
            class={`inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
              sidebarMode() === "by-project"
                ? "bg-gray-4/90 text-gray-12"
                : "text-gray-9 hover:bg-gray-3 hover:text-gray-11"
            } ${sidebarControlTooltipClass}`}
            data-tooltip={tr("sidebar.by_project")}
            aria-pressed={sidebarMode() === "by-project"}
            onClick={() => setSidebarMode("by-project")}
          >
            <span class="sr-only">{tr("sidebar.by_project")}</span>
            <Folder size={14} />
          </button>
          <button
            type="button"
            class={`inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
              sidebarMode() === "recent"
                ? "bg-gray-4/90 text-gray-12"
                : "text-gray-9 hover:bg-gray-3 hover:text-gray-11"
            } ${sidebarControlTooltipClass}`}
            data-tooltip={tr("sidebar.recent")}
            aria-pressed={sidebarMode() === "recent"}
            onClick={() => setSidebarMode("recent")}
          >
            <span class="sr-only">{tr("sidebar.recent")}</span>
            <List size={14} />
          </button>
        </div>
        <div class="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            class={`inline-flex h-8 w-8 items-center justify-center rounded-full border border-gray-6 bg-gray-1 shadow-sm transition-colors ${sidebarControlTooltipClass} ${
              showArchivedSessions()
                ? "text-gray-12 bg-gray-4/90"
                : "text-gray-9 hover:bg-gray-3 hover:text-gray-11"
            }`}
            data-tooltip={tr("sidebar.show_archived")}
            aria-pressed={showArchivedSessions()}
            onClick={toggleShowArchived}
          >
            <span class="sr-only">{tr("sidebar.show_archived")}</span>
            <Archive size={13} />
          </button>
          <Show when={props.onOpenSessionSearch}>
            <button
              type="button"
              class={`inline-flex h-8 w-8 items-center justify-center rounded-full border border-gray-6 bg-gray-1 text-gray-9 shadow-sm transition-colors hover:bg-gray-3 hover:text-gray-11 ${sidebarControlTooltipClass}`}
              data-tooltip={tr("session.command_palette_search_sessions")}
              onClick={() => props.onOpenSessionSearch?.()}
            >
              <span class="sr-only">{tr("session.command_palette_search_sessions")}</span>
              <Search size={13} />
            </button>
          </Show>
          <Show when={props.onAddDirectorySession}>
            <button
              type="button"
              class={`inline-flex h-8 w-8 items-center justify-center rounded-full border border-gray-6 bg-gray-1 text-gray-9 shadow-sm transition-colors hover:bg-gray-3 hover:text-gray-11 disabled:opacity-60 disabled:cursor-not-allowed ${sidebarControlTooltipClass}`}
              data-tooltip={tr("sidebar.add_directory_session")}
              disabled={props.newTaskDisabled}
              onClick={() => props.onAddDirectorySession?.()}
            >
              <span class="sr-only">{tr("sidebar.add_directory_session")}</span>
              <FolderPlus size={13} />
            </button>
          </Show>
        </div>
      </div>

      <div
        class="min-h-0 flex-1 overflow-y-auto -mr-3 pr-3"
        ref={(el) => (scrollContainerRef = el)}
        onScroll={handleRecentScroll}
      >
        <div class="space-y-1.5 mb-2">
          <Show when={hasVisibleRows()} fallback={emptyState}>
            <Show when={sidebarMode() === "by-project"} fallback={
              <>
                <div class="space-y-0">
                  <For each={recentRowsVisible()}>
                    {(row) => {
                      const workspace = () => row.workspace;
                      const session = () => row.session;
                      const hasChildren = (sessionId: string) =>
                        (recentHierarchy().childrenByParentId.get(sessionId)?.length ?? 0) > 0;
                      const isSelected = () => isRowSelected(workspace().id, session().id);
                      const isSessionActive = () => (props.sessionStatusById?.[session().id] ?? "idle") !== "idle";
                      const isConnecting = () => isConnectingWorkspace(workspace().id);
                      const canRecover = () => canRecoverWorkspace(workspace());
                      const soulStatus = () => props.soulStatusByWorkspaceId[workspace().id] ?? null;
                      const soulEnabled = () => Boolean(soulStatus()?.enabled);
                      const taskLoadError = () => taskLoadErrorFor(workspace(), row.error);
                      const label = () => sessionLabelParts(row);
                      const labelColor = () => sessionLabelColor(row);
                      const archiveConfirmationPending = () => isArchiveConfirmationPending(session().id);
                      const anchorKey = `recent:${row.rowKey}`;
                      const isConnectionActionBusy = () => isConnectionActionBusyFor(workspace().id);

                      return (
                        <div
                          class="relative group/session-row"
                          onContextMenu={(event) => handleSessionRowContextMenu(event, workspace().id, anchorKey)}
                        >
                          <div
                            role="button"
                            tabIndex={0}
                            class={`w-full flex items-center rounded-xl px-3 py-1 pr-12 text-left transition-colors ${
                              isSelected() ? "bg-gray-4/90 text-gray-12" : "hover:bg-gray-3/70 text-gray-12"
                            }`}
                            style={rowIndentStyle(row)}
                            onClick={() => handleSessionRowClick(row, hasChildren)}
                            onKeyDown={(event) => handleSessionRowKeyDown(event, row, hasChildren)}
                          >
                            <div class="relative min-w-0 flex-1">
                              {sessionBranchToggle(session().id, hasChildren(session().id))}
                              <div class="flex items-center gap-1.5 min-w-0">
                                <Show when={isSessionActive()}>
                                  <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-9" />
                                </Show>
                                <span
                                  class="text-[13px] text-gray-11 truncate font-medium"
                                  title={sessionLabelTitle(row)}
                                >
                                  <Show when={label().decoratedName} fallback={label().description ?? ""}>
                                    {(decoratedName) => (
                                      <>
                                        <span style={labelColor() ? { color: labelColor() } : undefined}>
                                          {decoratedName()}
                                        </span>
                                        <Show when={label().description}>
                                          {(description) => <span>{` · ${description()}`}</span>}
                                        </Show>
                                      </>
                                    )}
                                  </Show>
                                </span>
                              </div>

                              <div class="mt-px flex items-center gap-1 text-[11px] text-gray-10 min-w-0">
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
                          </div>

                          <span
                            class="pointer-events-none absolute right-2 bottom-1 text-[11px] text-gray-9 whitespace-nowrap transition-opacity group-hover/session-row:opacity-0 group-focus-within/session-row:opacity-0"
                            title={formatSessionTimestampTooltip(displayTimestamp(session()), currentLocale())}
                          >
                            {formatSessionRelativeAge(displayTimestamp(session()))}
                          </span>

                          <div
                            class={`absolute right-2 bottom-1 transition-opacity ${
                              archiveConfirmationPending()
                                ? "opacity-100"
                                : "opacity-0 group-hover/session-row:opacity-100 group-focus-within/session-row:opacity-100"
                            }`}
                          >
                            <button
                              type="button"
                              class={archiveConfirmationPending()
                                ? "rounded-md border border-amber-7 bg-amber-3 px-2 py-0.5 text-[11px] font-medium text-amber-11 hover:bg-amber-4"
                                : "p-1 rounded-md text-gray-9 hover:text-gray-11 hover:bg-gray-4/80"}
                              onClick={(event) => handleSessionArchiveAction(event, session().id)}
                              aria-label={archiveConfirmationPending()
                                ? tr("sidebar.archive_confirm")
                                : isSessionArchived(session().id)
                                ? tr("sidebar.unarchive_session")
                                : tr("sidebar.archive_session")}
                              title={archiveConfirmationPending()
                                ? tr("sidebar.archive_confirm")
                                : isSessionArchived(session().id)
                                ? tr("sidebar.unarchive_session")
                                : tr("sidebar.archive_session")}
                              ref={(el) => {
                                if (archiveConfirmationPending()) pendingArchiveConfirmButtonRef = el;
                              }}
                            >
                              <Show when={archiveConfirmationPending()} fallback={<Archive size={14} />}>
                                {tr("sidebar.archive_confirm")}
                              </Show>
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
                </div>
                <Show when={sidebarMode() === "recent"}>
                  <div ref={(el) => (recentSentinelRef = el)} class="h-0.5 w-full" />
                </Show>
                <Show when={sidebarMode() === "recent" && recentCanLoadMore()}>
                  <div>
                    <button
                      type="button"
                      class="w-full inline-flex items-center gap-1 rounded-xl px-3 py-1 text-left text-[11px] text-gray-9 transition-colors hover:bg-gray-3/70 hover:text-gray-11 disabled:opacity-60 disabled:cursor-not-allowed"
                      disabled={recentLoadingMore()}
                      onClick={() => {
                        void loadMoreRecentRows();
                      }}
                    >
                      <span aria-hidden>{tr("sidebar.more_ellipsis")}</span>
                      <span>{recentLoadingMore() ? tr("sidebar.loading_more") : tr("sidebar.load_more")}</span>
                    </button>
                  </div>
                </Show>
              </>
            }>
              <For each={renderProjectGroups()}>
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
                const projectDragLabel = () =>
                  project.projectLabel || project.projectTitle || tr("sidebar.open_project");
                const isProjectDragOver = () => dragOverProjectKey() === project.key;
                const isDraggedProject = () => draggingProjectKey() === project.key;
                const dropIndicatorPosition = () =>
                  projectDropIndicator()?.key === project.key ? projectDropIndicator()?.position : null;
                const collapsed = () => isProjectCollapsed(collapsedProjects(), project.key);
                const projectPaging = () =>
                  props.workspaceSessionPagingById?.[workspace().id] ?? { hasMore: false, loadingMore: false };
                const projectHierarchy = () => buildRowHierarchyLookup(project.sessions);
                const visibleCount = () => projectVisibleByKey()[project.key] ?? PROJECT_VISIBLE_DEFAULT;
                const projectTreeVisibleRows = () =>
                  project.sessions.filter((row) =>
                    rowVisibleByExpansion(row, projectHierarchy(), expandedParentSessionIds()),
                  );
                const hasChildren = (sessionId: string) =>
                  (projectHierarchy().childrenByParentId.get(sessionId)?.length ?? 0) > 0;
                const visibleRows = () => projectTreeVisibleRows().slice(0, visibleCount());
                const hasHiddenRows = () => projectTreeVisibleRows().length > visibleCount();
                const canLoadMoreProjectRows = () => hasHiddenRows() || projectPaging().hasMore;
                const loadMoreProjectRows = async () => {
                  const nextVisible = nextProjectVisibleCount(visibleCount());
                  setProjectVisibleByKey((current) => ({
                    ...current,
                    [project.key]: nextVisible,
                  }));

                  if (
                    props.onLoadMoreWorkspaceSessions &&
                    projectPaging().hasMore &&
                    nextVisible > project.sessions.length
                  ) {
                    await Promise.resolve(props.onLoadMoreWorkspaceSessions(workspace().id));
                  }
                };

                return (
                  <div
                    class={`group relative rounded-lg transition-colors ${
                      isProjectDragOver() ? "bg-gray-2/70" : ""
                    } ${isDraggedProject() ? "opacity-70" : ""}
                    `}
                    data-project-key={project.key}
                    onDragOver={(event) => handleProjectDragOver(event, project.key)}
                    onDragLeave={(event) => handleProjectDragLeave(event, project.key)}
                    onDrop={(event) => handleProjectDrop(event, project.key)}
                  >
                    <Show when={dropIndicatorPosition() === "before"}>
                      <div class="pointer-events-none absolute left-2 right-2 top-0 h-[2px] rounded-full bg-indigo-8/80" />
                    </Show>
                    <Show when={dropIndicatorPosition() === "after"}>
                      <div class="pointer-events-none absolute left-2 right-2 bottom-0 h-[2px] rounded-full bg-indigo-8/80" />
                    </Show>
                    <div class="relative flex items-start gap-2" data-project-drag-preview>
                      <button
                        type="button"
                        draggable
                        class={`min-w-0 flex-1 rounded-lg px-1.5 py-1 text-left transition-colors ${
                          isActiveWorkspace()
                            ? "text-gray-12"
                            : "text-gray-11 hover:text-gray-12 hover:bg-gray-2/70"
                        }`}
                        title={project.projectTitle}
                        aria-label={project.projectLabel ? `${tr("sidebar.open_project")} ${project.projectLabel}` : tr("sidebar.open_project")}
                        onDragStart={(event) => handleProjectDragStart(event, project.key)}
                        onDragEnd={handleProjectDragEnd}
                        onPointerDown={(event) => handleProjectPointerDown(event, project.key, projectDragLabel())}
                        onClick={() => toggleProjectCollapse(project.key)}
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
                    {workspaceMenu(
                      workspace(),
                      anchorKey,
                      soulEnabled(),
                      canRecover(),
                      isConnectionActionBusy(),
                    )}
                    </div>

                    <Show when={!collapsed()}>
                      <div class="pl-5 pt-0.5 space-y-0">
                        <For each={visibleRows()}>
                          {(row) => {
                            const session = () => row.session;
                            const isSelected = () => isRowSelected(workspace().id, session().id);
                            const isSessionActive = () =>
                              (props.sessionStatusById?.[session().id] ?? "idle") !== "idle";
                            const label = () => sessionLabelParts(row);
                            const labelColor = () => sessionLabelColor(row);
                            const archiveConfirmationPending = () => isArchiveConfirmationPending(row.session.id);
                            const rowAnchorKey = `project-session:${row.rowKey}`;

                            return (
                              <div
                                class="relative group/session-row"
                                onContextMenu={(event) => handleSessionRowContextMenu(event, row.workspace.id, rowAnchorKey)}
                              >
                                <div
                                  role="button"
                                  tabIndex={0}
                                  class={`w-full flex items-center gap-2 rounded-xl px-3 py-1 pr-12 text-left transition-colors ${
                                    isSelected() ? "bg-gray-4/90 text-gray-12" : "hover:bg-gray-3/70 text-gray-12"
                                  }`}
                                  style={rowIndentStyle(row)}
                                  onClick={() => handleSessionRowClick(row, hasChildren)}
                                  onKeyDown={(event) => handleSessionRowKeyDown(event, row, hasChildren)}
                                >
                                  <div class="relative min-w-0 flex-1">
                                    {sessionBranchToggle(session().id, hasChildren(session().id))}
                                    <div class="flex items-center gap-1.5 min-w-0">
                                      <Show when={isSessionActive()}>
                                        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-9" />
                                      </Show>
                                      <span
                                        class="text-[13px] text-gray-11 truncate font-medium"
                                        title={sessionLabelTitle(row)}
                                      >
                                        <Show when={label().decoratedName} fallback={label().description ?? ""}>
                                          {(decoratedName) => (
                                            <>
                                              <span style={labelColor() ? { color: labelColor() } : undefined}>
                                                {decoratedName()}
                                              </span>
                                              <Show when={label().description}>
                                                {(description) => <span>{` · ${description()}`}</span>}
                                              </Show>
                                            </>
                                          )}
                                        </Show>
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                <span
                                  class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-gray-9 whitespace-nowrap transition-opacity group-hover/session-row:opacity-0 group-focus-within/session-row:opacity-0"
                                  title={formatSessionTimestampTooltip(displayTimestamp(session()), currentLocale())}
                                >
                                  {formatSessionRelativeAge(displayTimestamp(session()))}
                                </span>

                                <div
                                  class={`absolute right-2 top-1/2 -translate-y-1/2 transition-opacity ${
                                    archiveConfirmationPending()
                                      ? "opacity-100"
                                      : "opacity-0 group-hover/session-row:opacity-100 group-focus-within/session-row:opacity-100"
                                  }`}
                                >
                                  <button
                                    type="button"
                                    class={archiveConfirmationPending()
                                      ? "rounded-md border border-amber-7 bg-amber-3 px-2 py-0.5 text-[11px] font-medium text-amber-11 hover:bg-amber-4"
                                      : "p-1 rounded-md text-gray-9 hover:text-gray-11 hover:bg-gray-4/80"}
                                    onClick={(event) => handleSessionArchiveAction(event, row.session.id)}
                                    aria-label={archiveConfirmationPending()
                                      ? tr("sidebar.archive_confirm")
                                      : isSessionArchived(row.session.id)
                                      ? tr("sidebar.unarchive_session")
                                      : tr("sidebar.archive_session")}
                                    title={archiveConfirmationPending()
                                      ? tr("sidebar.archive_confirm")
                                      : isSessionArchived(row.session.id)
                                      ? tr("sidebar.unarchive_session")
                                      : tr("sidebar.archive_session")}
                                    ref={(el) => {
                                      if (archiveConfirmationPending()) pendingArchiveConfirmButtonRef = el;
                                    }}
                                  >
                                    <Show when={archiveConfirmationPending()} fallback={<Archive size={14} />}>
                                      {tr("sidebar.archive_confirm")}
                                    </Show>
                                  </button>
                                </div>

                                {workspaceMenu(
                                  row.workspace,
                                  rowAnchorKey,
                                  soulEnabled(),
                                  canRecover(),
                                  isConnectionActionBusy(),
                                )}
                              </div>
                            );
                          }}
                        </For>
                        <Show when={canLoadMoreProjectRows()}>
                          <div>
                            <button
                              type="button"
                              class="w-full inline-flex items-center gap-1 rounded-xl px-3 py-1 text-left text-[11px] text-gray-9 transition-colors hover:bg-gray-3/70 hover:text-gray-11 disabled:opacity-60 disabled:cursor-not-allowed"
                              disabled={projectPaging().loadingMore}
                              onClick={() => {
                                void loadMoreProjectRows();
                              }}
                            >
                              <span aria-hidden>{tr("sidebar.more_ellipsis")}</span>
                              <span>{projectPaging().loadingMore ? tr("sidebar.loading_more") : tr("sidebar.load_more")}</span>
                            </button>
                          </div>
                        </Show>
                      </div>
                    </Show>
                    </div>
                  );
                }}
              </For>
            </Show>
          </Show>
        </div>
      </div>
      <Show when={projectDragPreview()}>
        {(preview) => (
          <div
            class="pointer-events-none fixed z-[90] max-w-[24rem] rounded-lg border border-gray-6 bg-gray-1/96 px-2.5 py-1.5 text-[12px] font-medium text-gray-12 shadow-xl shadow-gray-12/20 backdrop-blur-sm"
            style={{
              left: `${preview().x + 14}px`,
              top: `${preview().y + 12}px`,
            }}
          >
            <span class="truncate block">{preview().label}</span>
          </div>
        )}
      </Show>
    </div>
  );
}
