import type { GlobalSidebarDockedVisibility } from "./global-sidebar-layout-model";

export type SidebarPrefsStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

export type ReadGlobalSidebarDockedPrefsOptions = {
  defaultVisibility?: GlobalSidebarDockedVisibility;
};

export const GLOBAL_SIDEBAR_DOCKED_PREF_KEY = "veslo.global.sidebar.docked.v1";
export const LEGACY_SESSION_SIDEBAR_DOCKED_PREF_KEY = "veslo.session.sidebar.docked.v1";

export const DEFAULT_GLOBAL_SIDEBAR_DOCKED_VISIBILITY: GlobalSidebarDockedVisibility = {
  left: true,
  right: false,
};

const normalizeDockedVisibility = (value: unknown): GlobalSidebarDockedVisibility | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.left !== "boolean" || typeof record.right !== "boolean") return null;
  return {
    left: record.left,
    right: record.right,
  };
};

const parseDockedVisibility = (raw: string | null): GlobalSidebarDockedVisibility | null => {
  if (!raw) return null;
  try {
    return normalizeDockedVisibility(JSON.parse(raw));
  } catch {
    return null;
  }
};

const resolveStorage = (storage?: SidebarPrefsStorage | null): SidebarPrefsStorage | null => {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
};

const resolveDefaultVisibility = (
  options?: ReadGlobalSidebarDockedPrefsOptions,
): GlobalSidebarDockedVisibility => {
  const customDefault = normalizeDockedVisibility(options?.defaultVisibility);
  return customDefault ?? { ...DEFAULT_GLOBAL_SIDEBAR_DOCKED_VISIBILITY };
};

export const readGlobalSidebarDockedPrefs = (
  storage?: SidebarPrefsStorage | null,
  options?: ReadGlobalSidebarDockedPrefsOptions,
): GlobalSidebarDockedVisibility => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return resolveDefaultVisibility(options);

  const direct = parseDockedVisibility(resolvedStorage.getItem(GLOBAL_SIDEBAR_DOCKED_PREF_KEY));
  if (direct) return direct;

  const legacy = parseDockedVisibility(
    resolvedStorage.getItem(LEGACY_SESSION_SIDEBAR_DOCKED_PREF_KEY),
  );
  if (legacy) {
    try {
      resolvedStorage.setItem(GLOBAL_SIDEBAR_DOCKED_PREF_KEY, JSON.stringify(legacy));
    } catch {
      // ignore storage write failures and still return migrated in-memory value
    }
    return legacy;
  }

  return resolveDefaultVisibility(options);
};

export const writeGlobalSidebarDockedPrefs = (
  value: GlobalSidebarDockedVisibility,
  storage?: SidebarPrefsStorage | null,
): void => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return;

  try {
    resolvedStorage.setItem(
      GLOBAL_SIDEBAR_DOCKED_PREF_KEY,
      JSON.stringify({
        left: Boolean(value.left),
        right: Boolean(value.right),
      }),
    );
  } catch {
    // ignore storage write failures
  }
};
