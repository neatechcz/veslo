import { Show, type JSX } from "solid-js";
import { Minus, Square, X } from "lucide-solid";
import {
  closeCurrentWindow,
  minimizeCurrentWindow,
  startWindowDragging,
  toggleMaximizeCurrentWindow,
} from "../lib/tauri";
import { isMacPlatform, isTauriRuntime, isWindowsPlatform } from "../utils";
import { LeftSidebarToggleIcon, RightSidebarToggleIcon } from "./session/sidebar-toggle-icons";
import { resolveTitlebarMenuLayout } from "./titlebar-menu-layout";
import { currentLocale as __vesloCurrentLocale, t as __vesloT } from "../../i18n";

type TitlebarMenuTogglesProps = {
  leftActive: boolean;
  rightActive: boolean;
  hideTitlebar: boolean;
  leftContent?: JSX.Element;
  centerContent?: JSX.Element;
  rightContent?: JSX.Element;
  showBrand?: boolean;
  leftLabel?: string;
  onToggleLeft: () => void;
  onToggleRight: () => void;
};

export default function TitlebarMenuToggles(props: TitlebarMenuTogglesProps) {
  const isTauri = isTauriRuntime();
  const isWindows = isWindowsPlatform();
  const isMac = isMacPlatform();
  const layout = resolveTitlebarMenuLayout({
    tauri: isTauri,
    windows: isWindows,
    mac: isMac,
    hideTitlebar: props.hideTitlebar,
  });
  const showWindowsWindowControls = isTauri && isWindows;

  const buttonClass = (active: boolean) =>
    `h-6 w-6 flex items-center justify-center bg-transparent transition-colors focus:outline-none focus-visible:ring-0 ${
      active
        ? "text-gray-12"
        : "text-gray-9 hover:text-gray-12"
    }`;
  const leftLabel = () => props.leftLabel ?? __vesloT("sidebar.toggle_left_menu", __vesloCurrentLocale());

  const handleTitlebarDragMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || event.detail !== 1) return;
    // Keep explicit startDragging fallback for titlebar text hit-testing while
    // letting Tauri handle direct drag-region double-clicks.
    void startWindowDragging().catch(() => {
      // Ignore: data-tauri-drag-region remains the primary drag path.
    });
  };
  const handleTitlebarDoubleClick = (event: MouseEvent) => {
    if (!isTauri) return;
    if (event.target === event.currentTarget) return;
    void toggleMaximizeCurrentWindow().catch((error) => {
      console.error("[titlebar.windowControls] Failed to toggle maximize from titlebar double-click", error);
    });
  };
  const runWindowControl = (label: string, action: () => Promise<void>) => {
    void action().catch((error) => {
      console.error(`[titlebar.windowControls] Failed to ${label}`, error);
    });
  };
  const windowControlButtonClass =
    "inline-flex h-9 w-11 items-center justify-center bg-transparent text-gray-9 transition-colors hover:bg-gray-3/80 hover:text-gray-12 focus:outline-none focus-visible:ring-0";

  return (
    <>
      {layout.dragRegionClass ? (
        <div
          data-tauri-drag-region
          class={layout.dragRegionClass}
        />
      ) : null}
      <div class={layout.rootClass}>
        <div class={layout.leftOffsetClass}>
          <div class="flex items-center gap-2.5">
            <button
              type="button"
              class={buttonClass(props.leftActive)}
              onClick={() => props.onToggleLeft()}
              aria-label={leftLabel()}
              title={leftLabel()}
            >
              <LeftSidebarToggleIcon size={18} />
            </button>
            {props.leftContent ?? (props.showBrand !== false ? (
              <span
                data-tauri-drag-region
                onMouseDown={handleTitlebarDragMouseDown}
                onDblClick={handleTitlebarDoubleClick}
                class="select-none truncate text-[13px] font-medium leading-6 text-gray-12"
              >
                {__vesloT("ui.literal.veslo_by_neatech_86m8cx", __vesloCurrentLocale())}</span>
            ) : null)}
          </div>
        </div>

        <Show when={props.centerContent}>
          <div class={layout.centerContentClass}>
            <div
              data-tauri-drag-region
              onMouseDown={handleTitlebarDragMouseDown}
              onDblClick={handleTitlebarDoubleClick}
              class="pointer-events-auto min-w-0 max-w-full select-none truncate text-[12px] leading-6 text-gray-10"
            >
              {props.centerContent}
            </div>
          </div>
        </Show>

        <div class={`${layout.rightOffsetClass} flex shrink-0 flex-nowrap items-center gap-1`}>
          {props.rightContent}
          <button
            type="button"
            class={buttonClass(props.rightActive)}
            onClick={() => props.onToggleRight()}
            aria-label={__vesloT("ui.literal.toggle_right_menu_1n4xog", __vesloCurrentLocale())}
            title={__vesloT("ui.literal.toggle_right_menu_1n4xog", __vesloCurrentLocale())}
          >
            <RightSidebarToggleIcon size={18} />
          </button>
          <Show when={showWindowsWindowControls}>
            <div class="ml-1 flex h-9 overflow-hidden">
              <button
                type="button"
                class={windowControlButtonClass}
                onClick={() => runWindowControl("minimize window", minimizeCurrentWindow)}
                aria-label={__vesloT("ui.literal.minimize_window_1rr7i2", __vesloCurrentLocale())}
                title={__vesloT("ui.literal.minimize_window_1rr7i2", __vesloCurrentLocale())}
              >
                <Minus size={13} />
              </button>
              <button
                type="button"
                class={windowControlButtonClass}
                onClick={() => runWindowControl("toggle maximize", toggleMaximizeCurrentWindow)}
                aria-label={__vesloT("ui.literal.maximize_or_restore_window_5ds1ae", __vesloCurrentLocale())}
                title={__vesloT("ui.literal.maximize_or_restore_window_5ds1ae", __vesloCurrentLocale())}
              >
                <Square size={11} />
              </button>
              <button
                type="button"
                class={`${windowControlButtonClass} hover:bg-red-9 hover:text-white`}
                onClick={() => runWindowControl("close window", closeCurrentWindow)}
                aria-label={__vesloT("ui.literal.close_window_1vvpub", __vesloCurrentLocale())}
                title={__vesloT("ui.literal.close_window_1vvpub", __vesloCurrentLocale())}
              >
                <X size={14} />
              </button>
            </div>
          </Show>
        </div>
      </div>
    </>
  );
}
