export type SidebarDashboardNavPrefsStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

export const SIDEBAR_DASHBOARD_NAV_COLLAPSED_KEY =
  "veslo.sidebar-dashboard-nav.collapsed.v1";
export const DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED = true;

const resolveStorage = (
  storage?: SidebarDashboardNavPrefsStorage | null,
): SidebarDashboardNavPrefsStorage | null => {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
};

const parseCollapsed = (raw: string | null): boolean | null => {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
};

export const readSidebarDashboardNavCollapsed = (
  storage?: SidebarDashboardNavPrefsStorage | null,
): boolean => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED;

  try {
    const parsed = parseCollapsed(resolvedStorage.getItem(SIDEBAR_DASHBOARD_NAV_COLLAPSED_KEY));
    return parsed ?? DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED;
  } catch {
    return DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED;
  }
};

export const writeSidebarDashboardNavCollapsed = (
  value: boolean,
  storage?: SidebarDashboardNavPrefsStorage | null,
): void => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return;

  try {
    resolvedStorage.setItem(
      SIDEBAR_DASHBOARD_NAV_COLLAPSED_KEY,
      JSON.stringify(Boolean(value)),
    );
  } catch {
    // ignore storage failures
  }
};
