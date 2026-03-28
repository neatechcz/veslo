export type TitlebarMenuLayoutInputs = {
  tauri: boolean;
  windows: boolean;
  mac: boolean;
  hideTitlebar: boolean;
};

export type TitlebarContentInsetInputs = {
  tauri: boolean;
  mac: boolean;
  hideTitlebar: boolean;
};

export type TitlebarMenuLayout = {
  rootClass: string;
  leftOffsetClass: string;
  centerContentClass: string;
  rightOffsetClass: string;
  dragRegionClass: string | null;
};

const TAURI_OVERLAY_ROOT_CLASS =
  "pointer-events-none fixed inset-x-0 top-0 z-[60] flex items-start justify-between";
const FALLBACK_ROOT_CLASS = "pointer-events-none fixed inset-y-0 left-0 right-0 z-[60] flex items-center justify-between";
const TAURI_DRAG_REGION_CLASS =
  "pointer-events-auto fixed inset-x-0 top-0 z-[59] h-9";

export const resolveTitlebarMenuLayout = ({
  tauri,
  windows,
  mac,
  hideTitlebar,
}: TitlebarMenuLayoutInputs): TitlebarMenuLayout => {
  if (!tauri) {
    return {
      rootClass: FALLBACK_ROOT_CLASS,
      leftOffsetClass: "pointer-events-auto ml-2",
      centerContentClass: "pointer-events-none absolute inset-x-0 top-0 z-10 flex h-9 items-center justify-center px-20",
      rightOffsetClass: "pointer-events-auto mr-2",
      dragRegionClass: null,
    };
  }

  if (windows) {
    return {
      rootClass: TAURI_OVERLAY_ROOT_CLASS,
      leftOffsetClass: "pointer-events-auto relative z-10 mt-1 ml-2.5",
      centerContentClass: "pointer-events-none absolute inset-x-0 top-0 z-10 flex h-9 items-start justify-center px-[176px] pt-1",
      rightOffsetClass: "pointer-events-auto relative z-10 mt-1 mr-[136px]",
      dragRegionClass: hideTitlebar ? TAURI_DRAG_REGION_CLASS : null,
    };
  }

  if (mac) {
    return {
      rootClass: TAURI_OVERLAY_ROOT_CLASS,
      leftOffsetClass: "pointer-events-auto relative z-10 mt-0.5 ml-[66px]",
      centerContentClass: "pointer-events-none absolute inset-x-0 top-0 z-10 flex h-9 items-start justify-center px-[152px] pt-0.5",
      rightOffsetClass: "pointer-events-auto relative z-10 mt-0.5 mr-2",
      dragRegionClass: TAURI_DRAG_REGION_CLASS,
    };
  }

  return {
    rootClass: TAURI_OVERLAY_ROOT_CLASS,
    leftOffsetClass: "pointer-events-auto relative z-10 mt-2 ml-[72px]",
    centerContentClass: "pointer-events-none absolute inset-x-0 top-0 z-10 flex h-9 items-start justify-center px-[152px] pt-2",
    rightOffsetClass: "pointer-events-auto relative z-10 mt-2 mr-3",
    dragRegionClass: hideTitlebar ? TAURI_DRAG_REGION_CLASS : null,
  };
};

export const resolveTitlebarContentInsetClass = ({
  tauri,
  mac,
  hideTitlebar,
}: TitlebarContentInsetInputs): string => {
  if (!tauri || !mac || hideTitlebar) return "";
  return "pt-7";
};
