export type LeftSidebarWidthStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

export const LEFT_SIDEBAR_WIDTH_MIN = 256;
export const LEFT_SIDEBAR_WIDTH_DEFAULT = 260;
export const LEFT_SIDEBAR_WIDTH_MAX = 420;
const LEFT_SIDEBAR_WIDTH_KEY = "veslo.global.sidebar.left-width.v1";

const resolveStorage = (
  storage?: LeftSidebarWidthStorage | null,
): LeftSidebarWidthStorage | null => {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
};

export const clampLeftSidebarWidth = (value: number): number => {
  if (!Number.isFinite(value)) return LEFT_SIDEBAR_WIDTH_DEFAULT;
  return Math.max(LEFT_SIDEBAR_WIDTH_MIN, Math.min(LEFT_SIDEBAR_WIDTH_MAX, Math.round(value)));
};

export const readLeftSidebarWidth = (
  storage?: LeftSidebarWidthStorage | null,
): number => {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return LEFT_SIDEBAR_WIDTH_DEFAULT;

  try {
    const raw = resolvedStorage.getItem(LEFT_SIDEBAR_WIDTH_KEY);
    if (!raw) return LEFT_SIDEBAR_WIDTH_DEFAULT;
    return clampLeftSidebarWidth(Number(raw));
  } catch {
    return LEFT_SIDEBAR_WIDTH_DEFAULT;
  }
};

export const writeLeftSidebarWidth = (
  value: number,
  storage?: LeftSidebarWidthStorage | null,
): number => {
  const normalized = clampLeftSidebarWidth(value);
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return normalized;

  try {
    resolvedStorage.setItem(LEFT_SIDEBAR_WIDTH_KEY, String(normalized));
  } catch {
    // ignore storage failures
  }

  return normalized;
};
