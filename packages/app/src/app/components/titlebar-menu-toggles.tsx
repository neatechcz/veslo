import { startWindowDragging } from "../lib/tauri";
import { isMacPlatform, isTauriRuntime, isWindowsPlatform } from "../utils";
import { LeftSidebarToggleIcon, RightSidebarToggleIcon } from "./session/sidebar-toggle-icons";
import { resolveTitlebarMenuLayout } from "./titlebar-menu-layout";

type TitlebarMenuTogglesProps = {
  leftActive: boolean;
  rightActive: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
};

export default function TitlebarMenuToggles(props: TitlebarMenuTogglesProps) {
  const layout = resolveTitlebarMenuLayout({
    tauri: isTauriRuntime(),
    windows: isWindowsPlatform(),
    mac: isMacPlatform(),
  });

  const buttonClass = (active: boolean) =>
    `h-6 w-6 flex items-center justify-center rounded-md transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-gray-7 ${
      active
        ? "text-gray-12 bg-gray-4/80 hover:bg-gray-5/80 active:bg-gray-6/80"
        : "text-gray-10 hover:text-gray-12 hover:bg-gray-3/80 active:bg-gray-4/80"
    }`;

  const handleDragStripMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
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
        <button
          type="button"
          class={buttonClass(props.leftActive)}
          onClick={() => props.onToggleLeft()}
          aria-label="Toggle left menu"
          title="Toggle left menu"
        >
          <LeftSidebarToggleIcon size={13} />
        </button>
      </div>

      <div class={layout.rightOffsetClass}>
        <button
          type="button"
          class={buttonClass(props.rightActive)}
          onClick={() => props.onToggleRight()}
          aria-label="Toggle right menu"
          title="Toggle right menu"
        >
          <RightSidebarToggleIcon size={13} />
        </button>
      </div>
      </div>
    </>
  );
}
