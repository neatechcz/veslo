import type { CollapsedProjectMap } from "./workspace-session-list-model";

export type SidebarPrefsStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

export type SidebarViewMode = "by-project" | "recent";

export const SIDEBAR_VIEW_MODE_KEY = "veslo.sidebar-session-view.v1";
export const SIDEBAR_COLLAPSED_PROJECTS_KEY = "veslo.sidebar-collapsed-projects.v1";
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
