import { Show, type JSX } from "solid-js";
import { startWindowDragging } from "../lib/tauri";
import { isMacPlatform, isTauriRuntime, isWindowsPlatform } from "../utils";
import { LeftSidebarToggleIcon, RightSidebarToggleIcon } from "./session/sidebar-toggle-icons";
import { resolveTitlebarMenuLayout } from "./titlebar-menu-layout";

type TitlebarMenuTogglesProps = {
  leftActive: boolean;
  rightActive: boolean;
  hideTitlebar: boolean;
  centerContent?: JSX.Element;
  onToggleLeft: () => void;
  onToggleRight: () => void;
};

export default function TitlebarMenuToggles(props: TitlebarMenuTogglesProps) {
  const layout = resolveTitlebarMenuLayout({
    tauri: isTauriRuntime(),
    windows: isWindowsPlatform(),
    mac: isMacPlatform(),
    hideTitlebar: props.hideTitlebar,
  });

  const buttonClass = (active: boolean) =>
    `h-6 w-6 flex items-center justify-center bg-transparent transition-colors focus:outline-none focus-visible:ring-0 ${
      active
        ? "text-gray-12"
        : "text-gray-9 hover:text-gray-12"
    }`;

  const handleDragStripMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    if (!props.hideTitlebar) return;
    // Keep explicit startDragging fallback to avoid drag regressions if
    // browser hit-testing around data-tauri-drag-region changes.
    void startWindowDragging().catch(() => {
      // Ignore: data-tauri-drag-region remains the primary drag path.
    });
  };

  return (
    <>
      {layout.dragRegionClass ? (
        <div
          data-tauri-drag-region
          class={layout.dragRegionClass}
          onMouseDown={handleDragStripMouseDown}
        />
      ) : null}
      <div class={layout.rootClass}>
        <div class={layout.leftOffsetClass}>
          <div class="flex items-center gap-2.5">
            <button
              type="button"
              class={buttonClass(props.leftActive)}
              onClick={() => props.onToggleLeft()}
              aria-label="Toggle left menu"
              title="Toggle left menu"
            >
              <LeftSidebarToggleIcon size={18} />
            </button>
            <span class="truncate text-[13px] font-medium leading-6 text-gray-12">
              Veslo by Neatech
            </span>
          </div>
        </div>

        <Show when={props.centerContent}>
          <div class={layout.centerContentClass}>
            <div class="pointer-events-auto min-w-0 max-w-full truncate text-[12px] leading-6 text-gray-10">
              {props.centerContent}
            </div>
          </div>
        </Show>

        <div class={layout.rightOffsetClass}>
          <button
            type="button"
            class={buttonClass(props.rightActive)}
            onClick={() => props.onToggleRight()}
            aria-label="Toggle right menu"
            title="Toggle right menu"
          >
            <RightSidebarToggleIcon size={18} />
          </button>
        </div>
      </div>
    </>
  );
}
