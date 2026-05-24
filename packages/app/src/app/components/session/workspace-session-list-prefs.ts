import type { CollapsedProjectMap } from "./workspace-session-list-model";
import {
  CHAT_SIDEBAR_DEFAULT_HEIGHT_PX,
  clampChatSidebarHeight,
} from "./workspace-session-list-windowing";

export type SidebarPrefsStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

export type SidebarViewMode = "by-project" | "recent";

export const SIDEBAR_VIEW_MODE_KEY = "veslo.sidebar-session-view.v1";
export const SIDEBAR_COLLAPSED_PROJECTS_KEY = "veslo.sidebar-collapsed-projects.v1";
export const SIDEBAR_PROJECT_ORDER_KEY = "veslo.sidebar-project-order.v1";
export const SIDEBAR_EXPANDED_PARENT_SESSIONS_KEY = "veslo.sidebar-expanded-parent-sessions.v1";
export const SIDEBAR_CHAT_HEIGHT_KEY = "veslo.sidebar-chat-height.v1";
export const SIDEBAR_CHAT_COLLAPSED_KEY = "veslo.sidebar-chat-collapsed.v1";
export const DEFAULT_SIDEBAR_VIEW_MODE: SidebarViewMode = "by-project";

const resolveStorage = (storage?: SidebarPrefsStorage | null): SidebarPrefsStorage | null => {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
};

const normalizeCollapsedProjectMap = (value: unknown): CollapsedProjectMap => {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const normalized: CollapsedProjectMap = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw !== "boolean") continue;
    normalized[key] = raw;
  }
  return normalized;
};

const normalizeProjectOrder = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const key = raw.trim();
    if (!key || normalized.includes(key)) continue;
    normalized.push(key);
  }
  return normalized;
};

const normalizeStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || normalized.includes(id)) continue;
    normalized.push(id);
  }
  return normalized;
};

export const readSidebarViewMode = (
  storage?: SidebarPrefsStorage | null,
): SidebarViewMode => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return DEFAULT_SIDEBAR_VIEW_MODE;

  try {
    const raw = resolvedStorage.getItem(SIDEBAR_VIEW_MODE_KEY);
    return raw === "recent" ? "recent" : DEFAULT_SIDEBAR_VIEW_MODE;
  } catch {
    return DEFAULT_SIDEBAR_VIEW_MODE;
  }
};

export const writeSidebarViewMode = (
  value: SidebarViewMode,
  storage?: SidebarPrefsStorage | null,
): void => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return;

  try {
    resolvedStorage.setItem(SIDEBAR_VIEW_MODE_KEY, value);
  } catch {
    // ignore storage failures
  }
};

export const readCollapsedProjectMap = (
  storage?: SidebarPrefsStorage | null,
): CollapsedProjectMap => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return {};

  try {
    const raw = resolvedStorage.getItem(SIDEBAR_COLLAPSED_PROJECTS_KEY);
    if (!raw) return {};
    return normalizeCollapsedProjectMap(JSON.parse(raw));
  } catch {
    return {};
  }
};

export const writeCollapsedProjectMap = (
  value: CollapsedProjectMap,
  storage?: SidebarPrefsStorage | null,
): void => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return;

  try {
    resolvedStorage.setItem(
      SIDEBAR_COLLAPSED_PROJECTS_KEY,
      JSON.stringify(normalizeCollapsedProjectMap(value)),
    );
  } catch {
    // ignore storage failures
  }
};

export const readProjectOrder = (storage?: SidebarPrefsStorage | null): string[] => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return [];

  try {
    const raw = resolvedStorage.getItem(SIDEBAR_PROJECT_ORDER_KEY);
    if (!raw) return [];
    return normalizeProjectOrder(JSON.parse(raw));
  } catch {
    return [];
  }
};

export const writeProjectOrder = (
  order: string[],
  storage?: SidebarPrefsStorage | null,
): void => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return;

  try {
    resolvedStorage.setItem(
      SIDEBAR_PROJECT_ORDER_KEY,
      JSON.stringify(normalizeProjectOrder(order)),
    );
  } catch {
    // ignore storage failures
  }
};

export const readExpandedParentSessionIds = (
  storage?: SidebarPrefsStorage | null,
): Set<string> => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return new Set();

  try {
    const raw = resolvedStorage.getItem(SIDEBAR_EXPANDED_PARENT_SESSIONS_KEY);
    if (!raw) return new Set();
    return new Set(normalizeStringList(JSON.parse(raw)));
  } catch {
    return new Set();
  }
};

export const writeExpandedParentSessionIds = (
  ids: ReadonlySet<string>,
  storage?: SidebarPrefsStorage | null,
): void => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return;

  try {
    resolvedStorage.setItem(
      SIDEBAR_EXPANDED_PARENT_SESSIONS_KEY,
      JSON.stringify(normalizeStringList(Array.from(ids))),
    );
  } catch {
    // ignore storage failures
  }
};

export const readChatSidebarHeight = (
  storage?: SidebarPrefsStorage | null,
): number => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return CHAT_SIDEBAR_DEFAULT_HEIGHT_PX;

  try {
    const raw = resolvedStorage.getItem(SIDEBAR_CHAT_HEIGHT_KEY);
    if (!raw) return CHAT_SIDEBAR_DEFAULT_HEIGHT_PX;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return CHAT_SIDEBAR_DEFAULT_HEIGHT_PX;
    return clampChatSidebarHeight(parsed);
  } catch {
    return CHAT_SIDEBAR_DEFAULT_HEIGHT_PX;
  }
};

export const writeChatSidebarHeight = (
  height: number,
  storage?: SidebarPrefsStorage | null,
): void => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return;

  try {
    resolvedStorage.setItem(SIDEBAR_CHAT_HEIGHT_KEY, String(clampChatSidebarHeight(height)));
  } catch {
    // ignore storage failures
  }
};

export const readChatSidebarCollapsed = (
  storage?: SidebarPrefsStorage | null,
): boolean => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return false;

  try {
    return resolvedStorage.getItem(SIDEBAR_CHAT_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
};

export const writeChatSidebarCollapsed = (
  collapsed: boolean,
  storage?: SidebarPrefsStorage | null,
): void => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return;

  try {
    resolvedStorage.setItem(SIDEBAR_CHAT_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // ignore storage failures
  }
};
