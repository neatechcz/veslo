import { createEffect, createMemo, createSignal, onCleanup, type Accessor, type Setter } from "solid-js";
import type { MessageWithParts, WorkspaceSessionGroup } from "../types";
import type { WorkspaceInfo } from "../lib/tauri";
import { isUserVisiblePart } from "../utils";

const MAX_SEARCH_MESSAGE_CHARS = 4_000;
const MAX_SEARCH_HITS = 2_000;

export type CommandPaletteMode = "root" | "sessions";

export type SearchHit = {
  messageId: string;
};

export type CommandPaletteItem = {
  id: string;
  title: string;
  detail?: string;
  meta?: string;
  disabled?: boolean;
  disabledReason?: string;
  action: () => void;
};

export type CommandPaletteLabels = {
  createSessionTitle: string;
  createSessionDetail: string;
  createSessionMeta: string;
  createSessionFailed?: string;
  searchSessionsTitle: string;
  searchSessionsDetail: (count: number) => string;
  searchSessionsMeta: string;
  currentWorkspaceMeta: string;
  switchWorkspaceMeta: string;
  untitledSession: string;
  quickActionsTitle: string;
  actionsPlaceholder: string;
  sessionsPlaceholder: string;
  noSearchMatches: string;
};

type CommandPaletteLabelsSource = CommandPaletteLabels | Accessor<CommandPaletteLabels>;

export type CommandPaletteStateInput = {
  canCreateSession?: boolean;
  createSessionDisabledReason?: string | null;
  runtimeReady?: boolean;
  runtimeDisabledReason?: string | null;
  hasSessionNavigation?: boolean;
  sessionNavigationDisabledReason?: string | null;
};

export type CommandPaletteActions = {
  createSession: () => void;
  openSessionsMode: () => void;
  openSession: (workspaceId: string, sessionId: string) => void;
  reportDisabled?: (reason: string) => void;
};

export type CommandPaletteSessionOption = {
  workspaceId: string;
  sessionId: string;
  title: string;
  workspaceTitle: string;
  updatedAt: number;
  searchText: string;
};

export type CollectSessionSearchHitsInput = {
  messages: readonly MessageWithParts[];
  query: string;
  maxMessageChars?: number;
  maxHits?: number;
};

export type CollectSessionSearchHitsResult = {
  hits: SearchHit[];
  capped: boolean;
};

export type SessionSearchCommandShortcutInput = {
  key: string;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  commandPaletteOpen: boolean;
  searchOpen: boolean;
  commandPaletteMode: CommandPaletteMode;
  commandPaletteQuery: string;
  isComposing?: boolean;
  keyCode?: number;
};

export type SessionSearchCommandShortcutAction =
  | "ignore"
  | "toggle-command-palette"
  | "close-command-palette"
  | "command-next"
  | "command-previous"
  | "command-run-active"
  | "command-root"
  | "open-search"
  | "close-search"
  | "search-next"
  | "search-previous";

export type SessionSearchCommandControllerDeps = {
  messages: Accessor<readonly MessageWithParts[]>;
  workspaceSessionGroups: Accessor<readonly WorkspaceSessionGroup[]>;
  activeWorkspaceId: Accessor<string>;
  developerMode: Accessor<boolean>;
  labels: CommandPaletteLabelsSource;
  workspaceLabel: (workspace: WorkspaceInfo) => string;
  perfNow: () => number;
  recordPerfLog: (
    enabled: boolean,
    category: string,
    event: string,
    payload?: Record<string, unknown>,
  ) => void;
  focusSearchInput: () => void;
  focusCommandPaletteInput: () => void;
  createSessionAndOpen: () => Promise<unknown> | unknown;
  openSessionFromList: (workspaceId: string, sessionId: string) => void;
  setToastMessage: (message: string) => void;
  commandState?: {
    canCreateSession?: Accessor<boolean>;
    createSessionDisabledReason?: Accessor<string | null>;
    runtimeReady?: Accessor<boolean>;
    runtimeDisabledReason?: Accessor<string | null>;
    hasSessionNavigation?: Accessor<boolean>;
    sessionNavigationDisabledReason?: Accessor<string | null>;
  };
};

export type SessionSearchCommandController = {
  searchOpen: Accessor<boolean>;
  searchQuery: Accessor<string>;
  searchQueryDebounced: Accessor<string>;
  searchActive: Accessor<boolean>;
  searchHits: Accessor<SearchHit[]>;
  searchMatchMessageIds: Accessor<Set<string>>;
  activeSearchHit: Accessor<SearchHit | null>;
  activeSearchPositionLabel: Accessor<string>;
  commandPaletteOpen: Accessor<boolean>;
  commandPaletteMode: Accessor<CommandPaletteMode>;
  commandPaletteQuery: Accessor<string>;
  commandPaletteActiveIndex: Accessor<number>;
  commandPaletteItems: Accessor<CommandPaletteItem[]>;
  commandPaletteTitle: Accessor<string>;
  commandPalettePlaceholder: Accessor<string>;
  commandPaletteSessionOptions: Accessor<CommandPaletteSessionOption[]>;
  totalSessionCount: Accessor<number>;
  setSearchQuery: (value: string) => void;
  flushSearchQuery: () => void;
  setCommandPaletteQuery: (value: string) => void;
  setCommandPaletteActiveIndex: Setter<number>;
  openCommandPalette: (mode?: CommandPaletteMode) => void;
  closeCommandPalette: () => void;
  stepCommandPaletteIndex: (delta: number, total?: number) => void;
  returnToCommandRoot: () => void;
  runActiveCommandPaletteItem: () => void;
  openSearch: () => void;
  closeSearch: () => void;
  moveSearchHit: (offset: number) => void;
  handleShortcutAction: (action: SessionSearchCommandShortcutAction) => boolean;
};

export function messageIdFromInfo(message: MessageWithParts) {
  const id = (message.info as { id?: string | number }).id;
  if (typeof id === "string") return id;
  if (typeof id === "number") return String(id);
  return "";
}

function messageTextForSearch(message: MessageWithParts, maxChars = MAX_SEARCH_MESSAGE_CHARS) {
  const chunks: string[] = [];
  let used = 0;
  const push = (value: string) => {
    const next = value.trim();
    if (!next) return;
    if (used >= maxChars) return;
    const remaining = maxChars - used;
    if (next.length > remaining) {
      chunks.push(next.slice(0, Math.max(0, remaining)));
      used = maxChars;
      return;
    }
    chunks.push(next);
    used += next.length;
  };

  for (const part of message.parts) {
    if (!isUserVisiblePart(part)) continue;

    if (part.type === "text") {
      push((part as { text?: string }).text ?? "");
      continue;
    }
    if (part.type === "agent") {
      const name = (part as { name?: string }).name ?? "";
      push(name ? `@${name}` : "");
      continue;
    }
    if (part.type === "file") {
      const file = part as { label?: string; path?: string; filename?: string };
      push(file.label ?? file.path ?? file.filename ?? "");
      continue;
    }
    if (part.type === "tool") {
      const state = (part as { state?: { title?: string; output?: string; error?: string } }).state;
      push(state?.title ?? "");
      push(state?.output ?? "");
      push(state?.error ?? "");
    }
  }

  return chunks.join("\n");
}

function collectSessionSearchHitsWithMeta(input: CollectSessionSearchHitsInput): CollectSessionSearchHitsResult {
  const query = input.query.trim().toLowerCase();
  if (!query) return { hits: [], capped: false };

  const maxMessageChars = input.maxMessageChars ?? MAX_SEARCH_MESSAGE_CHARS;
  const maxHits = input.maxHits ?? MAX_SEARCH_HITS;
  const hits: SearchHit[] = [];
  let capped = false;

  outer: for (const message of input.messages) {
    const messageId = messageIdFromInfo(message);
    if (!messageId) continue;
    const haystack = messageTextForSearch(message, maxMessageChars).toLowerCase();
    if (!haystack) continue;

    let index = haystack.indexOf(query);
    while (index !== -1) {
      hits.push({ messageId });
      if (hits.length >= maxHits) {
        capped = true;
        break outer;
      }
      index = haystack.indexOf(query, index + Math.max(1, query.length));
    }
  }

  return { hits, capped };
}

export function collectSessionSearchHits(input: CollectSessionSearchHitsInput) {
  return collectSessionSearchHitsWithMeta(input).hits;
}

function wrapActiveSearchHitIndex(current: number, total: number) {
  if (total <= 0) return 0;
  return ((current % total) + total) % total;
}

export function moveActiveSearchHitIndex(input: { current: number; total: number; offset: number }) {
  if (input.total <= 0) return 0;
  const normalized = wrapActiveSearchHitIndex(input.current, input.total);
  return (normalized + input.offset + input.total) % input.total;
}

export function clampActiveSearchHitIndex(input: { current: number; total: number }) {
  if (input.total <= 0) return 0;
  if (input.current < 0 || input.current >= input.total) return 0;
  return input.current;
}

export function activeSearchHitForIndex(hits: readonly SearchHit[], index: number) {
  if (!hits.length) return null;
  return hits[wrapActiveSearchHitIndex(index, hits.length)] ?? null;
}

export function formatSearchPositionLabel(input: {
  hits: readonly SearchHit[];
  activeIndex: number;
  noMatchesLabel: string;
}) {
  if (!input.hits.length) return input.noMatchesLabel;
  return `${wrapActiveSearchHitIndex(input.activeIndex, input.hits.length) + 1}/${input.hits.length}`;
}

function buildCommandPaletteSessionOptions(input: {
  groups: readonly WorkspaceSessionGroup[];
  activeWorkspaceId: string;
  workspaceLabel: (workspace: WorkspaceInfo) => string;
  untitledLabel: string;
}) {
  const out: CommandPaletteSessionOption[] = [];

  for (const group of input.groups) {
    const workspaceId = group.workspace.id?.trim() ?? "";
    if (!workspaceId) continue;
    const workspaceTitle = input.workspaceLabel(group.workspace);
    for (const session of group.sessions) {
      const sessionId = session.id?.trim() ?? "";
      if (!sessionId) continue;
      const title = session.title?.trim() || input.untitledLabel;
      const slug = session.slug?.trim() ?? "";
      const updatedAt = session.time?.updated ?? session.time?.created ?? 0;
      out.push({
        workspaceId,
        sessionId,
        title,
        workspaceTitle,
        updatedAt,
        searchText: [title, workspaceTitle, slug].join(" ").toLowerCase(),
      });
    }
  }

  out.sort((a, b) => {
    const aActive = a.workspaceId === input.activeWorkspaceId;
    const bActive = b.workspaceId === input.activeWorkspaceId;
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });

  return out;
}

export function resolveCommandPaletteItems(input: {
  mode: CommandPaletteMode;
  query: string;
  activeWorkspaceId: string;
  sessionOptions: readonly CommandPaletteSessionOption[];
  labels: CommandPaletteLabels;
  state?: CommandPaletteStateInput;
  actions: CommandPaletteActions;
}) {
  const query = input.query.trim().toLowerCase();
  if (input.mode === "sessions") {
    const candidates = query
      ? input.sessionOptions.filter((item) => item.searchText.includes(query))
      : input.sessionOptions;

    return candidates.slice(0, 80).map<CommandPaletteItem>((item) => ({
      id: `session:${item.workspaceId}:${item.sessionId}`,
      title: item.title,
      detail: item.workspaceTitle,
      meta:
        item.workspaceId === input.activeWorkspaceId
          ? input.labels.currentWorkspaceMeta
          : input.labels.switchWorkspaceMeta,
      action: () => input.actions.openSession(item.workspaceId, item.sessionId),
    }));
  }

  const canCreateSession = input.state?.canCreateSession ?? true;
  const runtimeReady = input.state?.runtimeReady ?? true;
  const hasSessionNavigation = input.state?.hasSessionNavigation ?? true;
  const createDisabledReason = !canCreateSession
    ? input.state?.createSessionDisabledReason ?? null
    : !runtimeReady
      ? input.state?.runtimeDisabledReason ?? null
      : null;
  const sessionNavigationDisabledReason = !hasSessionNavigation
    ? input.state?.sessionNavigationDisabledReason ?? null
    : null;
  const disabledAction = (reason: string | null | undefined, fallback: () => void) => () => {
    if (reason) {
      input.actions.reportDisabled?.(reason);
      return;
    }
    fallback();
  };
  const items: CommandPaletteItem[] = [
    {
      id: "new-session",
      title: input.labels.createSessionTitle,
      detail: input.labels.createSessionDetail,
      meta: input.labels.createSessionMeta,
      disabled: Boolean(createDisabledReason),
      disabledReason: createDisabledReason ?? undefined,
      action: disabledAction(createDisabledReason, input.actions.createSession),
    },
    {
      id: "sessions",
      title: input.labels.searchSessionsTitle,
      detail: input.labels.searchSessionsDetail(input.sessionOptions.length),
      meta: input.labels.searchSessionsMeta,
      disabled: Boolean(sessionNavigationDisabledReason),
      disabledReason: sessionNavigationDisabledReason ?? undefined,
      action: disabledAction(sessionNavigationDisabledReason, input.actions.openSessionsMode),
    },
  ];

  if (!query) return items;
  return items.filter((item) => `${item.title} ${item.detail ?? ""}`.toLowerCase().includes(query));
}

export function resolveSessionSearchCommandShortcut(
  input: SessionSearchCommandShortcutInput,
): SessionSearchCommandShortcutAction {
  if (input.defaultPrevented) return "ignore";
  const mod = input.metaKey || input.ctrlKey;
  const key = input.key.toLowerCase();

  if (mod && !input.altKey && !input.shiftKey && key === "k") {
    return "toggle-command-palette";
  }

  if (input.commandPaletteOpen) {
    if (input.key === "Escape") return "close-command-palette";
    if (input.key === "ArrowDown") return "command-next";
    if (input.key === "ArrowUp") return "command-previous";
    if (input.key === "Enter") {
      if (input.isComposing || input.keyCode === 229) return "ignore";
      return "command-run-active";
    }
    if (input.key === "Backspace" && !input.commandPaletteQuery.trim() && input.commandPaletteMode !== "root") {
      return "command-root";
    }
    return "ignore";
  }

  if (mod && !input.altKey && key === "f") return "open-search";

  if (input.searchOpen) {
    if (mod && !input.altKey && key === "g") {
      return input.shiftKey ? "search-previous" : "search-next";
    }
    if (input.key === "Escape") return "close-search";
  }

  return "ignore";
}

export function createSessionSearchCommandController(
  deps: SessionSearchCommandControllerDeps,
): SessionSearchCommandController {
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuerySignal] = createSignal("");
  const [searchQueryDebounced, setSearchQueryDebounced] = createSignal("");
  const [activeSearchHitIndex, setActiveSearchHitIndex] = createSignal(0);
  const [commandPaletteOpen, setCommandPaletteOpen] = createSignal(false);
  const [commandPaletteMode, setCommandPaletteMode] = createSignal<CommandPaletteMode>("root");
  const [commandPaletteQuery, setCommandPaletteQuerySignal] = createSignal("");
  const [commandPaletteActiveIndex, setCommandPaletteActiveIndex] = createSignal(0);
  const labels = () =>
    typeof deps.labels === "function" ? (deps.labels as Accessor<CommandPaletteLabels>)() : deps.labels;

  const setSearchQuery = (value: string) => {
    setSearchQuerySignal(value);
    setActiveSearchHitIndex(0);
  };
  const flushSearchQuery = () => setSearchQueryDebounced(searchQuery());

  createEffect(() => {
    const value = searchQuery();
    if (typeof window === "undefined") {
      setSearchQueryDebounced(value);
      return;
    }
    const id = window.setTimeout(() => setSearchQueryDebounced(value), 90);
    onCleanup(() => window.clearTimeout(id));
  });

  const searchHits = createMemo<SearchHit[]>(() => {
    if (!searchOpen()) return [];
    const query = searchQueryDebounced().trim();
    if (!query) return [];

    const startedAt = deps.perfNow();
    const result = collectSessionSearchHitsWithMeta({
      messages: deps.messages(),
      query,
    });
    const elapsedMs = Math.round((deps.perfNow() - startedAt) * 100) / 100;
    if (deps.developerMode() && (elapsedMs >= 8 || result.capped)) {
      deps.recordPerfLog(true, "session.search", "scan", {
        queryLength: query.length,
        messageCount: deps.messages().length,
        hitCount: result.hits.length,
        capped: result.capped,
        ms: elapsedMs,
      });
    }

    return result.hits;
  });

  const searchMatchMessageIds = createMemo(() => {
    const out = new Set<string>();
    for (const hit of searchHits()) out.add(hit.messageId);
    return out;
  });
  const activeSearchHit = createMemo(() => activeSearchHitForIndex(searchHits(), activeSearchHitIndex()));
  const activeSearchPositionLabel = createMemo(() =>
    formatSearchPositionLabel({
      hits: searchHits(),
      activeIndex: activeSearchHitIndex(),
      noMatchesLabel: labels().noSearchMatches,
    }),
  );
  const searchActive = createMemo(() => searchOpen() && searchQuery().trim().length > 0);

  createEffect(() => {
    const total = searchHits().length;
    setActiveSearchHitIndex((current) => clampActiveSearchHitIndex({ current, total }));
  });

  const commandPaletteSessionOptions = createMemo(() =>
    buildCommandPaletteSessionOptions({
      groups: deps.workspaceSessionGroups(),
      activeWorkspaceId: deps.activeWorkspaceId(),
      workspaceLabel: deps.workspaceLabel,
      untitledLabel: labels().untitledSession,
    }),
  );
  const totalSessionCount = createMemo(() => commandPaletteSessionOptions().length);

  const closeCommandPalette = () => {
    setCommandPaletteOpen(false);
    setCommandPaletteMode("root");
    setCommandPaletteQuerySignal("");
    setCommandPaletteActiveIndex(0);
  };
  const openCommandPalette = (mode: CommandPaletteMode = "root") => {
    setCommandPaletteMode(mode);
    setCommandPaletteQuerySignal("");
    setCommandPaletteActiveIndex(0);
    setCommandPaletteOpen(true);
  };
  const setCommandPaletteQuery = (value: string) => {
    setCommandPaletteQuerySignal(value);
    setCommandPaletteActiveIndex(0);
  };
  const stepCommandPaletteIndex = (delta: number, total = commandPaletteItems().length) => {
    if (total <= 0) {
      setCommandPaletteActiveIndex(0);
      return;
    }
    setCommandPaletteActiveIndex((current) => moveActiveSearchHitIndex({ current, total, offset: delta }));
  };
  const returnToCommandRoot = () => {
    if (commandPaletteMode() === "root") return;
    setCommandPaletteMode("root");
    setCommandPaletteQuerySignal("");
    setCommandPaletteActiveIndex(0);
    deps.focusCommandPaletteInput();
  };
  const openSessionsMode = () => {
    setCommandPaletteMode("sessions");
    setCommandPaletteQuerySignal("");
    setCommandPaletteActiveIndex(0);
    deps.focusCommandPaletteInput();
  };

  const commandPaletteItems = createMemo<CommandPaletteItem[]>(() =>
    resolveCommandPaletteItems({
      mode: commandPaletteMode(),
      query: commandPaletteQuery(),
      activeWorkspaceId: deps.activeWorkspaceId(),
      sessionOptions: commandPaletteSessionOptions(),
      labels: labels(),
      state: {
        canCreateSession: deps.commandState?.canCreateSession?.() ?? true,
        createSessionDisabledReason: deps.commandState?.createSessionDisabledReason?.() ?? null,
        runtimeReady: deps.commandState?.runtimeReady?.() ?? true,
        runtimeDisabledReason: deps.commandState?.runtimeDisabledReason?.() ?? null,
        hasSessionNavigation: deps.commandState?.hasSessionNavigation?.() ?? true,
        sessionNavigationDisabledReason: deps.commandState?.sessionNavigationDisabledReason?.() ?? null,
      },
      actions: {
        createSession: () => {
          closeCommandPalette();
          void Promise.resolve(deps.createSessionAndOpen()).catch((error) => {
            const message = error instanceof Error ? error.message : labels().createSessionFailed ?? String(error);
            deps.setToastMessage(message);
          });
        },
        openSessionsMode,
        openSession: (workspaceId, sessionId) => {
          closeCommandPalette();
          deps.openSessionFromList(workspaceId, sessionId);
        },
        reportDisabled: deps.setToastMessage,
      },
    }),
  );

  const commandPaletteTitle = createMemo(() => {
    if (commandPaletteMode() === "sessions") return labels().searchSessionsTitle;
    return labels().quickActionsTitle;
  });
  const commandPalettePlaceholder = createMemo(() => {
    if (commandPaletteMode() === "sessions") return labels().sessionsPlaceholder;
    return labels().actionsPlaceholder;
  });

  createEffect(() => {
    if (!commandPaletteOpen()) return;
    deps.focusCommandPaletteInput();
  });

  createEffect(() => {
    if (!commandPaletteOpen()) return;
    const total = commandPaletteItems().length;
    if (total === 0) {
      setCommandPaletteActiveIndex(0);
      return;
    }
    setCommandPaletteActiveIndex((current) => Math.max(0, Math.min(current, total - 1)));
  });

  const runActiveCommandPaletteItem = () => {
    const item = commandPaletteItems().at(commandPaletteActiveIndex());
    if (!item) return;
    item.action();
  };
  const openSearch = () => {
    setSearchOpen(true);
    flushSearchQuery();
    deps.focusSearchInput();
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQueryDebounced("");
  };
  const moveSearchHit = (offset: number) => {
    const total = searchHits().length;
    if (!total) return;
    setActiveSearchHitIndex((current) => moveActiveSearchHitIndex({ current, total, offset }));
  };
  const handleShortcutAction = (action: SessionSearchCommandShortcutAction) => {
    switch (action) {
      case "toggle-command-palette":
        if (commandPaletteOpen()) closeCommandPalette();
        else openCommandPalette();
        return true;
      case "close-command-palette":
        closeCommandPalette();
        return true;
      case "command-next":
        stepCommandPaletteIndex(1);
        return true;
      case "command-previous":
        stepCommandPaletteIndex(-1);
        return true;
      case "command-run-active":
        runActiveCommandPaletteItem();
        return true;
      case "command-root":
        returnToCommandRoot();
        return true;
      case "open-search":
        openSearch();
        return true;
      case "close-search":
        closeSearch();
        return true;
      case "search-next":
        moveSearchHit(1);
        return true;
      case "search-previous":
        moveSearchHit(-1);
        return true;
      case "ignore":
        return false;
    }
  };

  return {
    searchOpen,
    searchQuery,
    searchQueryDebounced,
    searchActive,
    searchHits,
    searchMatchMessageIds,
    activeSearchHit,
    activeSearchPositionLabel,
    commandPaletteOpen,
    commandPaletteMode,
    commandPaletteQuery,
    commandPaletteActiveIndex,
    commandPaletteItems,
    commandPaletteTitle,
    commandPalettePlaceholder,
    commandPaletteSessionOptions,
    totalSessionCount,
    setSearchQuery,
    flushSearchQuery,
    setCommandPaletteQuery,
    setCommandPaletteActiveIndex,
    openCommandPalette,
    closeCommandPalette,
    stepCommandPaletteIndex,
    returnToCommandRoot,
    runActiveCommandPaletteItem,
    openSearch,
    closeSearch,
    moveSearchHit,
    handleShortcutAction,
  };
}
