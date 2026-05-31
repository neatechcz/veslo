import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { isTauriRuntime } from "../utils";
import { readPerfLogs } from "../lib/perf-log";

import Button from "../components/button";
import TextInput from "../components/text-input";
import SecretField from "../components/secret-field";

import { RefreshCcw } from "lucide-solid";

import { buildVesloWorkspaceBaseUrl, parseVesloWorkspaceIdFromUrl } from "../lib/veslo-server";
import type { VesloServerSettings, VesloServerStatus } from "../lib/veslo-server";
import type { VesloServerInfo } from "../lib/tauri";
import { currentLocale, t } from "../../i18n";
import { currentLocale as __vesloCurrentLocale, t as __vesloT } from "../../i18n";

export type ConfigViewProps = {
  busy: boolean;
  clientConnected: boolean;
  anyActiveRuns: boolean;

  vesloServerStatus: VesloServerStatus;
  vesloServerUrl: string;
  vesloServerSettings: VesloServerSettings;
  vesloServerHostInfo: VesloServerInfo | null;
  vesloServerWorkspaceId: string | null;

  updateVesloServerSettings: (next: VesloServerSettings) => void;
  resetVesloServerSettings: () => void;
  testVesloServerConnection: (next: VesloServerSettings) => Promise<boolean>;

  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;
  reloadError: string | null;

  workspaceAutoReloadAvailable: boolean;
  workspaceAutoReloadEnabled: boolean;
  setWorkspaceAutoReloadEnabled: (value: boolean) => void | Promise<void>;
  workspaceAutoReloadResumeEnabled: boolean;
  setWorkspaceAutoReloadResumeEnabled: (value: boolean) => void | Promise<void>;

  developerMode: boolean;
};

export default function ConfigView(props: ConfigViewProps) {
  const tr = (key: string) => t(key, currentLocale());
  const [vesloUrl, setVesloUrl] = createSignal("");
  const [vesloToken, setVesloToken] = createSignal("");
  const [vesloTokenVisible, setVesloTokenVisible] = createSignal(false);
  const [vesloTestState, setVesloTestState] = createSignal<"idle" | "testing" | "success" | "error">("idle");
  const [vesloTestMessage, setVesloTestMessage] = createSignal<string | null>(null);
  const [copyingField, setCopyingField] = createSignal<string | null>(null);
  let copyTimeout: number | undefined;

  createEffect(() => {
    setVesloUrl(props.vesloServerSettings.urlOverride ?? "");
    setVesloToken(props.vesloServerSettings.token ?? "");
  });

  createEffect(() => {
    vesloUrl();
    vesloToken();
    setVesloTestState("idle");
    setVesloTestMessage(null);
  });

  const vesloStatusLabel = createMemo(() => {
    switch (props.vesloServerStatus) {
      case "connected":
        return tr("status.connected");
      case "limited":
        return tr("status.limited");
      default:
        return tr("dashboard.not_connected");
    }
  });

  const vesloStatusStyle = createMemo(() => {
    switch (props.vesloServerStatus) {
      case "connected":
        return "bg-green-7/10 text-green-11 border-green-7/20";
      case "limited":
        return "bg-amber-7/10 text-amber-11 border-amber-7/20";
      default:
        return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    }
  });

  const reloadAvailabilityReason = createMemo(() => {
    if (!props.clientConnected) return tr("reload.toast_blocked_connect");
    if (!props.canReloadWorkspace) {
      return tr("reload.toast_blocked_workspace");
    }
    return null;
  });

  const reloadButtonLabel = createMemo(() =>
    props.reloadBusy ? tr("reload.toast_reloading") : tr("reload.engine_button")
  );
  const reloadButtonTone = createMemo(() => (props.anyActiveRuns ? "danger" : "secondary"));
  const reloadButtonDisabled = createMemo(() => props.reloadBusy || Boolean(reloadAvailabilityReason()));

  const buildVesloSettings = () => ({
    ...props.vesloServerSettings,
    urlOverride: vesloUrl().trim() || undefined,
    token: vesloToken().trim() || undefined,
  });

  const hasVesloChanges = createMemo(() => {
    const currentUrl = props.vesloServerSettings.urlOverride ?? "";
    const currentToken = props.vesloServerSettings.token ?? "";
    return vesloUrl().trim() !== currentUrl || vesloToken().trim() !== currentToken;
  });

  const resolvedWorkspaceId = createMemo(() => {
    const explicitId = props.vesloServerWorkspaceId?.trim() ?? "";
    if (explicitId) return explicitId;
    return parseVesloWorkspaceIdFromUrl(vesloUrl()) ?? "";
  });

  const resolvedWorkspaceUrl = createMemo(() => {
    const baseUrl = vesloUrl().trim();
    if (!baseUrl) return "";
    return buildVesloWorkspaceBaseUrl(baseUrl, resolvedWorkspaceId()) ?? baseUrl;
  });

  const hostInfo = createMemo(() => props.vesloServerHostInfo);
  const hostStatusLabel = createMemo(() => {
    if (!hostInfo()?.running) return tr("status.offline");
    return tr("status.available");
  });
  const hostStatusStyle = createMemo(() => {
    if (!hostInfo()?.running) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    return "bg-green-7/10 text-green-11 border-green-7/20";
  });
  const hostConnectUrl = createMemo(() => {
    const info = hostInfo();
    return info?.connectUrl ?? info?.mdnsUrl ?? info?.lanUrl ?? info?.baseUrl ?? "";
  });
  const hostConnectUrlUsesMdns = createMemo(() => hostConnectUrl().includes(".local"));

  const diagnosticsBundle = createMemo(() => {
    const urlOverride = props.vesloServerSettings.urlOverride?.trim() ?? "";
    const token = props.vesloServerSettings.token?.trim() ?? "";
    const host = hostInfo();
    const perfLogs = props.developerMode ? readPerfLogs(80) : [];
    return {
      capturedAt: new Date().toISOString(),
      runtime: {
        tauri: isTauriRuntime(),
        developerMode: props.developerMode,
      },
      workspace: {
        vesloServerWorkspaceId: props.vesloServerWorkspaceId ?? null,
        clientConnected: props.clientConnected,
        anyActiveRuns: props.anyActiveRuns,
      },
      vesloServer: {
        status: props.vesloServerStatus,
        url: props.vesloServerUrl,
        settings: {
          urlOverride: urlOverride || null,
          tokenPresent: Boolean(token),
        },
        host: host
          ? {
              running: Boolean(host.running),
              baseUrl: host.baseUrl ?? null,
              connectUrl: host.connectUrl ?? null,
              mdnsUrl: host.mdnsUrl ?? null,
              lanUrl: host.lanUrl ?? null,
            }
          : null,
      },
      reload: {
        canReloadWorkspace: props.canReloadWorkspace,
        autoReloadAvailable: props.workspaceAutoReloadAvailable,
        autoReloadEnabled: props.workspaceAutoReloadEnabled,
        autoReloadResumeEnabled: props.workspaceAutoReloadResumeEnabled,
      },
      sharing: {
        hostConnectUrl: hostConnectUrl() || null,
        hostConnectUrlUsesMdns: hostConnectUrlUsesMdns(),
      },
      performance: {
        retainedEntries: perfLogs.length,
        recent: perfLogs,
      },
    };
  });

  const diagnosticsBundleJson = createMemo(() => JSON.stringify(diagnosticsBundle(), null, 2));

  const handleCopy = async (value: string, field: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyingField(field);
      if (copyTimeout !== undefined) {
        window.clearTimeout(copyTimeout);
      }
      copyTimeout = window.setTimeout(() => {
        setCopyingField(null);
        copyTimeout = undefined;
      }, 2000);
    } catch {
      // ignore
    }
  };

  onCleanup(() => {
    if (copyTimeout !== undefined) {
      window.clearTimeout(copyTimeout);
    }
  });

  return (
    <section class="space-y-6">
      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-2">
        <div class="text-sm font-medium text-gray-12">{__vesloT("ui.literal.workspace_config_16f12z", __vesloCurrentLocale())}</div>
        <div class="text-xs text-gray-10">
          {__vesloT("ui.literal.these_settings_affect_the_active_workspace_s_1qllhx", __vesloCurrentLocale())}</div>
        <Show when={props.vesloServerWorkspaceId}>
          <div class="text-[11px] text-gray-7 font-mono truncate">
            {__vesloT("ui.literal.workspace_fmeryc", __vesloCurrentLocale())}{" "}{props.vesloServerWorkspaceId}
          </div>
        </Show>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">{__vesloT("ui.literal.engine_reload_1by6ov", __vesloCurrentLocale())}</div>
          <div class="text-xs text-gray-10">{__vesloT("ui.literal.restart_the_opencode_server_for_this_workspa_1f2lzv", __vesloCurrentLocale())}</div>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0 space-y-1">
            <div class="text-sm text-gray-12">{__vesloT("ui.literal.reload_now_fzpt3w", __vesloCurrentLocale())}</div>
            <div class="text-xs text-gray-7">{__vesloT("ui.literal.applies_config_updates_and_reconnects_your_s_mv40j1", __vesloCurrentLocale())}</div>
            <Show when={props.anyActiveRuns}>
              <div class="text-[11px] text-amber-11">{__vesloT("ui.literal.reloading_will_stop_active_tasks_4xmwru", __vesloCurrentLocale())}</div>
            </Show>
            <Show when={props.reloadError}>
              <div class="text-[11px] text-red-11">{props.reloadError}</div>
            </Show>
            <Show when={reloadAvailabilityReason()}>
              <div class="text-[11px] text-gray-9">{reloadAvailabilityReason()}</div>
            </Show>
          </div>
          <Button
            variant={reloadButtonTone()}
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.reloadWorkspaceEngine}
            disabled={reloadButtonDisabled()}
          >
            <RefreshCcw size={14} class={props.reloadBusy ? "animate-spin" : ""} />
            {reloadButtonLabel()}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0 space-y-1">
            <div class="text-sm text-gray-12">{__vesloT("ui.literal.auto_reload_local_hr3rzh", __vesloCurrentLocale())}</div>
            <div class="text-xs text-gray-7">{__vesloT("ui.literal.reload_automatically_after_agents_skills_com_16cu26", __vesloCurrentLocale())}</div>
            <Show when={!props.workspaceAutoReloadAvailable}>
              <div class="text-[11px] text-gray-9">{__vesloT("ui.literal.available_for_local_workspaces_in_the_deskto_zafle9", __vesloCurrentLocale())}</div>
            </Show>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => props.setWorkspaceAutoReloadEnabled(!props.workspaceAutoReloadEnabled)}
            disabled={props.busy || !props.workspaceAutoReloadAvailable}
          >
            {props.workspaceAutoReloadEnabled ? tr("common.on") : tr("common.off")}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0 space-y-1">
            <div class="text-sm text-gray-12">{__vesloT("ui.literal.resume_sessions_after_auto_reload_18y2dh", __vesloCurrentLocale())}</div>
            <div class="text-xs text-gray-7">
              {__vesloT("ui.literal.if_a_reload_was_queued_while_tasks_were_runn_1sl29n", __vesloCurrentLocale())}</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => props.setWorkspaceAutoReloadResumeEnabled(!props.workspaceAutoReloadResumeEnabled)}
            disabled={
              props.busy ||
              !props.workspaceAutoReloadAvailable ||
              !props.workspaceAutoReloadEnabled
            }
            title={props.workspaceAutoReloadEnabled ? "" : tr("config.enable_auto_reload_first")}
          >
            {props.workspaceAutoReloadResumeEnabled ? tr("common.on") : tr("common.off")}
          </Button>
        </div>
      </div>

      <Show when={props.developerMode}>
        <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
          <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <div class="text-sm font-medium text-gray-12">{__vesloT("ui.literal.diagnostics_bundle_qo9n91", __vesloCurrentLocale())}</div>
              <div class="text-xs text-gray-10">{__vesloT("ui.literal.copy_sanitized_runtime_state_for_debugging_m34nf7", __vesloCurrentLocale())}</div>
            </div>
            <Button
              variant="secondary"
              class="text-xs h-8 py-0 px-3 shrink-0"
              onClick={() => void handleCopy(diagnosticsBundleJson(), "debug-bundle")}
              disabled={props.busy}
            >
              {copyingField() === "debug-bundle" ? tr("common.copied") : tr("common.copy")}
            </Button>
          </div>
          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto bg-gray-1/20 border border-gray-6 rounded-xl p-3">
            {diagnosticsBundleJson()}
          </pre>
        </div>
      </Show>

      <Show when={hostInfo()}>
        <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
          <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <div class="text-sm font-medium text-gray-12">{__vesloT("ui.literal.veslo_server_sharing_n9m51f", __vesloCurrentLocale())}</div>
              <div class="text-xs text-gray-10">
                {__vesloT("ui.literal.share_these_details_with_a_trusted_device_ke_x0cmkv", __vesloCurrentLocale())}</div>
            </div>
            <div class={`text-xs px-2 py-1 rounded-full border ${hostStatusStyle()}`}>
              {hostStatusLabel()}
            </div>
          </div>

          <div class="grid gap-3">
            <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
              <div class="min-w-0">
                <div class="text-xs font-medium text-gray-11">{__vesloT("ui.literal.veslo_server_url_147n53", __vesloCurrentLocale())}</div>
                <div class="text-xs text-gray-7 font-mono truncate">{hostConnectUrl() || tr("config.starting_server")}</div>
                <Show when={hostConnectUrl()}>
                  <div class="text-[11px] text-gray-8 mt-1">
                    {hostConnectUrlUsesMdns()
                      ? tr("config.local_name_hint")
                      : tr("config.local_ip_hint")}
                  </div>
                </Show>
              </div>
              <Button
                variant="outline"
                class="text-xs h-8 py-0 px-3 shrink-0"
                onClick={() => handleCopy(hostConnectUrl(), "host-url")}
                disabled={!hostConnectUrl()}
              >
                {copyingField() === "host-url" ? tr("common.copied") : tr("common.copy")}
              </Button>
            </div>

            <SecretField
              label={__vesloT("dashboard.veslo_host_token_label", __vesloCurrentLocale())}
              value={hostInfo()?.clientToken}
              hint={__vesloT("ui.literal.use_on_phones_or_laptops_connecting_to_this__1n5r7h", __vesloCurrentLocale())}
              onCopy={(v) => handleCopy(v, "client-token")}
              copied={copyingField() === "client-token"}
            />

            <SecretField
              label={__vesloT("ui.literal.server_token_1bpaez", __vesloCurrentLocale())}
              value={hostInfo()?.hostToken}
              hint={__vesloT("ui.literal.keep_private_required_for_approval_actions_da87ml", __vesloCurrentLocale())}
              onCopy={(v) => handleCopy(v, "host-token")}
              copied={copyingField() === "host-token"}
            />
          </div>

          <div class="text-xs text-gray-9">
            {__vesloT("ui.literal.for_per_workspace_sharing_links_use_10nbrc", __vesloCurrentLocale())}{" "}<span class="font-medium">{__vesloT("sidebar.share", __vesloCurrentLocale())}</span> {__vesloT("ui.literal.in_the_workspace_menu_1lt0ht", __vesloCurrentLocale())}</div>
        </div>
      </Show>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div class="text-sm font-medium text-gray-12">{__vesloT("dashboard.remote_mode_veslo_alpha", __vesloCurrentLocale())}</div>
            <div class="text-xs text-gray-10">
              {__vesloT("ui.literal.connect_to_an_veslo_server_use_the_url_and_a_lp0wad", __vesloCurrentLocale())}</div>
          </div>
          <div class={`text-xs px-2 py-1 rounded-full border ${vesloStatusStyle()}`}>{vesloStatusLabel()}</div>
        </div>

        <div class="grid gap-3">
          <TextInput
            label={__vesloT("dashboard.remote_base_url_label", __vesloCurrentLocale())}
            value={vesloUrl()}
            onInput={(event) => setVesloUrl(event.currentTarget.value)}
            placeholder="http://127.0.0.1:8787"
            hint={__vesloT("dashboard.veslo_host_hint", __vesloCurrentLocale())}
            disabled={props.busy}
          />

          <label class="block">
            <div class="mb-1 text-xs font-medium text-gray-11">{__vesloT("dashboard.veslo_host_token_label", __vesloCurrentLocale())}</div>
            <div class="flex items-center gap-2">
              <input
                type={vesloTokenVisible() ? "text" : "password"}
                value={vesloToken()}
                onInput={(event) => setVesloToken(event.currentTarget.value)}
                placeholder={__vesloT("dashboard.veslo_host_token_placeholder", __vesloCurrentLocale())}
                disabled={props.busy}
                class="w-full rounded-xl bg-gray-2/60 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-10 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-gray-6/20"
              />
              <Button
                variant="outline"
                class="text-xs h-9 px-3 shrink-0"
                onClick={() => setVesloTokenVisible((prev) => !prev)}
                disabled={props.busy}
              >
                {vesloTokenVisible() ? tr("common.hide") : tr("common.show")}
              </Button>
            </div>
            <div class="mt-1 text-xs text-gray-10">{__vesloT("ui.literal.optional_paste_the_access_token_to_authentic_1iymne", __vesloCurrentLocale())}</div>
          </label>
        </div>

        <div class="space-y-1">
          <div class="text-[11px] text-gray-7 font-mono truncate">{__vesloT("ui.literal.resolved_worker_url_efzgj2", __vesloCurrentLocale())}{" "}{resolvedWorkspaceUrl() || tr("skills.detail_not_set")}</div>
          <div class="text-[11px] text-gray-8 font-mono truncate">{__vesloT("ui.literal.worker_id_aeufxa", __vesloCurrentLocale())}{" "}{resolvedWorkspaceId() || tr("status.unavailable")}</div>
        </div>

        <div class="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={async () => {
              if (vesloTestState() === "testing") return;
              const next = buildVesloSettings();
              props.updateVesloServerSettings(next);
              setVesloTestState("testing");
              setVesloTestMessage(null);
              try {
                const ok = await props.testVesloServerConnection(next);
                setVesloTestState(ok ? "success" : "error");
                setVesloTestMessage(
                  ok ? tr("config.connection_successful") : tr("config.connection_failed_check_host"),
                );
              } catch (error) {
                const message = error instanceof Error ? error.message : tr("config.connection_failed");
                setVesloTestState("error");
                setVesloTestMessage(message);
              }
            }}
            disabled={props.busy || vesloTestState() === "testing"}
          >
            {vesloTestState() === "testing" ? tr("config.testing") : tr("mcp.verify_connection")}
          </Button>
          <Button
            variant="outline"
            onClick={() => props.updateVesloServerSettings(buildVesloSettings())}
            disabled={props.busy || !hasVesloChanges()}
          >
            {__vesloT("common.save", __vesloCurrentLocale())}</Button>
          <Button variant="ghost" onClick={props.resetVesloServerSettings} disabled={props.busy}>
            {__vesloT("settings.reset", __vesloCurrentLocale())}</Button>
        </div>

        <Show when={vesloTestState() !== "idle"}>
          <div
            class={`text-xs ${
              vesloTestState() === "success"
                ? "text-green-11"
                : vesloTestState() === "error"
                  ? "text-red-11"
                  : "text-gray-9"
            }`}
            role="status"
            aria-live="polite"
          >
            {vesloTestState() === "testing" ? tr("config.testing_connection") : vesloTestMessage() ?? tr("config.connection_status_updated")}
          </div>
        </Show>

        <Show when={props.vesloServerStatus !== "connected"}>
          <div class="text-xs text-gray-9">{__vesloT("ui.literal.veslo_server_connection_needed_to_sync_skill_4yr3rt", __vesloCurrentLocale())}</div>
        </Show>
      </div>

      <Show when={!isTauriRuntime()}>
        <div class="text-xs text-gray-9">
          {__vesloT("ui.literal.some_config_features_local_server_sharing_br_9dn3nc", __vesloCurrentLocale())}</div>
      </Show>
    </section>
  );
}
