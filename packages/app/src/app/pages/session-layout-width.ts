import type { SidebarLayoutState } from "../components/session/sidebar-layout-model";
import {
  LEFT_SIDEBAR_WIDTH_DEFAULT,
  clampLeftSidebarWidth,
} from "../components/layout/left-sidebar-width-prefs";

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
