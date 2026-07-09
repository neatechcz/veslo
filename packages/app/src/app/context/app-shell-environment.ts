import { getCurrentWebview } from "@tauri-apps/api/webview";
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

import {
  FONT_ZOOM_STEP,
  applyFontZoom,
  applyWebviewZoom,
  normalizeFontZoom,
  parseFontZoomShortcut,
  persistFontZoom,
  readStoredFontZoom,
  type FontZoomTarget,
  type FontZoomShortcutAction,
} from "../lib/font-zoom";
import { isFileDragTransfer } from "../utils/data-transfer-files";

type AppShellWindowEventMap = {
  blur: FocusEvent;
  dragover: DragEvent;
  drop: DragEvent;
  focus: FocusEvent;
  keydown: KeyboardEvent;
};

type AppShellDocumentEventMap = {
  visibilitychange: Event;
};

type AppShellWindow = {
  addEventListener: <Type extends keyof AppShellWindowEventMap>(
    type: Type,
    listener: (event: AppShellWindowEventMap[Type]) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  removeEventListener: <Type extends keyof AppShellWindowEventMap>(
    type: Type,
    listener: (event: AppShellWindowEventMap[Type]) => void,
    options?: boolean | EventListenerOptions,
  ) => void;
  localStorage: Pick<Storage, "getItem" | "setItem">;
};

type AppShellDocument = {
  addEventListener: <Type extends keyof AppShellDocumentEventMap>(
    type: Type,
    listener: (event: AppShellDocumentEventMap[Type]) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  removeEventListener: <Type extends keyof AppShellDocumentEventMap>(
    type: Type,
    listener: (event: AppShellDocumentEventMap[Type]) => void,
    options?: boolean | EventListenerOptions,
  ) => void;
  hasFocus: () => boolean;
  visibilityState: string;
  documentElement: {
    style: Pick<CSSStyleDeclaration, "removeProperty" | "setProperty">;
  };
};

type FontZoomKeyboardEvent = {
  preventDefault: () => void;
  stopPropagation: () => void;
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
};

export type AppShellEnvironmentDeps = {
  window?: () => AppShellWindow | null | undefined;
  document?: () => AppShellDocument | null | undefined;
  isTauriRuntime: () => boolean;
  isFileDragTransfer?: typeof isFileDragTransfer;
  getCurrentWebview?: () => FontZoomTarget;
  readStoredFontZoom?: typeof readStoredFontZoom;
  persistFontZoom?: typeof persistFontZoom;
  normalizeFontZoom?: typeof normalizeFontZoom;
  parseFontZoomShortcut?: (event: FontZoomKeyboardEvent) => FontZoomShortcutAction | null;
  applyFontZoom?: typeof applyFontZoom;
  applyWebviewZoom?: typeof applyWebviewZoom;
  fontZoomStep?: number;
  effect?: (fn: () => void) => void;
};

export type AppShellEnvironment = {
  documentVisible: Accessor<boolean>;
  appFocused: Accessor<boolean>;
};

function defaultWindow(): AppShellWindow | null {
  return typeof window === "undefined" ? null : window as AppShellWindow;
}

function defaultDocument(): AppShellDocument | null {
  return typeof document === "undefined" ? null : document as AppShellDocument;
}

export function createAppShellEnvironment(deps: AppShellEnvironmentDeps): AppShellEnvironment {
  const getWindow = deps.window ?? defaultWindow;
  const getDocument = deps.document ?? defaultDocument;
  const shouldInterceptFileDrag = deps.isFileDragTransfer ?? isFileDragTransfer;
  const resolveCurrentWebview = deps.getCurrentWebview ?? getCurrentWebview;
  const readFontZoom = deps.readStoredFontZoom ?? readStoredFontZoom;
  const writeFontZoom = deps.persistFontZoom ?? persistFontZoom;
  const clampFontZoom = deps.normalizeFontZoom ?? normalizeFontZoom;
  const parseZoomShortcut = deps.parseFontZoomShortcut ?? parseFontZoomShortcut;
  const applyCssFontZoom = deps.applyFontZoom ?? applyFontZoom;
  const applyNativeFontZoom = deps.applyWebviewZoom ?? applyWebviewZoom;
  const fontZoomStep = deps.fontZoomStep ?? FONT_ZOOM_STEP;
  const lifecycleEffect = deps.effect ?? createEffect;
  const [documentVisible, setDocumentVisible] = createSignal(true);
  const [appFocused, setAppFocused] = createSignal(true);

  lifecycleEffect(() => {
    const doc = getDocument();
    if (!doc) return;

    const update = () => setDocumentVisible(doc.visibilityState !== "hidden");
    update();
    doc.addEventListener("visibilitychange", update);
    onCleanup(() => doc.removeEventListener("visibilitychange", update));
  });

  lifecycleEffect(() => {
    const win = getWindow();
    const doc = getDocument();
    if (!win || !doc) return;

    const updateAppFocused = () => {
      setAppFocused(doc.visibilityState !== "hidden" && doc.hasFocus());
    };

    updateAppFocused();
    win.addEventListener("focus", updateAppFocused);
    win.addEventListener("blur", updateAppFocused);
    doc.addEventListener("visibilitychange", updateAppFocused);
    onCleanup(() => {
      win.removeEventListener("focus", updateAppFocused);
      win.removeEventListener("blur", updateAppFocused);
      doc.removeEventListener("visibilitychange", updateAppFocused);
    });
  });

  lifecycleEffect(() => {
    const win = getWindow();
    if (!win) return;

    const handleGlobalFileDropGuard = (event: DragEvent) => {
      if (shouldInterceptFileDrag(event.dataTransfer) === false) return;
      event.preventDefault();
    };

    win.addEventListener("dragover", handleGlobalFileDropGuard, true);
    win.addEventListener("drop", handleGlobalFileDropGuard, true);
    onCleanup(() => {
      win.removeEventListener("dragover", handleGlobalFileDropGuard, true);
      win.removeEventListener("drop", handleGlobalFileDropGuard, true);
    });
  });

  lifecycleEffect(() => {
    const win = getWindow();
    const doc = getDocument();
    if (!win || !doc) return;
    if (!deps.isTauriRuntime()) return;

    const applyAndPersistFontZoom = (value: number) => {
      const next = clampFontZoom(value);
      writeFontZoom(win.localStorage, next);

      try {
        const webview = resolveCurrentWebview();
        void applyNativeFontZoom(webview, next)
          .then(() => {
            doc.documentElement.style.removeProperty("--veslo-font-size");
          })
          .catch(() => {
            applyCssFontZoom(doc.documentElement.style, next);
          });
      } catch {
        applyCssFontZoom(doc.documentElement.style, next);
      }

      return next;
    };

    let fontZoom = applyAndPersistFontZoom(readFontZoom(win.localStorage) ?? 1);

    const handleZoomShortcut = (event: KeyboardEvent) => {
      const action = parseZoomShortcut(event);
      if (!action) return;

      if (action === "in") {
        fontZoom = applyAndPersistFontZoom(fontZoom + fontZoomStep);
      } else if (action === "out") {
        fontZoom = applyAndPersistFontZoom(fontZoom - fontZoomStep);
      } else {
        fontZoom = applyAndPersistFontZoom(1);
      }

      event.preventDefault();
      event.stopPropagation();
    };

    win.addEventListener("keydown", handleZoomShortcut, true);
    onCleanup(() => win.removeEventListener("keydown", handleZoomShortcut, true));
  });

  return {
    documentVisible,
    appFocused,
  };
}
