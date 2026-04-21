import { createEffect, onCleanup } from "solid-js";

/**
 * Auto-focus an element when a modal opens.
 * Optionally selects the content (useful for rename inputs).
 */
export function useModalFocus(
  open: () => boolean,
  getRef: () => HTMLInputElement | HTMLTextAreaElement | HTMLElement | undefined,
  options?: { select?: boolean },
) {
  createEffect(() => {
    if (!open()) return;

    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      const el = getRef();
      if (!el) return;
      el.focus();
      if (options?.select && "select" in el) {
        (el as HTMLInputElement).select();
      }
    });

    onCleanup(() => {
      cancelled = true;
      cancelAnimationFrame(frame);
    });
  });
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Full ARIA focus trap for complex modals.
 * Traps Tab cycling, handles Escape, restores focus on close.
 */
export function useFocusTrap(
  open: () => boolean,
  getDialogRef: () => HTMLElement | undefined,
  options: {
    onClose: () => void;
    getInitialFocus?: () => HTMLElement | undefined;
    onOpen?: () => void;
  },
) {
  createEffect(() => {
    if (!open()) return;

    options.onOpen?.();

    const dialogRef = getDialogRef();

    const getFocusableElements = () =>
      dialogRef
        ? Array.from(dialogRef.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        : [];

    const focusInsideDialog = (target: "first" | "last") => {
      const elements = getFocusableElements();
      const el = target === "first" ? elements[0] : elements[elements.length - 1];
      if (el) el.focus();
      else dialogRef?.focus();
    };

    const previouslyFocusedElement =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      const initial = options.getInitialFocus?.();
      if (initial) {
        initial.focus();
        if ("select" in initial) (initial as HTMLInputElement).select();
      } else {
        dialogRef?.focus();
      }
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        options.onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusableElements = getFocusableElements();
      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements[focusableElements.length - 1];
      const activeElement =
        typeof document !== "undefined" && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;

      if (!focusableElements.length) {
        event.preventDefault();
        dialogRef?.focus();
        return;
      }

      if (!activeElement || !dialogRef || !dialogRef.contains(activeElement)) {
        event.preventDefault();
        focusInsideDialog(event.shiftKey ? "last" : "first");
        return;
      }

      if (event.shiftKey && activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
        return;
      }

      if (!event.shiftKey && activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (dialogRef && dialogRef.contains(target)) return;
      focusInsideDialog("first");
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("focusin", handleFocusIn, true);

    onCleanup(() => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("focusin", handleFocusIn, true);
      if (previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus();
      }
    });
  });
}
