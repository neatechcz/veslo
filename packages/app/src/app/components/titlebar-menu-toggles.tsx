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
    `h-6 w-6 flex items-center justify-center bg-transparent transition-colors focus:outline-none focus-visible:ring-0 ${
      active
        ? "text-gray-12"
        : "text-gray-9 hover:text-gray-12"
    }`;

  return (
    <div class={layout.rootClass}>
      {layout.dragRegionClass ? <div data-tauri-drag-region class={layout.dragRegionClass} /> : null}
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
  );
}
