import type { SidebarLayoutState } from "../components/session/sidebar-layout-model";

export const LEFT_SIDEBAR_DOCKED_WIDTH = 260;
export const RIGHT_SIDEBAR_DOCKED_WIDTH = 280;

const effectiveDockedForWidth = (state: SidebarLayoutState) =>
  state.mode === "narrow" ? state.dockedPreference : state.docked;

export const availableChatWidthForLayout = (rootWidth: number, state: SidebarLayoutState) => {
  if (!Number.isFinite(rootWidth)) return 0;
  const docked = effectiveDockedForWidth(state);
  return Math.max(
    0,
    rootWidth -
      (docked.left ? LEFT_SIDEBAR_DOCKED_WIDTH : 0) -
      (docked.right ? RIGHT_SIDEBAR_DOCKED_WIDTH : 0),
  );
};
