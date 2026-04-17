export const PROJECT_VISIBLE_DEFAULT = 7;
export const VIEW_LOAD_MORE_STEP = 20;
export const RECENT_OVERSCAN_ROWS = 3;
export const RECENT_ESTIMATED_ROW_HEIGHT = 40;
export const RECENT_LOAD_MORE_THRESHOLD_PX = 120;

const normalizePositiveInteger = (value: number, fallback: number) =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

export const nextProjectVisibleCount = (current: number) => {
  const safeCurrent = normalizePositiveInteger(current, PROJECT_VISIBLE_DEFAULT);
  return safeCurrent + VIEW_LOAD_MORE_STEP;
};

export const computeVisibleRowLoadCount = (
  totalLoadedRows: number,
  currentVisibleRows: number,
  hasMoreServerRows: boolean,
  step = VIEW_LOAD_MORE_STEP,
) => {
  const safeStep = normalizePositiveInteger(step, VIEW_LOAD_MORE_STEP);
  const safeTotalLoadedRows = Number.isFinite(totalLoadedRows) && totalLoadedRows > 0
    ? Math.floor(totalLoadedRows)
    : 0;
  const safeCurrentVisibleRows = Number.isFinite(currentVisibleRows) && currentVisibleRows > 0
    ? Math.floor(currentVisibleRows)
    : 0;
  const loadedHiddenRows = Math.max(0, safeTotalLoadedRows - safeCurrentVisibleRows);

  if (loadedHiddenRows >= safeStep) return safeStep;
  if (hasMoreServerRows) return safeStep;
  return loadedHiddenRows;
};

export const shouldShowLessVisibleRowsControl = (
  currentVisibleRows: number,
  baselineVisibleRows: number,
) => {
  const safeBaselineVisibleRows = normalizePositiveInteger(
    baselineVisibleRows,
    PROJECT_VISIBLE_DEFAULT,
  );
  const safeCurrentVisibleRows = Number.isFinite(currentVisibleRows) && currentVisibleRows > 0
    ? Math.floor(currentVisibleRows)
    : 0;
  return safeCurrentVisibleRows > safeBaselineVisibleRows;
};

export const computeInitialRecentVisibleCount = (
  containerHeight: number,
  estimatedRowHeight: number,
  overscan = RECENT_OVERSCAN_ROWS,
) => {
  const safeOverscan = normalizePositiveInteger(overscan, RECENT_OVERSCAN_ROWS);
  const safeRowHeight = Number.isFinite(estimatedRowHeight) && estimatedRowHeight > 0
    ? estimatedRowHeight
    : RECENT_ESTIMATED_ROW_HEIGHT;
  const fit = Number.isFinite(containerHeight) && containerHeight > 0
    ? Math.floor(containerHeight / safeRowHeight)
    : 0;
  return Math.max(safeOverscan, fit + safeOverscan);
};

export const shouldLoadMoreRecentRowsOnScroll = (
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  thresholdPx = RECENT_LOAD_MORE_THRESHOLD_PX,
) => {
  const safeClientHeight = Number.isFinite(clientHeight) && clientHeight > 0 ? clientHeight : 0;
  const safeScrollHeight = Number.isFinite(scrollHeight) && scrollHeight > 0 ? scrollHeight : 0;
  if (safeClientHeight === 0 || safeScrollHeight === 0) return false;
  const safeScrollTop = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  const safeThreshold = Number.isFinite(thresholdPx) && thresholdPx >= 0 ? thresholdPx : RECENT_LOAD_MORE_THRESHOLD_PX;
  return safeScrollTop + safeClientHeight >= safeScrollHeight - safeThreshold;
};
