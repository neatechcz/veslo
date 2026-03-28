export const SIDEBAR_SESSION_PAGE_SIZE = 20;

export const initialSidebarSessionLimit = () => SIDEBAR_SESSION_PAGE_SIZE;

export const nextSidebarSessionLimit = (current: number, step = SIDEBAR_SESSION_PAGE_SIZE) => {
  const safeCurrent = Number.isFinite(current) && current > 0
    ? Math.floor(current)
    : SIDEBAR_SESSION_PAGE_SIZE;
  const safeStep = Number.isFinite(step) && step > 0
    ? Math.floor(step)
    : SIDEBAR_SESSION_PAGE_SIZE;
  return safeCurrent + safeStep;
};

export const deriveSidebarHasMore = (fetchedCount: number, requestedLimit: number) =>
  fetchedCount >= requestedLimit;
