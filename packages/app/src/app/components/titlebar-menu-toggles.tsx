import { isWindowsPlatform } from "../utils";
import { LeftSidebarToggleIcon, RightSidebarToggleIcon } from "./session/sidebar-toggle-icons";

type TitlebarMenuTogglesProps = {
  leftActive: boolean;
  rightActive: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
};

export default function TitlebarMenuToggles(props: TitlebarMenuTogglesProps) {
  const windows = isWindowsPlatform();
  const leftOffsetClass = windows ? "ml-3" : "ml-[72px]";
  const rightOffsetClass = windows ? "mr-[140px]" : "mr-3";

  const buttonClass = (active: boolean) =>
    `h-9 w-9 flex items-center justify-center rounded-lg border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.22)] ${
      active
        ? "border-gray-7 bg-gray-3 text-gray-12"
        : "border-gray-6 bg-gray-2/80 text-gray-10 hover:bg-gray-3 hover:text-gray-12"
    }`;

  return (
    <div class="pointer-events-none fixed inset-x-0 top-1 z-[60] flex items-center justify-between">
      <div class={`pointer-events-auto ${leftOffsetClass}`}>
        <button
          type="button"
          class={buttonClass(props.leftActive)}
          onClick={() => props.onToggleLeft()}
          aria-label="Toggle left menu"
          title="Toggle left menu"
        >
          <LeftSidebarToggleIcon size={18} />
        </button>
      </div>

      <div class={`pointer-events-auto ${rightOffsetClass}`}>
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
  );
}
