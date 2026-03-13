import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { isTauriRuntime } from "../utils";
import { readPerfLogs } from "../lib/perf-log";

import Button from "../components/button";
import TextInput from "../components/text-input";

import { RefreshCcw } from "lucide-solid";

import { buildVesloWorkspaceBaseUrl, parseVesloWorkspaceIdFromUrl } from "../lib/veslo-server";
import type { VesloServerSettings, VesloServerStatus } from "../lib/veslo-server";
import type { VesloServerInfo } from "../lib/tauri";

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
  const [vesloUrl, setVesloUrl] = createSignal("");
  const [vesloToken, setVesloToken] = createSignal("");
  const [vesloTokenVisible, setVesloTokenVisible] = createSignal(false);
  const [vesloTestState, setVesloTestState] = createSignal<"idle" | "testing" | "success" | "error">("idle");
  const [vesloTestMessage, setVesloTestMessage] = createSignal<string | null>(null);
  const [clientTokenVisible, setClientTokenVisible] = createSignal(false);
  const [hostTokenVisible, setHostTokenVisible] = createSignal(false);
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
        return "Connected";
      case "limited":
        return "Limited";
      default:
        return "Not connected";
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
    if (!props.clientConnected) return "Connect to this worker to reload.";
    if (!props.canReloadWorkspace) {
      return "Reloading is only available for local workers or connected Veslo servers.";
    }
    return null;
  });

  const reloadButtonLabel = createMemo(() => (props.reloadBusy ? "Reloading..." : "Reload engine"));
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
    if (!hostInfo()?.running) return "Offline";
    return "Available";
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
        <div class="text-sm font-medium text-gray-12">Workspace config</div>
        <div class="text-xs text-gray-10">
          These settings affect the active workspace (sharing, reload, bots). Global app behavior lives in Settings.
        </div>
        <Show when={props.vesloServerWorkspaceId}>
          <div class="text-[11px] text-gray-7 font-mono truncate">
            Workspace: {props.vesloServerWorkspaceId}
          </div>
        </Show>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">Engine reload</div>
          <div class="text-xs text-gray-10">Restart the OpenCode server for this workspace.</div>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0 space-y-1">
            <div class="text-sm text-gray-12">Reload now</div>
            <div class="text-xs text-gray-7">Applies config updates and reconnects your session.</div>
            <Show when={props.anyActiveRuns}>
              <div class="text-[11px] text-amber-11">Reloading will stop active tasks.</div>
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
            <div class="text-sm text-gray-12">Auto reload (local)</div>
            <div class="text-xs text-gray-7">Reload automatically after agents/skills/commands/config change (only when idle).</div>
            <Show when={!props.workspaceAutoReloadAvailable}>
              <div class="text-[11px] text-gray-9">Available for local workspaces in the desktop app.</div>
            </Show>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => props.setWorkspaceAutoReloadEnabled(!props.workspaceAutoReloadEnabled)}
            disabled={props.busy || !props.workspaceAutoReloadAvailable}
          >
            {props.workspaceAutoReloadEnabled ? "On" : "Off"}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0 space-y-1">
            <div class="text-sm text-gray-12">Resume sessions after auto reload</div>
            <div class="text-xs text-gray-7">
              If a reload was queued while tasks were running, send a resume message afterward.
            </div>
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
            title={props.workspaceAutoReloadEnabled ? "" : "Enable auto reload first"}
          >
            {props.workspaceAutoReloadResumeEnabled ? "On" : "Off"}
          </Button>
        </div>
      </div>

      <Show when={props.developerMode}>
        <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
          <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <div class="text-sm font-medium text-gray-12">Diagnostics bundle</div>
              <div class="text-xs text-gray-10">Copy sanitized runtime state for debugging.</div>
            </div>
            <Button
              variant="secondary"
              class="text-xs h-8 py-0 px-3 shrink-0"
              onClick={() => void handleCopy(diagnosticsBundleJson(), "debug-bundle")}
              disabled={props.busy}
            >
              {copyingField() === "debug-bundle" ? "Copied" : "Copy"}
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
              <div class="text-sm font-medium text-gray-12">Veslo server sharing</div>
              <div class="text-xs text-gray-10">
                Share these details with a trusted device. Keep the server on the same network for the fastest setup.
              </div>
            </div>
            <div class={`text-xs px-2 py-1 rounded-full border ${hostStatusStyle()}`}>
              {hostStatusLabel()}
            </div>
          </div>

          <div class="grid gap-3">
            <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
              <div class="min-w-0">
                <div class="text-xs font-medium text-gray-11">Veslo Server URL</div>
                <div class="text-xs text-gray-7 font-mono truncate">{hostConnectUrl() || "Starting server…"}</div>
                <Show when={hostConnectUrl()}>
                  <div class="text-[11px] text-gray-8 mt-1">
                    {hostConnectUrlUsesMdns()
                      ? ".local names are easier to remember but may not resolve on all networks."
                      : "Use your local IP on the same Wi-Fi for the fastest connection."}
                  </div>
                </Show>
              </div>
              <Button
                variant="outline"
                class="text-xs h-8 py-0 px-3 shrink-0"
                onClick={() => handleCopy(hostConnectUrl(), "host-url")}
                disabled={!hostConnectUrl()}
              >
                {copyingField() === "host-url" ? "Copied" : "Copy"}
              </Button>
            </div>

            <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
              <div class="min-w-0">
                <div class="text-xs font-medium text-gray-11">Access token</div>
                <div class="text-xs text-gray-7 font-mono truncate">
                  {clientTokenVisible()
                    ? hostInfo()?.clientToken || "—"
                    : hostInfo()?.clientToken
                      ? "••••••••••••"
                      : "—"}
                </div>
                <div class="text-[11px] text-gray-8 mt-1">Use on phones or laptops connecting to this server.</div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => setClientTokenVisible((prev) => !prev)}
                  disabled={!hostInfo()?.clientToken}
                >
                  {clientTokenVisible() ? "Hide" : "Show"}
                </Button>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => handleCopy(hostInfo()?.clientToken ?? "", "client-token")}
                  disabled={!hostInfo()?.clientToken}
                >
                  {copyingField() === "client-token" ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>

            <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
              <div class="min-w-0">
                <div class="text-xs font-medium text-gray-11">Server token</div>
                <div class="text-xs text-gray-7 font-mono truncate">
                  {hostTokenVisible()
                    ? hostInfo()?.hostToken || "—"
                    : hostInfo()?.hostToken
                      ? "••••••••••••"
                      : "—"}
                </div>
                <div class="text-[11px] text-gray-8 mt-1">Keep private. Required for approval actions.</div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => setHostTokenVisible((prev) => !prev)}
                  disabled={!hostInfo()?.hostToken}
                >
                  {hostTokenVisible() ? "Hide" : "Show"}
                </Button>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => handleCopy(hostInfo()?.hostToken ?? "", "host-token")}
                  disabled={!hostInfo()?.hostToken}
                >
                  {copyingField() === "host-token" ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          </div>

          <div class="text-xs text-gray-9">
            For per-workspace sharing links, use <span class="font-medium">Share...</span> in the workspace menu.
          </div>
        </div>
      </Show>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div class="text-sm font-medium text-gray-12">Veslo server</div>
            <div class="text-xs text-gray-10">
              Connect to an Veslo server. Use the URL and access token from your server admin.
            </div>
          </div>
          <div class={`text-xs px-2 py-1 rounded-full border ${vesloStatusStyle()}`}>{vesloStatusLabel()}</div>
        </div>

        <div class="grid gap-3">
          <TextInput
            label="Veslo server URL"
            value={vesloUrl()}
            onInput={(event) => setVesloUrl(event.currentTarget.value)}
            placeholder="http://127.0.0.1:8787"
            hint="Use the URL shared by your Veslo server."
            disabled={props.busy}
          />

          <label class="block">
            <div class="mb-1 text-xs font-medium text-gray-11">Access token</div>
            <div class="flex items-center gap-2">
              <input
                type={vesloTokenVisible() ? "text" : "password"}
                value={vesloToken()}
                onInput={(event) => setVesloToken(event.currentTarget.value)}
                placeholder="Paste your token"
                disabled={props.busy}
                class="w-full rounded-xl bg-gray-2/60 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-10 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-gray-6/20"
              />
              <Button
                variant="outline"
                class="text-xs h-9 px-3 shrink-0"
                onClick={() => setVesloTokenVisible((prev) => !prev)}
                disabled={props.busy}
              >
                {vesloTokenVisible() ? "Hide" : "Show"}
              </Button>
            </div>
            <div class="mt-1 text-xs text-gray-10">Optional. Paste the access token to authenticate.</div>
          </label>
        </div>

        <div class="space-y-1">
          <div class="text-[11px] text-gray-7 font-mono truncate">Resolved worker URL: {resolvedWorkspaceUrl() || "Not set"}</div>
          <div class="text-[11px] text-gray-8 font-mono truncate">Worker ID: {resolvedWorkspaceId() || "Unavailable"}</div>
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
                  ok ? "Connection successful." : "Connection failed. Check the host URL and token.",
                );
              } catch (error) {
                const message = error instanceof Error ? error.message : "Connection failed.";
                setVesloTestState("error");
                setVesloTestMessage(message);
              }
            }}
            disabled={props.busy || vesloTestState() === "testing"}
          >
            {vesloTestState() === "testing" ? "Testing..." : "Test connection"}
          </Button>
          <Button
            variant="outline"
            onClick={() => props.updateVesloServerSettings(buildVesloSettings())}
            disabled={props.busy || !hasVesloChanges()}
          >
            Save
          </Button>
          <Button variant="ghost" onClick={props.resetVesloServerSettings} disabled={props.busy}>
            Reset
          </Button>
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
            {vesloTestState() === "testing" ? "Testing connection..." : vesloTestMessage() ?? "Connection status updated."}
          </div>
        </Show>

        <Show when={vesloStatusLabel() !== "Connected"}>
          <div class="text-xs text-gray-9">Veslo server connection needed to sync skills, plugins, and commands.</div>
        </Show>
      </div>

      <Show when={!isTauriRuntime()}>
        <div class="text-xs text-gray-9">
          Some config features (local server sharing + bridge runtime controls) require the desktop app.
        </div>
      </Show>
    </section>
  );
}
