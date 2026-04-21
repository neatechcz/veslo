import { createEffect, onCleanup } from "solid-js";

/**
 * Close a menu/popup when the user clicks outside the given ref element.
 */
export function useOutsideClick(
  isOpen: () => boolean,
  getRef: () => Element | undefined,
  onClose: () => void,
  event: "pointerdown" | "click" = "pointerdown",
) {
  createEffect(() => {
    if (!isOpen()) return;
    const handler = (e: Event) => {
      const ref = getRef();
      if (!ref) return;
      const target = e.target as Node | null;
      if (target && ref.contains(target)) return;
      onClose();
    };
    window.addEventListener(event, handler);
    onCleanup(() => window.removeEventListener(event, handler));
  });
}
