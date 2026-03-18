export type SidebarSide = "left" | "right";
export type SidebarLayoutMode = "wide" | "narrow";

export type SidebarDockedVisibility = {
  left: boolean;
  right: boolean;
};

export type SidebarLayoutState = {
  mode: SidebarLayoutMode;
  docked: SidebarDockedVisibility;
  dockedPreference: SidebarDockedVisibility;
  overlay: SidebarSide | null;
};

export const SESSION_CHAT_MIN_WIDTH = 760;
export const SESSION_CHAT_MIN_WIDTH_EXIT = 784;

const hiddenDockedVisibility: SidebarDockedVisibility = {
  left: false,
  right: false,
};

const copyDockedVisibility = (value: SidebarDockedVisibility): SidebarDockedVisibility => ({
  left: Boolean(value.left),
  right: Boolean(value.right),
});

export const createInitialSidebarLayoutState = (
  dockedPreference: SidebarDockedVisibility,
): SidebarLayoutState => {
  const normalizedPreference = copyDockedVisibility(dockedPreference);
  return {
    mode: "wide",
    docked: copyDockedVisibility(normalizedPreference),
    dockedPreference: normalizedPreference,
    overlay: null,
  };
};

export const deriveSidebarLayoutMode = (
  currentMode: SidebarLayoutMode,
  availableChatWidth: number,
): SidebarLayoutMode => {
  if (currentMode === "wide") {
    return availableChatWidth < SESSION_CHAT_MIN_WIDTH ? "narrow" : "wide";
  }
  return availableChatWidth >= SESSION_CHAT_MIN_WIDTH_EXIT ? "wide" : "narrow";
};

export const applyAvailableWidth = (
  state: SidebarLayoutState,
  availableChatWidth: number,
): SidebarLayoutState => {
  const nextMode = deriveSidebarLayoutMode(state.mode, availableChatWidth);
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

export const toggleSidebarFromButton = (
  state: SidebarLayoutState,
  side: SidebarSide,
): SidebarLayoutState => {
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

  const nextDocked: SidebarDockedVisibility =
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
