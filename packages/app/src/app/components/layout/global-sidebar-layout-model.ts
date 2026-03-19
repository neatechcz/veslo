export type GlobalSidebarSide = "left" | "right";
export type GlobalSidebarLayoutMode = "wide" | "narrow";

export type GlobalSidebarDockedVisibility = {
  left: boolean;
  right: boolean;
};

export type GlobalSidebarLayoutState = {
  mode: GlobalSidebarLayoutMode;
  docked: GlobalSidebarDockedVisibility;
  dockedPreference: GlobalSidebarDockedVisibility;
  overlay: GlobalSidebarSide | null;
};

export const GLOBAL_LEFT_SIDEBAR_DOCKED_WIDTH = 260;
export const GLOBAL_RIGHT_SIDEBAR_DOCKED_WIDTH = 280;
export const GLOBAL_CENTER_MIN_INTERACTIVE_WIDTH = 360;
export const GLOBAL_CENTER_MIN_INTERACTIVE_WIDTH_EXIT = 392;

const hiddenDockedVisibility: GlobalSidebarDockedVisibility = {
  left: false,
  right: false,
};

const copyDockedVisibility = (
  value: GlobalSidebarDockedVisibility,
): GlobalSidebarDockedVisibility => ({
  left: Boolean(value.left),
  right: Boolean(value.right),
});

export const calculateGlobalAvailableWidth = (
  rootWidth: number,
  docked: GlobalSidebarDockedVisibility,
): number => {
  if (!Number.isFinite(rootWidth)) return 0;
  return Math.max(
    0,
    rootWidth -
      (docked.left ? GLOBAL_LEFT_SIDEBAR_DOCKED_WIDTH : 0) -
      (docked.right ? GLOBAL_RIGHT_SIDEBAR_DOCKED_WIDTH : 0),
  );
};

export const createInitialGlobalSidebarState = (
  dockedPreference: GlobalSidebarDockedVisibility,
): GlobalSidebarLayoutState => {
  const normalizedPreference = copyDockedVisibility(dockedPreference);
  return {
    mode: "wide",
    docked: copyDockedVisibility(normalizedPreference),
    dockedPreference: normalizedPreference,
    overlay: null,
  };
};

export const deriveGlobalSidebarLayoutMode = (
  currentMode: GlobalSidebarLayoutMode,
  availableCenterWidth: number,
): GlobalSidebarLayoutMode => {
  if (currentMode === "wide") {
    return availableCenterWidth < GLOBAL_CENTER_MIN_INTERACTIVE_WIDTH ? "narrow" : "wide";
  }
  return availableCenterWidth >= GLOBAL_CENTER_MIN_INTERACTIVE_WIDTH_EXIT ? "wide" : "narrow";
};

export const applyGlobalAvailableWidth = (
  state: GlobalSidebarLayoutState,
  availableCenterWidth: number,
): GlobalSidebarLayoutState => {
  const nextMode = deriveGlobalSidebarLayoutMode(state.mode, availableCenterWidth);
  if (nextMode === state.mode) return state;

  if (nextMode === "narrow") {
    return {
      ...state,
      mode: "narrow",
      docked: hiddenDockedVisibility,
      overlay: null,
    };
  }

  return {
    ...state,
    mode: "wide",
    docked: copyDockedVisibility(state.dockedPreference),
    overlay: null,
  };
};

export const toggleGlobalSidebarFromButton = (
  state: GlobalSidebarLayoutState,
  side: GlobalSidebarSide,
): GlobalSidebarLayoutState => {
  if (state.mode === "narrow") {
    if (state.overlay === null) {
      return {
        ...state,
        overlay: side,
      };
    }
    if (state.overlay === side) {
      return {
        ...state,
        overlay: null,
      };
    }
    return state;
  }

  const nextDocked: GlobalSidebarDockedVisibility =
    side === "left"
      ? { left: !state.docked.left, right: state.docked.right }
      : { left: state.docked.left, right: !state.docked.right };

  return {
    ...state,
    docked: nextDocked,
    dockedPreference: copyDockedVisibility(nextDocked),
    overlay: null,
  };
};

