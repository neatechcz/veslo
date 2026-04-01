import type { CollapsedProjectMap } from "./workspace-session-list-model";

export type SidebarPrefsStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

export type SidebarViewMode = "by-project" | "recent";

export const SIDEBAR_VIEW_MODE_KEY = "veslo.sidebar-session-view.v1";
export const SIDEBAR_COLLAPSED_PROJECTS_KEY = "veslo.sidebar-collapsed-projects.v1";
export const SIDEBAR_PROJECT_ORDER_KEY = "veslo.sidebar-project-order.v1";
export const SIDEBAR_SHOW_ARCHIVED_KEY = "veslo.sidebar-show-archived.v1";
export const SIDEBAR_ARCHIVED_SESSION_IDS_KEY = "veslo.sidebar-archived-session-ids.v1";
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

const normalizeSessionIds = (value: unknown): string[] => {
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

export const readShowArchivedSessions = (
  storage?: SidebarPrefsStorage | null,
): boolean => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return false;
  try {
    return resolvedStorage.getItem(SIDEBAR_SHOW_ARCHIVED_KEY) === "true";
  } catch {
    return false;
  }
};

export const writeShowArchivedSessions = (
  value: boolean,
  storage?: SidebarPrefsStorage | null,
): void => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return;
  try {
    resolvedStorage.setItem(SIDEBAR_SHOW_ARCHIVED_KEY, value ? "true" : "false");
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

export const readArchivedSessionIds = (
  storage?: SidebarPrefsStorage | null,
): string[] => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return [];
  try {
    const raw = resolvedStorage.getItem(SIDEBAR_ARCHIVED_SESSION_IDS_KEY);
    if (!raw) return [];
    return normalizeSessionIds(JSON.parse(raw));
  } catch {
    return [];
  }
};

export const writeArchivedSessionIds = (
  sessionIds: string[],
  storage?: SidebarPrefsStorage | null,
): void => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return;
  try {
    resolvedStorage.setItem(
      SIDEBAR_ARCHIVED_SESSION_IDS_KEY,
      JSON.stringify(normalizeSessionIds(sessionIds)),
    );
  } catch {
    // ignore storage failures
  }
};
