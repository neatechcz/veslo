import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";

import type {
  SidebarMenuEntry,
  SidebarMenuItem,
  SidebarMenuPlacement,
} from "./sidebar-context-menu-types";

type SidebarContextMenuProps = {
  open: boolean;
  placement: SidebarMenuPlacement | null;
  entries: SidebarMenuEntry[];
  onClose: () => void;
  testId?: string;
};

type MenuSize = {
  width: number;
  height: number;
};

const VIEWPORT_PADDING = 12;
const ANCHOR_OFFSET = 4;
const DEFAULT_MENU_SIZE: MenuSize = { width: 192, height: 0 };

const clampToViewport = (value: number, size: number, viewportSize: number) => {
  const max = Math.max(VIEWPORT_PADDING, viewportSize - size - VIEWPORT_PADDING);
  return Math.min(Math.max(VIEWPORT_PADDING, value), max);
};

const enabledMenuButtons = (menu: HTMLDivElement | undefined) =>
  Array.from(menu?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? []);

const focusButtonAt = (buttons: HTMLButtonElement[], index: number) => {
  if (!buttons.length) return;
  const nextIndex = ((index % buttons.length) + buttons.length) % buttons.length;
  buttons[nextIndex]?.focus();
};

const activateItem = (entry: SidebarMenuItem, onClose: () => void) => {
  if (entry.disabled) return;
  entry.onSelect();
  onClose();
};

export default function SidebarContextMenu(props: SidebarContextMenuProps) {
  let menuRef: HTMLDivElement | undefined;
  const [menuSize, setMenuSize] = createSignal<MenuSize>(DEFAULT_MENU_SIZE);

  const visiblePlacement = createMemo(() => {
    if (!props.open || !props.placement) return null;
    return props.placement;
  });

  const menuStyle = createMemo<JSX.CSSProperties | undefined>(() => {
    const placement = visiblePlacement();
    if (!placement || typeof window === "undefined") return undefined;

    const size = menuSize();
    const anchorRect = placement.anchorEl?.getBoundingClientRect();
    const rawLeft = anchorRect ? anchorRect.right - size.width : placement.x ?? VIEWPORT_PADDING;
    const rawTop = anchorRect ? anchorRect.bottom + ANCHOR_OFFSET : placement.y ?? VIEWPORT_PADDING;

    return {
      left: `${clampToViewport(rawLeft, size.width, window.innerWidth)}px`,
      top: `${clampToViewport(rawTop, size.height, window.innerHeight)}px`,
    };
  });

  createEffect(() => {
    const placement = visiblePlacement();
    if (!placement) {
      setMenuSize(DEFAULT_MENU_SIZE);
      return;
    }

    props.entries.length;
    queueMicrotask(() => {
      if (!menuRef || !visiblePlacement() || typeof window === "undefined") return;
      const rect = menuRef.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      setMenuSize({ width: rect.width, height: rect.height });
    });
  });

  createEffect(() => {
    if (!visiblePlacement() || typeof window === "undefined") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
        return;
      }

      const buttons = enabledMenuButtons(menuRef);
      const currentIndex = buttons.findIndex((button) => button === document.activeElement);

      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusButtonAt(buttons, currentIndex === -1 ? 0 : currentIndex + 1);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        focusButtonAt(buttons, currentIndex === -1 ? buttons.length - 1 : currentIndex - 1);
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        focusButtonAt(buttons, 0);
        return;
      }

      if (event.key === "End") {
        event.preventDefault();
        focusButtonAt(buttons, buttons.length - 1);
        return;
      }

      if (event.key !== "Enter" && event.key !== " ") return;
      const activeButton = buttons[currentIndex];
      if (!activeButton) return;
      event.preventDefault();
      activeButton.click();
    };

    const closeMenu = () => props.onClose();

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("scroll", closeMenu, true);

    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    });
  });

  return (
    <Show when={visiblePlacement()}>
      <div
        class="fixed inset-0 z-[100]"
        onClick={props.onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onClose();
        }}
      >
        <div
          ref={(el) => (menuRef = el)}
          class="fixed z-[101] w-48 max-h-[calc(100vh-24px)] overflow-y-auto rounded-lg border border-gray-6 bg-gray-1 shadow-2xl shadow-gray-12/10 p-1"
          style={menuStyle()}
          role="menu"
          data-testid={props.testId ?? "sidebar-context-menu"}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <For each={props.entries}>
            {(entry) => {
              switch (entry.kind) {
                case "item":
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
                      classList={{
                        "text-red-11": Boolean(entry.danger),
                        "opacity-50": Boolean(entry.disabled),
                      }}
                      aria-disabled={entry.disabled ? "true" : undefined}
                      disabled={entry.disabled}
                      tabIndex={-1}
                      onClick={() => activateItem(entry, props.onClose)}
                    >
                      {entry.label}
                    </button>
                  );
                case "separator":
                  return <div class="my-1 border-t border-gray-6/70" role="separator" />;
                case "label":
                  return <div class="px-2 py-1 text-[11px] uppercase tracking-wide text-gray-9">{entry.label}</div>;
              }
            }}
          </For>
        </div>
      </div>
    </Show>
  );
}
