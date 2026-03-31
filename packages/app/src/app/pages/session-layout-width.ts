import type { SidebarLayoutState } from "../components/session/sidebar-layout-model";
import {
  LEFT_SIDEBAR_WIDTH_DEFAULT,
  clampLeftSidebarWidth,
} from "../components/layout/left-sidebar-width-prefs";
import {
  applyAvailableWidth,
  SESSION_CHAT_MIN_WIDTH,
  SESSION_CHAT_MIN_WIDTH_EXIT,
} from "../components/session/sidebar-layout-model";

export const LEFT_SIDEBAR_DOCKED_WIDTH = LEFT_SIDEBAR_WIDTH_DEFAULT;
export const RIGHT_SIDEBAR_DOCKED_WIDTH = 280;

const effectiveDockedForWidth = (state: SidebarLayoutState) =>
  state.mode === "narrow" ? state.dockedPreference : state.docked;

export const availableChatWidthForLayout = (
  rootWidth: number,
  state: SidebarLayoutState,
  leftSidebarDockedWidth = LEFT_SIDEBAR_DOCKED_WIDTH,
) => {
  if (!Number.isFinite(rootWidth)) return 0;
  const normalizedLeftWidth = clampLeftSidebarWidth(leftSidebarDockedWidth);
  const docked = effectiveDockedForWidth(state);
  return Math.max(
    0,
    rootWidth -
      (docked.left ? normalizedLeftWidth : 0) -
      (docked.right ? RIGHT_SIDEBAR_DOCKED_WIDTH : 0),
  );
};

const withDocked = (
  state: SidebarLayoutState,
  docked: { left: boolean; right: boolean },
): SidebarLayoutState => ({
  ...state,
  docked,
  overlay: null,
});

export const reconcileSidebarLayoutForRootWidth = (
  state: SidebarLayoutState,
  rootWidth: number,
  leftSidebarDockedWidth = LEFT_SIDEBAR_DOCKED_WIDTH,
): SidebarLayoutState => {
  let nextState = state;

  if (state.mode === "wide" && state.dockedPreference.left && state.dockedPreference.right) {
    const bothDockedState = withDocked(state, { left: true, right: true });
    const bothDockedWidth = availableChatWidthForLayout(rootWidth, bothDockedState, leftSidebarDockedWidth);

    if (bothDockedWidth < SESSION_CHAT_MIN_WIDTH) {
      const leftOnlyState = withDocked(state, { left: true, right: false });
      const leftOnlyWidth = availableChatWidthForLayout(rootWidth, leftOnlyState, leftSidebarDockedWidth);
      nextState = leftOnlyWidth >= SESSION_CHAT_MIN_WIDTH ? leftOnlyState : bothDockedState;
    } else if (!state.docked.right && bothDockedWidth >= SESSION_CHAT_MIN_WIDTH_EXIT) {
      nextState = bothDockedState;
    }
  }

  const availableChatWidth = availableChatWidthForLayout(rootWidth, nextState, leftSidebarDockedWidth);
  return applyAvailableWidth(nextState, availableChatWidth);
};
