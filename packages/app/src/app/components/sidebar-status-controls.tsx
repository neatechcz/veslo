import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Cpu, LogIn, LogOut, Server, Settings, User } from "lucide-solid";

import type { VesloServerConnectionSnapshot } from "../lib/veslo-server";
import { readDenAuth, resolveAuthenticatedDenUserLabel, subscribeDenAuthChanges } from "../lib/den-auth";
import {
  getUnifiedStatusMeta,
  getRuntimeReadinessMeta,
  resolveConnectedUserLabel,
  getVesloStatusMeta,
} from "./sidebar-status-controls.model";
import { currentLocale as __vesloCurrentLocale, t as __vesloT } from "../../i18n";

type SidebarStatusControlsProps = {
  clientConnected: boolean;
  vesloServerConnection: VesloServerConnectionSnapshot;
  runtimeAvailableWithoutClient?: boolean;
  authenticatedUser?: string | null;
  onOpenSettings: () => void;
  onLogout?: () => Promise<void> | void;
  onSignIn?: () => Promise<void> | void;
};

export default function SidebarStatusControls(props: SidebarStatusControlsProps) {
  const [statusDetailOpen, setStatusDetailOpen] = createSignal(false);
  const [accountMenuOpen, setAccountMenuOpen] = createSignal(false);
  const [denAuthRevision, setDenAuthRevision] = createSignal(0);

  onMount(() => {
    const unsubscribe = subscribeDenAuthChanges(() => setDenAuthRevision((v) => v + 1));
    onCleanup(unsubscribe);
  });

  let statusControlRef: HTMLDivElement | undefined;
  let statusPopoverRef: HTMLDivElement | undefined;
  let accountControlRef: HTMLDivElement | undefined;
  let accountMenuRef: HTMLDivElement | undefined;

  const closeStatusDetail = () => setStatusDetailOpen(false);
  const closeAccountMenu = () => setAccountMenuOpen(false);
  const toggleStatusDetail = () => {
    closeAccountMenu();
    setStatusDetailOpen((prev) => !prev);
  };
  const toggleAccountMenu = () => {
    closeStatusDetail();
    setAccountMenuOpen((prev) => !prev);
  };

  createEffect(() => {
    if (!statusDetailOpen()) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (statusControlRef?.contains(target)) return;
      if (statusPopoverRef?.contains(event.target as Node)) return;
      closeStatusDetail();
    };
    window.addEventListener("click", onClick, true);
    onCleanup(() => window.removeEventListener("click", onClick, true));
  });

  createEffect(() => {
    if (!accountMenuOpen()) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (accountControlRef?.contains(target)) return;
      if (accountMenuRef?.contains(target)) return;
      closeAccountMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAccountMenu();
    };
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKeyDown);
    });
  });

  const vesloStatusMeta = createMemo(() =>
    getVesloStatusMeta(props.vesloServerConnection.serverReachability)
  );
  const runtimeReadinessMeta = createMemo(() =>
    getRuntimeReadinessMeta(props.vesloServerConnection.runtimeReadiness)
  );

  const persistedAuthenticatedUserLabel = createMemo(() => {
    denAuthRevision();
    return resolveAuthenticatedDenUserLabel(readDenAuth());
  });
  const authenticatedUserLabel = createMemo(() =>
    resolveConnectedUserLabel(props.authenticatedUser, persistedAuthenticatedUserLabel())
  );
  const accountButtonLabel = createMemo(
    () => `${__vesloT("ui.literal.logged_in_user_1rsfga", __vesloCurrentLocale())}: ${authenticatedUserLabel()}`,
  );
  const isLoggedIn = createMemo(() => {
    denAuthRevision();
    return Boolean(props.authenticatedUser?.trim() || readDenAuth()?.token?.trim());
  });
  const unifiedStatusMeta = createMemo(() =>
    getUnifiedStatusMeta(
      props.clientConnected,
      props.vesloServerConnection.serverReachability,
      props.runtimeAvailableWithoutClient ?? false,
      isLoggedIn(),
    )
  );

  const handleLogoutClick = () => {
    closeAccountMenu();
    if (!props.onLogout) return;
    void props.onLogout();
  };

  const handleSignInClick = () => {
    closeAccountMenu();
    if (!props.onSignIn) return;
    void props.onSignIn();
  };

  return (
    <div class="mt-3 pt-3">
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-gray-6 bg-gray-1 text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-11"
          onClick={props.onOpenSettings}
          title={__vesloT("dashboard.settings", __vesloCurrentLocale())}
          aria-label={__vesloT("dashboard.settings", __vesloCurrentLocale())}
        >
          <Settings size={14} />
        </button>

        <div class="relative" ref={(el) => (statusControlRef = el)}>
          <button
            type="button"
            data-testid="sidebar-connection-status-button"
            class="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-gray-6 bg-gray-1 transition-colors hover:bg-gray-2"
            onClick={toggleStatusDetail}
            title={__vesloT("ui.literal.connection_status_1edemn", __vesloCurrentLocale())}
            aria-label={__vesloT("ui.literal.connection_status_1edemn", __vesloCurrentLocale())}
          >
            <span class={`h-2 w-2 rounded-full ${unifiedStatusMeta().dot}`} />
          </button>

          <Show when={statusDetailOpen()}>
            <div
              ref={statusPopoverRef}
              class="absolute bottom-full left-0 mb-2 z-[120] w-64 rounded-xl border border-gray-6 bg-gray-2 shadow-xl p-3 space-y-2"
            >
              <div class="text-[11px] font-medium text-gray-11 uppercase tracking-wider">
                {__vesloT("ui.literal.service_status_1bu4g6", __vesloCurrentLocale())}</div>
              <div class="space-y-1.5">
                <div class="flex items-center gap-1.5 text-xs text-gray-10">
                  <User size={12} class="text-gray-9" />
                  <span>{__vesloT("ui.literal.logged_in_hfeve2", __vesloCurrentLocale())}</span>
                  <span class="ml-auto max-w-[12.5rem] truncate text-right text-gray-11" title={authenticatedUserLabel()}>
                    {authenticatedUserLabel()}
                  </span>
                </div>
                <div class="flex items-center gap-1.5 text-xs text-gray-10">
                  <Server size={12} class="text-gray-9" />
                  <span>{__vesloT("skills.stat_server", __vesloCurrentLocale())}</span>
                  <span data-testid="sidebar-veslo-server-status" class={`ml-auto ${vesloStatusMeta().text}`}>
                    {vesloStatusMeta().label}
                  </span>
                </div>
                <Show when={runtimeReadinessMeta()}>
                  <div class="flex items-center gap-1.5 text-xs text-gray-10">
                    <Cpu size={12} class="text-gray-9" />
                    <span>{__vesloT("ui.literal.engine_runtime_d5h13b", __vesloCurrentLocale())}</span>
                    <span
                      data-testid="sidebar-runtime-readiness-status"
                      class={`ml-auto ${runtimeReadinessMeta()?.text ?? ""}`}
                    >
                      {runtimeReadinessMeta()?.label}
                    </span>
                  </div>
                </Show>
              </div>
            </div>
          </Show>
        </div>

        <div class="relative min-w-0 flex-1" ref={(el) => (accountControlRef = el)}>
          <button
            type="button"
            class="w-full min-w-0 inline-flex items-center gap-1.5 rounded-lg border border-gray-6 bg-gray-1 px-2.5 py-1.5 text-xs text-gray-11 transition-colors hover:bg-gray-2 hover:text-gray-12"
            title={accountButtonLabel()}
            aria-label={accountButtonLabel()}
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen()}
            onClick={toggleAccountMenu}
          >
            <User size={12} class="text-gray-9 shrink-0" />
            <span class="truncate">{authenticatedUserLabel()}</span>
          </button>

          <Show when={accountMenuOpen()}>
            <div
              ref={(el) => (accountMenuRef = el)}
              role="menu"
              class="absolute bottom-full left-0 mb-2 z-[120] w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-6 bg-gray-2 shadow-xl p-2"
            >
              <div class="px-2 py-2">
                <div class="text-[11px] font-medium uppercase tracking-wider text-gray-9">{__vesloT("ui.literal.account_oyp43g", __vesloCurrentLocale())}</div>
                <div class="mt-1 truncate text-xs text-gray-12" title={authenticatedUserLabel()}>
                  {authenticatedUserLabel()}
                </div>
              </div>
              <Show when={props.onLogout && isLoggedIn()}>
                <button
                  type="button"
                  role="menuitem"
                  class="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-red-11 transition-colors hover:bg-red-3"
                  onClick={handleLogoutClick}
                >
                  <LogOut size={13} class="shrink-0" />
                  <span>{__vesloT("ui.literal.logout_11l94w", __vesloCurrentLocale())}</span>
                </button>
              </Show>
              <Show when={props.onSignIn && !isLoggedIn()}>
                <button
                  type="button"
                  role="menuitem"
                  class="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-gray-12 transition-colors hover:bg-gray-3"
                  onClick={handleSignInClick}
                >
                  <LogIn size={13} class="shrink-0" />
                  <span>{__vesloT("mcp.oauth", __vesloCurrentLocale())}</span>
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
