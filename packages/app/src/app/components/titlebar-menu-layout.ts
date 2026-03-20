export type TitlebarMenuLayoutInputs = {
  tauri: boolean;
  windows: boolean;
  mac: boolean;
};

export type TitlebarMenuLayout = {
  rootClass: string;
  leftOffsetClass: string;
  rightOffsetClass: string;
};

const TAURI_OVERLAY_ROOT_CLASS =
  "pointer-events-none fixed inset-x-0 top-1 z-[60] flex items-center justify-between";
const FALLBACK_ROOT_CLASS = "pointer-events-none fixed inset-y-0 left-0 right-0 z-[60] flex items-center justify-between";

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
    };
  }

  if (windows) {
    return {
      rootClass: TAURI_OVERLAY_ROOT_CLASS,
      leftOffsetClass: "pointer-events-auto ml-3",
      rightOffsetClass: "pointer-events-auto mr-[140px]",
    };
  }

  if (mac) {
    return {
      rootClass: TAURI_OVERLAY_ROOT_CLASS,
      leftOffsetClass: "pointer-events-auto ml-[72px]",
      rightOffsetClass: "pointer-events-auto mr-3",
    };
  }

  return {
    rootClass: TAURI_OVERLAY_ROOT_CLASS,
    leftOffsetClass: "pointer-events-auto ml-[72px]",
    rightOffsetClass: "pointer-events-auto mr-3",
  };
};
