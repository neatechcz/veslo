import { Show, createSignal } from "solid-js";
import { CheckCircle2, Loader2, ShieldAlert } from "lucide-solid";

import Button from "./button";
import { isTauriRuntime, isWindowsPlatform } from "../utils";
import { wslPrerequisitesRepair, wslSandboxRepair, type ExecResult } from "../lib/tauri";
import { currentLocale, t } from "../../i18n";

type RepairStatus = {
  tone: "info" | "success" | "warning" | "error";
  message: string;
  details?: string;
};

const resultOutput = (result: ExecResult) => [result.stdout, result.stderr]
  .map((value) => value.trim())
  .filter(Boolean)
  .join("\n\n");

const isRestartRequired = (result: ExecResult) => {
  const output = resultOutput(result);
  return (
    result.status === 3010 ||
    result.status === 1641 ||
    /WSL (?:installation|update) requested a Windows restart|Windows restart is (?:required|likely required)/i.test(output)
  );
};

const statusClass = (tone: RepairStatus["tone"]) => {
  switch (tone) {
    case "success":
      return "border-green-7/30 bg-green-2/30 text-green-12";
    case "warning":
      return "border-amber-7/35 bg-amber-2/35 text-amber-12";
    case "error":
      return "border-red-7/30 bg-red-2/30 text-red-12";
    default:
      return "border-gray-6 bg-gray-1/40 text-gray-11";
  }
};

export default function WindowsSandboxRepair() {
  const translate = (key: string) => t(key, currentLocale());
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal<RepairStatus | null>(null);

  const prepareSandbox = async () => {
    if (busy()) return;
    setBusy(true);
    setStatus({ tone: "info", message: translate("settings.windows_sandbox_checking") });

    try {
      const prereq = await wslPrerequisitesRepair({ checkOnly: true });
      if (!prereq.ok) {
        setStatus({ tone: "info", message: translate("settings.windows_sandbox_installing_wsl") });
        const install = await wslPrerequisitesRepair({ checkOnly: false });
        const details = resultOutput(install);

        if (!install.ok && isRestartRequired(install)) {
          setStatus({
            tone: "warning",
            message: translate("settings.windows_sandbox_restart_required"),
            details,
          });
          return;
        }

        if (!install.ok) {
          setStatus({
            tone: "error",
            message: translate("settings.windows_sandbox_failed"),
            details: details || `exit ${install.status}`,
          });
          return;
        }
      }

      setStatus({ tone: "info", message: translate("settings.windows_sandbox_provisioning") });
      const sandbox = await wslSandboxRepair({ checkOnly: false });
      const details = resultOutput(sandbox);
      if (!sandbox.ok) {
        setStatus({
          tone: "error",
          message: translate("settings.windows_sandbox_failed"),
          details: details || `exit ${sandbox.status}`,
        });
        return;
      }

      setStatus({
        tone: "success",
        message: translate("settings.windows_sandbox_ready"),
        details,
      });
    } catch (error) {
      setStatus({
        tone: "error",
        message: translate("settings.windows_sandbox_failed"),
        details: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={isTauriRuntime() && isWindowsPlatform()}>
      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
        <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div class="min-w-0">
            <div class="flex items-center gap-2 text-sm font-medium text-gray-12">
              <ShieldAlert size={16} class="text-gray-11" />
              {translate("settings.windows_sandbox_title")}
            </div>
            <div class="mt-1 text-xs text-gray-10">{translate("settings.windows_sandbox_hint")}</div>
          </div>
          <Button
            variant="secondary"
            class="h-8 shrink-0 px-3 py-0 text-xs"
            onClick={prepareSandbox}
            disabled={busy()}
          >
            <Show when={busy()} fallback={<CheckCircle2 size={14} class="mr-1.5" />}>
              <Loader2 size={14} class="mr-1.5 animate-spin" />
            </Show>
            {busy()
              ? translate("settings.windows_sandbox_preparing")
              : translate("settings.windows_sandbox_prepare")}
          </Button>
        </div>

        <Show when={status()}>
          {(value) => (
            <div class={`rounded-xl border px-3 py-2 text-xs ${statusClass(value().tone)}`}>
              <div>{value().message}</div>
              <Show when={value().details}>
                {(details) => (
                  <pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
                    {details()}
                  </pre>
                )}
              </Show>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}
