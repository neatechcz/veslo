import { Show, createEffect, onCleanup, type JSX } from "solid-js";

export type ModalLayer = "default" | "elevated" | "top";
export type ModalBackdrop = "light" | "medium";
export type ModalSize = "sm" | "md" | "lg" | "none";
export type ModalAlign = "center" | "start";

type AriaRole = NonNullable<JSX.HTMLAttributes<HTMLDivElement>["role"]>;

export type ModalShellProps = {
  open: boolean;
  onClose?: () => void;
  layer?: ModalLayer;
  backdrop?: ModalBackdrop;
  size?: ModalSize;
  align?: ModalAlign;
  class?: string;
  role?: AriaRole;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  children: JSX.Element;
};

const LAYER_CLASS: Record<ModalLayer, string> = {
  default: "z-50",
  elevated: "z-[60]",
  top: "z-[70]",
};

const BACKDROP_CLASS: Record<ModalBackdrop, string> = {
  light: "bg-gray-1/60",
  medium: "bg-gray-1/70",
};

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-xl",
  none: "",
};

const ALIGN_CLASS: Record<ModalAlign, string> = {
  center: "items-center",
  start: "items-start pt-[10vh]",
};

export default function ModalShell(props: ModalShellProps) {
  let rootRef: HTMLDivElement | undefined;
  const layer = () => props.layer ?? "default";
  const backdrop = () => props.backdrop ?? "light";
  const size = () => props.size ?? "md";
  const align = () => props.align ?? "center";

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) props.onClose?.();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose?.();
    }
  };

  createEffect(() => {
    if (!props.open) return;
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Escape") return;
      const modalRoots = Array.from(document.querySelectorAll("[data-modal-shell-root]"));
      if (rootRef && modalRoots.at(-1) !== rootRef) return;
      event.preventDefault();
      props.onClose?.();
    };
    window.addEventListener("keydown", closeFromEscape, true);
    onCleanup(() => window.removeEventListener("keydown", closeFromEscape, true));
  });

  return (
    <Show when={props.open}>
      <div
        ref={rootRef}
        data-modal-shell-root
        class={`fixed inset-0 ${LAYER_CLASS[layer()]} ${BACKDROP_CLASS[backdrop()]} backdrop-blur-sm flex ${ALIGN_CLASS[align()]} justify-center p-4`}
        onClick={handleBackdropClick}
        onKeyDown={handleKeyDown}
      >
        <div
          class={`bg-gray-2 border border-gray-6/70 w-full ${SIZE_CLASS[size()]} rounded-2xl shadow-2xl overflow-hidden ${props.class ?? ""}`}
          role={props.role ?? "dialog"}
          aria-modal="true"
          aria-labelledby={props.ariaLabelledBy}
          aria-describedby={props.ariaDescribedBy}
        >
          {props.children}
        </div>
      </div>
    </Show>
  );
}
