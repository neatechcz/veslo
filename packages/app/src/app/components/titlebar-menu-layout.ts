export type TitlebarMenuLayoutInputs = {
  tauri: boolean;
  windows: boolean;
  mac: boolean;
};

export type TitlebarMenuLayout = {
  rootClass: string;
  leftOffsetClass: string;
  rightOffsetClass: string;
  dragRegionClass: string | null;
};

const TAURI_OVERLAY_ROOT_CLASS =
  "pointer-events-none fixed inset-x-0 top-0 z-[60] flex items-start justify-between";
const FALLBACK_ROOT_CLASS = "pointer-events-none fixed inset-y-0 left-0 right-0 z-[60] flex items-center justify-between";
const TAURI_DRAG_REGION_CLASS =
  "pointer-events-auto absolute inset-x-0 top-0 h-9 cursor-grab active:cursor-grabbing";

export const resolveTitlebarMenuLayout = ({
  tauri,
  windows,
  mac,
}: TitlebarMenuLayoutInputs): TitlebarMenuLayout => {
  if (!tauri) {
    return {
      rootClass: FALLBACK_ROOT_CLASS,
      leftOffsetClass: "pointer-events-auto ml-2",
      rightOffsetClass: "pointer-events-auto mr-2",
      dragRegionClass: null,
    };
  }

  if (windows) {
    return {
      rootClass: TAURI_OVERLAY_ROOT_CLASS,
      leftOffsetClass: "pointer-events-auto relative z-10 mt-2 ml-3",
      rightOffsetClass: "pointer-events-auto relative z-10 mt-2 mr-[140px]",
      dragRegionClass: TAURI_DRAG_REGION_CLASS,
    };
  }

  if (mac) {
    return {
      rootClass: TAURI_OVERLAY_ROOT_CLASS,
      leftOffsetClass: "pointer-events-auto relative z-10 mt-2 ml-[72px]",
      rightOffsetClass: "pointer-events-auto relative z-10 mt-2 mr-3",
      dragRegionClass: TAURI_DRAG_REGION_CLASS,
    };
  }

  return {
    rootClass: TAURI_OVERLAY_ROOT_CLASS,
    leftOffsetClass: "pointer-events-auto relative z-10 mt-2 ml-[72px]",
    rightOffsetClass: "pointer-events-auto relative z-10 mt-2 mr-3",
    dragRegionClass: TAURI_DRAG_REGION_CLASS,
  };
};
