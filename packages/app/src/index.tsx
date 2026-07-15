/* @refresh reload */
import { ErrorBoundary, lazy, Suspense } from "solid-js";
import { render } from "solid-js/web";
import { HashRouter, Route, Router } from "@solidjs/router";

import { bootstrapTheme } from "./app/theme";
import "./app/index.css";
import AppEntry from "./app/entry";
import { RendererErrorFallback } from "./app/components/renderer-error-boundary";
import packageJson from "../package.json";
import { PlatformProvider, type Platform } from "./app/context/platform";
import { isTauriRuntime } from "./app/utils";
import { initErrorMonitoring } from "./app/lib/error-monitoring";
import { reportError } from "./app/lib/error-reporter";
import { resolveDeveloperModeFromWindowLocation } from "./app/lib/developer-mode";
import { recordPerfLog } from "./app/lib/perf-log";
import {
  installStartupRequestAudit,
  resolveStartupRequestAuditWindowMs,
} from "./app/lib/startup-request-audit";
import { initLocale } from "./i18n";

bootstrapTheme();
initLocale();

const appPlatform = isTauriRuntime() ? "desktop" : "web";
const StagingRendererCanary = __VESLO_STAGING_RENDERER_CANARY__
  ? lazy(() => import("./app/components/staging-renderer-canary"))
  : () => null;

initErrorMonitoring(import.meta.env, {
  appVersion: packageJson.version,
  platform: appPlatform,
});

if (import.meta.env.DEV && resolveDeveloperModeFromWindowLocation(window.location)) {
  void import("@solid-devtools/overlay")
    .then(({ attachDevtoolsOverlay }) => attachDevtoolsOverlay())
    .catch((error: unknown) => reportError(error, "init.solidDevtools"));
}

const readStoredRequestAuditWindowMs = () => {
  try {
    return window.localStorage.getItem("veslo:request-audit-window-ms");
  } catch {
    return null;
  }
};

installStartupRequestAudit({
  enabled: isTauriRuntime(),
  windowMs: resolveStartupRequestAuditWindowMs({
    envValue: import.meta.env.VITE_VESLO_REQUEST_AUDIT_WINDOW_MS,
    storedValue: readStoredRequestAuditWindowMs(),
  }),
  log: (event, payload) => recordPerfLog(true, "workspace.requests", event, payload),
});

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

const RouterComponent = isTauriRuntime() ? HashRouter : Router;

const platform: Platform = {
  platform: appPlatform,
  openLink(url: string) {
    if (isTauriRuntime()) {
      void import("@tauri-apps/plugin-opener")
        .then(({ openUrl }) => openUrl(url))
        .catch(e => reportError(e, "init.tauriSetup"));
      return;
    }

    window.open(url, "_blank");
  },
  restart: async () => {
    if (isTauriRuntime()) {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
      return;
    }

    window.location.reload();
  },
  notify: async (title, description, href) => {
    if (!("Notification" in window)) return;

    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission().catch(() => "denied")
        : Notification.permission;

    if (permission !== "granted") return;

    const inView = document.visibilityState === "visible" && document.hasFocus();
    if (inView) return;

    await Promise.resolve()
      .then(() => {
        const notification = new Notification(title, {
          body: description ?? "",
        });
        notification.onclick = () => {
          window.focus();
          if (href) {
            window.history.pushState(null, "", href);
            window.dispatchEvent(new PopStateEvent("popstate"));
          }
          notification.close();
        };
      })
      .catch(e => reportError(e, "init.tauriSetup"));
  },
  storage: (name) => {
    const prefix = name ? `${name}:` : "";
    return {
      getItem: (key) => window.localStorage.getItem(prefix + key),
      setItem: (key, value) => window.localStorage.setItem(prefix + key, value),
      removeItem: (key) => window.localStorage.removeItem(prefix + key),
    };
  },
  fetch,
};

render(
  () => {
    // Dismiss the splash screen once the app shell has mounted.
    queueMicrotask(() => {
      const splash = document.getElementById("splash");
      if (splash) {
        splash.classList.add("splash-hidden");
        splash.addEventListener("transitionend", () => splash.remove(), { once: true });
      }
    });

    return (
      <ErrorBoundary
        fallback={(error) => (
          <RendererErrorFallback
            error={error}
            restart={platform.restart}
            reload={() => window.location.reload()}
          />
        )}
      >
        <Suspense>
          <StagingRendererCanary />
        </Suspense>
        <PlatformProvider value={platform}>
          <RouterComponent root={AppEntry}>
            <Route path="*all" component={() => null} />
          </RouterComponent>
        </PlatformProvider>
      </ErrorBoundary>
    );
  },
  root,
);
