import { Copy, Check } from "lucide-solid";
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { useTranslate } from "../../i18n";
import { isTauriRuntime } from "../utils";

type ContextMenuState = {
  copied: boolean;
  text: string;
  x: number;
  y: number;
};

const MENU_WIDTH = 176;
const MENU_HEIGHT = 42;
const VIEWPORT_PADDING = 12;

function selectedTextFromFormControl(element: HTMLInputElement | HTMLTextAreaElement): string {
  try {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    if (typeof start !== "number" || typeof end !== "number" || start === end) return "";
    return element.value.slice(Math.min(start, end), Math.max(start, end));
  } catch {
    return "";
  }
}

function closestElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function selectedTextForTarget(target: EventTarget | null): string {
  const element = closestElement(target);
  const editable = element?.closest("input, textarea") ?? null;

  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    const text = selectedTextFromFormControl(editable);
    if (text.length > 0) return text;
  }

  return window.getSelection()?.toString() ?? "";
}

function fallbackCopyText(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.cssText = [
    "position: fixed",
    "left: -9999px",
    "top: 0",
    "opacity: 0",
    "pointer-events: none",
  ].join("; ");
  document.body.append(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return fallbackCopyText(text);
  }
}

export default function DesktopContextMenu() {
  const tr = useTranslate();
  const [menu, setMenu] = createSignal<ContextMenuState | null>(null);
  let copiedResetTimeout: number | undefined;

  if (!isTauriRuntime()) return null;

  const close = () => {
    if (copiedResetTimeout !== undefined) {
      window.clearTimeout(copiedResetTimeout);
      copiedResetTimeout = undefined;
    }
    setMenu(null);
  };

  const menuStyle = createMemo(() => {
    const state = menu();
    if (!state || typeof window === "undefined") return undefined;
    const maxX = Math.max(VIEWPORT_PADDING, window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING);
    const maxY = Math.max(VIEWPORT_PADDING, window.innerHeight - MENU_HEIGHT - VIEWPORT_PADDING);
    return {
      left: `${Math.min(Math.max(VIEWPORT_PADDING, state.x), maxX)}px`,
      top: `${Math.min(Math.max(VIEWPORT_PADDING, state.y), maxY)}px`,
      width: `${MENU_WIDTH}px`,
    };
  });

  const handleCopy = async () => {
    const state = menu();
    if (!state) return;
    const copied = await copyText(state.text);
    if (!copied) return;

    setMenu((current) => (current ? { ...current, copied: true } : current));
    copiedResetTimeout = window.setTimeout(close, 350);
  };

  onMount(() => {
    const handleContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;

      event.preventDefault();
      const text = selectedTextForTarget(event.target);
      if (text.length === 0) {
        close();
        return;
      }

      setMenu({
        copied: false,
        text,
        x: event.clientX,
        y: event.clientY,
      });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    document.addEventListener("contextmenu", handleContextMenu);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);

    onCleanup(() => {
      document.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      if (copiedResetTimeout !== undefined) window.clearTimeout(copiedResetTimeout);
    });
  });

  return (
    <Show when={menu()}>
      {(state) => (
        <div
          class="fixed inset-0 z-[70]"
          onPointerDown={close}
          onContextMenu={(event) => {
            event.preventDefault();
            close();
          }}
        >
          <div
            data-testid="app-copy-context-menu"
            class="fixed z-[71] rounded-lg border border-gray-6 bg-gray-1 p-1 shadow-2xl shadow-gray-12/10"
            role="menu"
            style={menuStyle()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              data-testid="app-copy-context-menu-copy"
              class="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-gray-12 transition-colors hover:bg-gray-2 focus:bg-gray-2 focus:outline-none"
              role="menuitem"
              type="button"
              onClick={() => void handleCopy()}
            >
              <Show when={state().copied} fallback={<Copy size={14} />}>
                <Check size={14} />
              </Show>
              <span class="min-w-0 truncate">{tr("common.copy")}</span>
            </button>
          </div>
        </div>
      )}
    </Show>
  );
}
