export const PROJECT_VISIBLE_DEFAULT = 7;
export const VIEW_LOAD_MORE_STEP = 20;
export const RECENT_OVERSCAN_ROWS = 3;
export const RECENT_ESTIMATED_ROW_HEIGHT = 40;

export const nextProjectVisibleCount = (current: number) => {
  const safeCurrent = Number.isFinite(current) && current > 0
    ? Math.floor(current)
    : PROJECT_VISIBLE_DEFAULT;
  return safeCurrent + VIEW_LOAD_MORE_STEP;
};

export const computeInitialRecentVisibleCount = (
  containerHeight: number,
  estimatedRowHeight: number,
  overscan = RECENT_OVERSCAN_ROWS,
) => {
  const safeOverscan = Number.isFinite(overscan) && overscan > 0
    ? Math.floor(overscan)
    : RECENT_OVERSCAN_ROWS;
  const safeRowHeight = Number.isFinite(estimatedRowHeight) && estimatedRowHeight > 0
    ? estimatedRowHeight
    : RECENT_ESTIMATED_ROW_HEIGHT;
  const fit = Number.isFinite(containerHeight) && containerHeight > 0
    ? Math.floor(containerHeight / safeRowHeight)
    : 0;
  return Math.max(safeOverscan, fit + safeOverscan);
};
