export const PROJECT_VISIBLE_DEFAULT = 7;
export const VIEW_LOAD_MORE_STEP = 20;
export const RECENT_OVERSCAN_ROWS = 3;
export const RECENT_ESTIMATED_ROW_HEIGHT = 40;
export const RECENT_LOAD_MORE_THRESHOLD_PX = 120;
export const CHAT_SIDEBAR_DEFAULT_HEIGHT_PX = 288;
export const CHAT_SIDEBAR_COMPACT_HEIGHT_PX = RECENT_ESTIMATED_ROW_HEIGHT * 3;
export const CHAT_SIDEBAR_MIN_HEIGHT_PX = 56;
export const CHAT_SIDEBAR_MAX_HEIGHT_PX = 480;
export const CHAT_SIDEBAR_COLLAPSE_THRESHOLD_PX = 44;
const CHAT_SIDEBAR_MAX_HEIGHT_RATIO = 0.65;

const normalizePositiveInteger = (value: number, fallback: number) =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

const normalizeLoadedRowCount = (value: number) =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

export const nextProjectVisibleCount = (current: number) => {
  const safeCurrent = normalizePositiveInteger(current, PROJECT_VISIBLE_DEFAULT);
  return safeCurrent + VIEW_LOAD_MORE_STEP;
};

export const planVisibleRowLoadMore = (
  totalLoadedRows: number,
  currentVisibleRows: number,
  hasMoreServerRows: boolean,
  step = VIEW_LOAD_MORE_STEP,
) => {
  const safeStep = normalizePositiveInteger(step, VIEW_LOAD_MORE_STEP);
  const safeTotalLoadedRows = normalizeLoadedRowCount(totalLoadedRows);
  const safeCurrentVisibleRows = normalizeLoadedRowCount(currentVisibleRows);
  const loadedHiddenRows = Math.max(0, safeTotalLoadedRows - safeCurrentVisibleRows);

  if (loadedHiddenRows > 0) {
    return {
      nextVisibleCount: Math.min(safeTotalLoadedRows, safeCurrentVisibleRows + safeStep),
      shouldFetchServerRows: false,
    };
  }

  return {
    nextVisibleCount: hasMoreServerRows ? safeCurrentVisibleRows + safeStep : safeCurrentVisibleRows,
    shouldFetchServerRows: hasMoreServerRows,
  };
};

export const computeVisibleRowLoadCount = (
  totalLoadedRows: number,
  currentVisibleRows: number,
  hasMoreServerRows: boolean,
  step = VIEW_LOAD_MORE_STEP,
) => {
  const safeStep = normalizePositiveInteger(step, VIEW_LOAD_MORE_STEP);
  const safeTotalLoadedRows = normalizeLoadedRowCount(totalLoadedRows);
  const safeCurrentVisibleRows = normalizeLoadedRowCount(currentVisibleRows);
  const loadedHiddenRows = Math.max(0, safeTotalLoadedRows - safeCurrentVisibleRows);

  if (loadedHiddenRows > 0) return Math.min(loadedHiddenRows, safeStep);
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

export const computeChatSidebarMaxHeight = (containerHeight: number) => {
  if (!Number.isFinite(containerHeight) || containerHeight <= 0) return CHAT_SIDEBAR_MAX_HEIGHT_PX;
  const viewportMax = Math.floor(containerHeight * CHAT_SIDEBAR_MAX_HEIGHT_RATIO);
  return Math.max(
    CHAT_SIDEBAR_MIN_HEIGHT_PX,
    Math.min(CHAT_SIDEBAR_MAX_HEIGHT_PX, viewportMax),
  );
};

export const clampChatSidebarHeight = (
  height: number,
  containerHeight?: number,
) => {
  const safeHeight = Number.isFinite(height) && height > 0
    ? Math.floor(height)
    : CHAT_SIDEBAR_DEFAULT_HEIGHT_PX;
  const maxHeight = containerHeight == null
    ? CHAT_SIDEBAR_MAX_HEIGHT_PX
    : computeChatSidebarMaxHeight(containerHeight);
  return Math.min(Math.max(safeHeight, CHAT_SIDEBAR_MIN_HEIGHT_PX), maxHeight);
};

export const compactChatSidebarHeight = (
  containerHeight?: number,
) => clampChatSidebarHeight(CHAT_SIDEBAR_COMPACT_HEIGHT_PX, containerHeight);

export const restoreChatSidebarHeight = (
  height: number,
  containerHeight?: number,
) => {
  if (!Number.isFinite(height) || height < CHAT_SIDEBAR_MIN_HEIGHT_PX) {
    return clampChatSidebarHeight(CHAT_SIDEBAR_DEFAULT_HEIGHT_PX, containerHeight);
  }
  return clampChatSidebarHeight(height, containerHeight);
};

export const resolveChatSidebarResize = (
  height: number,
  previousHeight: number,
  containerHeight?: number,
) => {
  if (Number.isFinite(height) && height < CHAT_SIDEBAR_COLLAPSE_THRESHOLD_PX) {
    return {
      height: restoreChatSidebarHeight(previousHeight, containerHeight),
      collapsed: true,
    };
  }

  return {
    height: clampChatSidebarHeight(height, containerHeight),
    collapsed: false,
  };
};
