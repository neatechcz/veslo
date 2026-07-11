import { Show, createSignal, onMount } from "solid-js";
import { CheckCircle2, Loader2, ShieldAlert } from "lucide-solid";

import Button from "./button";
import VesloLogo from "./veslo-logo";
import { isTauriRuntime, isWindowsPlatform } from "../utils";
import { wslPrerequisitesRepair, wslSandboxRepair, type ExecResult } from "../lib/tauri";
import { currentLocale, t } from "../../i18n";

type RepairStatus = {
  tone: "info" | "success" | "warning" | "error";
  message: string;
  details?: string;
};

type WindowsSandboxRepairProps = {
  // When true the component renders as a full-screen gate. The default inline
  // card is non-blocking so local startup can fall back to a direct local engine.
  blocking?: boolean;
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

// The MSI enables WSL as LocalSystem; the per-user VesloSandbox distro is left
// to the app so it can be imported without admin. We auto-run that finish step
// once per app session so onboarding completes the sandbox on its own.
let autoPrepareStarted = false;
// Keep sandbox setup visible in the installed app; the installer itself does
// not run WSL preparation unless the explicit rollback flag is enabled.
const WINDOWS_WSL_SANDBOX_REPAIR_ENABLED = true;

export default function WindowsSandboxRepair(props: WindowsSandboxRepairProps) {
  const translate = (key: string) => t(key, currentLocale());
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal<RepairStatus | null>(null);
  const [dismissed, setDismissed] = createSignal(false);

  const ready = () => status()?.tone === "success";
  // Active work (checking / provisioning): no way to proceed, only a spinner.
  const working = () => busy() || status()?.tone === "info";
  // The blocking gate stays up until the sandbox is ready, unless the user
  // explicitly chooses to continue past a restart-required/failed state.
  const gateVisible = () => Boolean(props.blocking) && !ready() && !dismissed();

  // When `auto` is true we never trigger the elevated WSL install (that would
  // pop a UAC prompt); we only finish the per-user distro provisioning, which
  // needs no admin. The manual button passes `auto = false` so an explicit
  // click may still install the WSL features with elevation.
  const prepareSandbox = async (auto = false) => {
    if (!WINDOWS_WSL_SANDBOX_REPAIR_ENABLED) return;
    if (busy()) return;
    setBusy(true);
    setStatus({ tone: "info", message: translate("settings.windows_sandbox_checking") });

    try {
      const prereq = await wslPrerequisitesRepair({ checkOnly: true });
      if (!prereq.ok) {
        if (auto) {
          // WSL itself is not usable yet (needs install/restart, which requires
          // elevation). Surface it as an option instead of auto-prompting UAC.
          setStatus({
            tone: "warning",
            message: translate("settings.windows_sandbox_restart_required"),
            details: resultOutput(prereq),
          });
          return;
        }

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

  // Fully automatic finish: on first mount, detect the sandbox state and, when
  // WSL is already usable, import/provision VesloSandbox in the background
  // (windowless, no UAC). If the sandbox is already provisioned we just show it
  // as ready; if WSL still needs installing/restarting we leave that as a
  // manual, clearly labelled option (it requires elevation).
  const autoPrepare = async () => {
    if (!WINDOWS_WSL_SANDBOX_REPAIR_ENABLED) return;
    if (busy()) return;
    setBusy(true);
    setStatus({ tone: "info", message: translate("settings.windows_sandbox_checking") });
    let alreadyReady = false;
    try {
      const sandboxCheck = await wslSandboxRepair({ checkOnly: true });
      if (sandboxCheck.ok) {
        alreadyReady = true;
        setStatus({ tone: "success", message: translate("settings.windows_sandbox_ready") });
      }
    } catch {
      // Ignore and fall through to the guided auto flow below.
    } finally {
      setBusy(false);
    }

    if (alreadyReady) return;
    await prepareSandbox(true);
  };

  onMount(() => {
    if (!(isTauriRuntime() && isWindowsPlatform())) return;
    if (autoPrepareStarted) return;
    autoPrepareStarted = true;
    void autoPrepare();
  });

  const statusBlock = () => (
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
  );

  return (
    <Show when={isTauriRuntime() && isWindowsPlatform() && WINDOWS_WSL_SANDBOX_REPAIR_ENABLED}>
      <Show
        when={props.blocking}
        fallback={
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
                variant="outline"
                class="h-8 shrink-0 px-3 py-0 text-xs"
                onClick={() => void prepareSandbox(false)}
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
            {statusBlock()}
          </div>
        }
      >
        <Show when={gateVisible()}>
          <div class="fixed inset-0 z-[60] flex items-center justify-center bg-gray-1/95 backdrop-blur-sm p-6">
            <div class="w-full max-w-md space-y-6 rounded-3xl border border-gray-6 bg-gray-2/60 p-8 text-center shadow-2xl">
              <div class="flex justify-center">
                <VesloLogo size={40} />
              </div>
              <div class="space-y-2">
                <h2 class="font-product type-title-md tracking-tight text-gray-12">
                  {translate("settings.windows_sandbox_gate_title")}
                </h2>
                <p class="font-reading type-reading-md text-gray-11">
                  {translate("settings.windows_sandbox_hint")}
                </p>
              </div>

              <Show when={working()}>
                <div class="flex items-center justify-center gap-2 text-sm text-gray-11">
                  <Loader2 size={18} class="animate-spin" />
                  <span>{status()?.message ?? translate("settings.windows_sandbox_checking")}</span>
                </div>
              </Show>

              <div class="text-left">{statusBlock()}</div>

              <Show when={!working() && (status()?.tone === "warning" || status()?.tone === "error")}>
                <div class="flex flex-col gap-2">
                  <Button class="w-full" onClick={() => void prepareSandbox(false)} disabled={busy()}>
                    {translate("settings.windows_sandbox_prepare")}
                  </Button>
                  <Button variant="ghost" class="w-full" onClick={() => setDismissed(true)} disabled={busy()}>
                    {translate("settings.windows_sandbox_continue_anyway")}
                  </Button>
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </Show>
    </Show>
  );
}
