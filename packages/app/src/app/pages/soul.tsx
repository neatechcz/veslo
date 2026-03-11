import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Activity, CheckCircle2, Circle, HeartPulse, RefreshCw, Sparkles } from "lucide-solid";

import type { VesloSoulHeartbeatEntry, VesloSoulStatus } from "../lib/veslo-server";
import soulSetupTemplate from "../data/commands/give-me-a-soul.md?raw";
import { formatRelativeTime, parseTemplateFrontmatter } from "../utils";
import { currentLocale, t } from "../../i18n";

type SoulViewProps = {
  workspaceName: string;
  workspaceRoot: string;
  status: VesloSoulStatus | null;
  heartbeats: VesloSoulHeartbeatEntry[];
  loading: boolean;
  loadingHeartbeats: boolean;
  error: string | null;
  newTaskDisabled: boolean;
  refresh: (options?: { force?: boolean }) => void;
  runSoulPrompt: (prompt: string) => void;
};

const cadenceOptions = [
  { labelKey: "soul.cadence_6h", cron: "0 */6 * * *" },
  { labelKey: "soul.cadence_12h", cron: "0 */12 * * *" },
  { labelKey: "soul.cadence_daily", cron: "0 9 * * *" },
];

const SOUL_SETUP_TEMPLATE = (() => {
  const parsed = parseTemplateFrontmatter(soulSetupTemplate);
  const name = parsed?.data?.name?.trim() || "give-me-a-soul";
  const body = (parsed?.body ?? soulSetupTemplate).trim();
  return { name, body };
})();

const relativeTime = (value?: string | null) => {
  if (!value) return t("soul.relative_never", currentLocale());
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return formatRelativeTime(parsed);
};

export default function SoulView(props: SoulViewProps) {
  const tr = (key: string) => t(key, currentLocale());
  const formatTr = (key: string, values: Record<string, string>) => {
    let value = tr(key);
    for (const [token, replacement] of Object.entries(values)) {
      value = value.replaceAll(`{${token}}`, replacement);
    }
    return value;
  };
  const [focusInput, setFocusInput] = createSignal("");
  const [boundariesInput, setBoundariesInput] = createSignal("");
  const [cadence, setCadence] = createSignal(cadenceOptions[1]?.cron ?? "0 */12 * * *");
  const [heartbeatRunState, setHeartbeatRunState] = createSignal<"idle" | "running" | "success" | "warning">("idle");
  const [heartbeatRunMessage, setHeartbeatRunMessage] = createSignal<string | null>(null);
  const [heartbeatBaselineTs, setHeartbeatBaselineTs] = createSignal<string | null>(null);
  const [heartbeatRunStartedAt, setHeartbeatRunStartedAt] = createSignal<number | null>(null);
  let heartbeatPollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  const statusMeta = createMemo(() => {
    const state = props.status?.state ?? "off";
    switch (state) {
      case "healthy":
        return {
          label: tr("soul.status_on"),
          tone: "border-emerald-7/50 bg-emerald-3/30 text-emerald-11",
          dot: "bg-emerald-9",
        };
      case "stale":
        return {
          label: tr("soul.status_stale"),
          tone: "border-amber-7/50 bg-amber-3/30 text-amber-11",
          dot: "bg-amber-9",
        };
      case "error":
        return {
          label: tr("soul.status_error"),
          tone: "border-red-7/50 bg-red-3/30 text-red-11",
          dot: "bg-red-9",
        };
      default:
        return {
          label: tr("soul.status_off"),
          tone: "border-gray-6 bg-gray-2 text-gray-10",
          dot: "bg-gray-7",
        };
    }
  });

  const runPrompt = (prompt: string) => {
    if (props.newTaskDisabled) return;
    props.runSoulPrompt(prompt);
  };

  const enableSoulPrompt = createMemo(() => {
    const body =
      currentLocale() === "cs"
        ? tr("session.quickstart_soul_prompt").trim()
        : SOUL_SETUP_TEMPLATE.body.trim();
    if (body) return body;
    return `/${SOUL_SETUP_TEMPLATE.name}`;
  });

  const latestHeartbeat = createMemo(() => props.heartbeats[0] ?? null);

  const setupAuditItems = createMemo(() => {
    const status = props.status;
    if (!status) {
      return [
        { id: "memory", label: tr("soul.audit_memory"), passed: false, detail: tr("soul.audit_waiting") },
        { id: "instructions", label: tr("soul.audit_instructions"), passed: false, detail: tr("soul.audit_waiting") },
        { id: "command", label: tr("soul.audit_command"), passed: false, detail: tr("soul.audit_waiting") },
        { id: "job", label: tr("soul.audit_schedule"), passed: false, detail: tr("soul.audit_waiting") },
        { id: "log", label: tr("soul.audit_log"), passed: false, detail: tr("soul.audit_waiting") },
        { id: "proof", label: tr("soul.audit_proof"), passed: false, detail: tr("soul.audit_run_once") },
      ];
    }

    return [
      {
        id: "memory",
        label: tr("soul.audit_memory"),
        passed: status.memoryEnabled,
        detail: status.memoryEnabled ? status.memoryPath : tr("soul.audit_memory_missing"),
      },
      {
        id: "instructions",
        label: tr("soul.audit_instructions"),
        passed: status.instructionsEnabled,
        detail: status.instructionsEnabled
          ? tr("soul.audit_instructions_ready")
          : tr("soul.audit_instructions_missing"),
      },
      {
        id: "command",
        label: tr("soul.audit_command"),
        passed: status.heartbeatCommandExists,
        detail: status.heartbeatCommandExists ? tr("soul.audit_command_ready") : tr("soul.audit_command_missing"),
      },
      {
        id: "job",
        label: tr("soul.audit_schedule"),
        passed: Boolean(status.heartbeatJob),
        detail: status.heartbeatJob?.schedule || tr("soul.audit_schedule_missing"),
      },
      {
        id: "log",
        label: tr("soul.audit_log"),
        passed: status.heartbeatLogExists,
        detail: status.heartbeatLogExists ? status.heartbeatPath : tr("soul.audit_log_missing"),
      },
      {
        id: "proof",
        label: tr("soul.audit_proof"),
        passed: Boolean(status.lastHeartbeatAt),
        detail: status.lastHeartbeatAt
          ? `${tr("soul.latest_check_in")} ${relativeTime(status.lastHeartbeatAt)}`
          : tr("soul.audit_no_checkins"),
      },
    ];
  });

  const steeringAudit = createMemo(() => {
    const latest = latestHeartbeat();
    const looseEndCount = latest?.looseEnds.length ?? 0;
    return [
      {
        id: "heartbeat",
        label: tr("soul.steering_heartbeat"),
        passed: props.heartbeats.length > 0,
        detail: latest?.ts ? `${tr("soul.latest_check_in")} ${relativeTime(latest.ts)}` : tr("soul.run_heartbeat_now"),
      },
      {
        id: "loose-ends",
        label: tr("soul.steering_loose_ends"),
        passed: looseEndCount > 0,
        detail: looseEndCount > 0 ? tr("soul.steering_loose_ends_ready").replace("{count}", String(looseEndCount)) : tr("soul.audit_no_checkins"),
      },
      {
        id: "next-action",
        label: tr("soul.steering_next_action"),
        passed: Boolean(latest?.nextAction),
        detail: latest?.nextAction || tr("soul.steering_generate_next_action"),
      },
    ];
  });

  const clearHeartbeatTimers = () => {
    if (heartbeatPollTimer) {
      clearInterval(heartbeatPollTimer);
      heartbeatPollTimer = null;
    }
    if (heartbeatTimeoutTimer) {
      clearTimeout(heartbeatTimeoutTimer);
      heartbeatTimeoutTimer = null;
    }
  };

  const runHeartbeatNow = () => {
    if (props.newTaskDisabled || heartbeatRunState() === "running") return;
    const baselineTs = props.heartbeats[0]?.ts ?? props.status?.lastHeartbeatAt ?? null;
    setHeartbeatBaselineTs(baselineTs);
    setHeartbeatRunStartedAt(Date.now());
    setHeartbeatRunState("running");
    setHeartbeatRunMessage(tr("soul.heartbeat_started"));
    clearHeartbeatTimers();

    runPrompt(
      currentLocale() === "cs"
        ? "V tomto pracovním prostoru spusť přes nástroj scheduler job s názvem soul-heartbeat. Pokud job chybí, spusť jednou /soul-heartbeat. Pak shrň poslední stav heartbeatů, uveď volné konce a jeden konkrétní další krok."
        : "Run scheduler tool run_job for the job named soul-heartbeat in this workspace. If the job is missing, run /soul-heartbeat once instead. Then summarize the latest heartbeat status with loose ends and one concrete next action.",
    );

    void props.refresh({ force: true });

    heartbeatPollTimer = setInterval(() => {
      void props.refresh({ force: true });
    }, 3000);

    heartbeatTimeoutTimer = setTimeout(() => {
      if (heartbeatRunState() !== "running") return;
      clearHeartbeatTimers();
      setHeartbeatRunState("warning");
      setHeartbeatRunMessage(tr("soul.heartbeat_waiting"));
    }, 45000);
  };

  const heartbeatStatusCardTone = createMemo(() => {
    const state = heartbeatRunState();
    if (state === "success") return "border-emerald-7/50 bg-emerald-3/30 text-emerald-11";
    if (state === "warning") return "border-amber-7/50 bg-amber-3/30 text-amber-11";
    if (state === "running") return "border-blue-7/50 bg-blue-3/30 text-blue-11";
    return "border-dls-border bg-dls-hover/30 text-dls-secondary";
  });

  const heartbeatStatusTitle = createMemo(() => {
    const state = heartbeatRunState();
    if (state === "success") return tr("soul.heartbeat_completed");
    if (state === "warning") return tr("soul.heartbeat_still_running");
    if (state === "running") return tr("soul.heartbeat_in_progress");
    return tr("soul.run_heartbeat_now");
  });

  createEffect(() => {
    if (heartbeatRunState() !== "running") return;
    const latestTs = props.heartbeats[0]?.ts ?? props.status?.lastHeartbeatAt ?? null;
    if (!latestTs) return;
    const baselineTs = heartbeatBaselineTs();
    const startedAt = heartbeatRunStartedAt();
    const parsedLatest = Date.parse(latestTs);
    if (baselineTs && latestTs === baselineTs) return;
    if (Number.isFinite(parsedLatest) && startedAt && parsedLatest < startedAt - 1000) return;

    clearHeartbeatTimers();
    setHeartbeatRunState("success");
    setHeartbeatRunMessage(`${tr("soul.latest_check_in")}: ${relativeTime(latestTs)}.`);
  });

  onCleanup(() => {
    clearHeartbeatTimers();
  });

  const cadenceLabel = createMemo(() => {
    const match = cadenceOptions.find((option) => option.cron === cadence());
    return match ? tr(match.labelKey) : cadence();
  });

  return (
    <section class="space-y-8">
      <div class="rounded-2xl border border-dls-border bg-dls-surface p-6 md:p-7">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="space-y-2">
            <div class="flex items-center gap-2">
              <HeartPulse size={18} class="text-dls-secondary" />
              <h2 class="text-xl font-semibold text-dls-text">{tr("soul.title")}</h2>
              <span class={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusMeta().tone}`}>
                {statusMeta().label}
              </span>
            </div>
            <p class="text-sm text-dls-secondary max-w-2xl">
              {tr("soul.subtitle")}
            </p>
          </div>
          <button
            type="button"
            class={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              props.loading
                ? "border-gray-6 text-gray-8"
                : "border-dls-border text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
            }`}
            disabled={props.loading}
            onClick={() => props.refresh({ force: true })}
          >
            <RefreshCw size={14} class={props.loading ? "animate-spin" : ""} />
            {props.loading ? tr("soul.refreshing") : tr("soul.refresh")}
          </button>
        </div>

        <Show when={props.error}>
          <div class="mt-4 rounded-xl border border-red-7/40 bg-red-3/40 px-4 py-3 text-sm text-red-11">
            {props.error}
          </div>
        </Show>

        <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div class="rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-3">
            <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{tr("soul.worker")}</div>
            <div class="mt-1 text-sm text-dls-text truncate">{props.workspaceName}</div>
          </div>
          <div class="rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-3">
            <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{tr("soul.last_heartbeat")}</div>
            <div class="mt-1 text-sm text-dls-text">{relativeTime(props.status?.lastHeartbeatAt)}</div>
          </div>
          <div class="rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-3">
            <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{tr("soul.heartbeat_count")}</div>
            <div class="mt-1 text-sm text-dls-text">{props.status?.heartbeatCount ?? 0}</div>
          </div>
          <div class="rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-3">
            <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{tr("soul.schedule")}</div>
            <div class="mt-1 text-sm text-dls-text truncate">
              {props.status?.heartbeatJob?.schedule || tr("soul.no_schedule")}
            </div>
          </div>
        </div>

        <div class="mt-4 rounded-xl border border-dls-border bg-dls-hover/30 px-4 py-3 text-sm text-dls-secondary">
          {props.status?.summary || tr("soul.not_loaded")}
        </div>

        <Show when={!props.status?.enabled}>
          <div class="mt-4 rounded-xl border border-blue-7/40 bg-blue-3/20 p-3 flex flex-wrap items-center justify-between gap-3">
            <div class="text-xs text-blue-11 max-w-lg">
              {tr("soul.off_banner")}
            </div>
            <button
              type="button"
              class={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                props.newTaskDisabled
                  ? "bg-gray-3 text-gray-8"
                  : "bg-dls-text text-dls-surface hover:bg-dls-text/90"
              }`}
              disabled={props.newTaskDisabled}
              onClick={() => runPrompt(enableSoulPrompt())}
            >
              <Sparkles size={14} />
              {tr("soul.enable")}
            </button>
          </div>
        </Show>

        <div class="mt-6 rounded-xl border border-dls-border bg-dls-hover/20 p-4 space-y-3">
          <div class="flex items-center justify-between gap-3">
            <h3 class="text-sm font-semibold text-dls-text">{tr("soul.audit_title")}</h3>
            <div class="text-[11px] text-dls-secondary">
              {tr("soul.audit_checks_passing")
                .replace("{passed}", String(setupAuditItems().filter((item) => item.passed).length))
                .replace("{total}", String(setupAuditItems().length))}
            </div>
          </div>
          <div class="grid gap-2 md:grid-cols-2">
            <For each={setupAuditItems()}>
              {(item) => (
                <div
                  class={`rounded-lg border px-3 py-2 ${
                    item.passed
                      ? "border-emerald-7/40 bg-emerald-3/20"
                      : "border-dls-border bg-dls-hover/30"
                  }`}
                >
                  <div class="flex items-start gap-2">
                    <Show
                      when={item.passed}
                      fallback={<Circle size={14} class="mt-0.5 text-dls-secondary shrink-0" />}
                    >
                      <CheckCircle2 size={14} class="mt-0.5 text-emerald-11 shrink-0" />
                    </Show>
                    <div class="min-w-0">
                      <div class="text-xs font-medium text-dls-text">{item.label}</div>
                      <div class="text-[11px] text-dls-secondary truncate">{item.detail}</div>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>

      <div class="grid gap-6 lg:grid-cols-2">
        <div class="rounded-2xl border border-dls-border bg-dls-surface p-6 space-y-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="text-base font-semibold text-dls-text">{tr("soul.proof_title")}</h3>
              <p class="text-xs text-dls-secondary">{tr("soul.proof_subtitle")}</p>
            </div>
            <Show when={props.loadingHeartbeats}>
              <span class="text-xs text-dls-secondary">{tr("soul.loading")}</span>
            </Show>
          </div>

          <Show
            when={latestHeartbeat()}
            fallback={
              <div class="rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-6 text-sm text-dls-secondary">
                {tr("soul.no_entries")}
              </div>
            }
          >
            {(entry) => (
              <div class="rounded-xl border border-dls-border bg-dls-hover/30 px-4 py-3 space-y-2">
                <div class="flex items-center gap-2 text-xs text-dls-secondary">
                  <span class={`h-2 w-2 rounded-full ${statusMeta().dot}`} />
                  {tr("soul.latest_check_in")} {relativeTime(entry().ts)}
                </div>
                <div class="text-sm text-dls-text">{entry().summary}</div>
                <Show when={entry().nextAction}>
                  <div class="text-xs text-dls-text">
                    <span class="text-dls-secondary">{tr("soul.next")}:</span> {entry().nextAction}
                  </div>
                </Show>
                <Show when={entry().looseEnds.length > 0}>
                  <div class="space-y-1">
                    <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{tr("soul.loose_ends")}</div>
                    <ul class="space-y-1 text-xs text-dls-secondary">
                      <For each={entry().looseEnds.slice(0, 3)}>
                        {(item) => <li>- {item}</li>}
                      </For>
                    </ul>
                  </div>
                </Show>
              </div>
            )}
          </Show>

          <Show when={props.heartbeats.length > 1}>
            <div class="space-y-3 max-h-[18rem] overflow-y-auto pr-1">
              <For each={props.heartbeats.slice(1)}>
                {(entry) => (
                  <div class="rounded-xl border border-dls-border bg-dls-hover/20 px-4 py-3 space-y-1.5">
                    <div class="text-xs text-dls-secondary">{relativeTime(entry.ts)}</div>
                    <div class="text-sm text-dls-text">{entry.summary}</div>
                    <Show when={entry.nextAction}>
                      <div class="text-xs text-dls-secondary truncate">{tr("soul.next")}: {entry.nextAction}</div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="space-y-6">
          <div class="rounded-2xl border border-dls-border bg-dls-surface p-6 space-y-4">
            <div>
              <h3 class="text-base font-semibold text-dls-text">{tr("soul.steering_title")}</h3>
              <p class="text-xs text-dls-secondary">
                {tr("soul.steering_subtitle")}
              </p>
            </div>

            <div class="space-y-2">
              <For each={steeringAudit()}>
                {(item) => (
                  <div class="rounded-lg border border-dls-border bg-dls-hover/20 px-3 py-2 flex items-start gap-2">
                    <Show
                      when={item.passed}
                      fallback={<Circle size={14} class="mt-0.5 text-dls-secondary shrink-0" />}
                    >
                      <CheckCircle2 size={14} class="mt-0.5 text-emerald-11 shrink-0" />
                    </Show>
                    <div class="min-w-0">
                      <div class="text-xs font-medium text-dls-text">{item.label}</div>
                      <div class="text-[11px] text-dls-secondary truncate">{item.detail}</div>
                    </div>
                  </div>
                )}
              </For>
            </div>

            <div class="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                class="rounded-xl border border-dls-border px-3 py-2 text-left text-sm text-dls-text hover:bg-dls-hover disabled:opacity-60"
                disabled={props.newTaskDisabled || heartbeatRunState() === "running"}
                onClick={runHeartbeatNow}
              >
                {heartbeatRunState() === "running" ? tr("soul.running_heartbeat") : tr("soul.run_heartbeat_now")}
              </button>
              <button
                type="button"
                class="rounded-xl border border-dls-border px-3 py-2 text-left text-sm text-dls-text hover:bg-dls-hover disabled:opacity-60"
                disabled={props.newTaskDisabled}
                onClick={() =>
                  runPrompt(
                    currentLocale() === "cs"
                      ? `Projděte ${props.workspaceRoot || "tento worker"} spolu s .opencode/soul.md, posledními heartbeat záznamy, pravidly v AGENTS.md, nedávnými relacemi, otevřenými todo a úryvky z opencode.db. Seřaďte tři nejdůležitější volné konce a navrhněte konkrétní plán s prvním krokem.`
                      : `Review ${props.workspaceRoot || "this worker"} with .opencode/soul.md, recent heartbeat entries, AGENTS.md guidance, recent sessions, open todos, and transcript snippets from opencode.db. Prioritize the top 3 loose ends and propose a concrete plan with one first step.`,
                  )
                }
              >
                {tr("soul.prioritize_loose_ends")}
              </button>
              <button
                type="button"
                class="rounded-xl border border-dls-border px-3 py-2 text-left text-sm text-dls-text hover:bg-dls-hover disabled:opacity-60 sm:col-span-2"
                disabled={props.newTaskDisabled}
                onClick={() =>
                  runPrompt(
                    currentLocale() === "cs"
                      ? "Proveď improvement sweep pro Soul: přečti .opencode/soul.md a AGENTS.md, načti z opencode.db nedávné relace, todo a textové části transcriptů pro tento pracovní prostor a navrhni tři konkrétní zlepšení pro procesy, skills a agenty. Pokud je to bezpečné, aktualizuj v .opencode/soul.md sekce Loose ends a Recurring chores a vysvětli každou změnu."
                      : "Run a Soul improvement sweep: read .opencode/soul.md and AGENTS.md, query recent sessions/todos/transcript text for this workspace from opencode.db, then propose 3 concrete improvements for process/skills/agents. If safe, update Loose ends and Recurring chores in .opencode/soul.md and explain every change.",
                  )
                }
              >
                {tr("soul.improvement_sweep")}
              </button>
            </div>

            <div class={`rounded-xl border px-3 py-2 text-xs ${heartbeatStatusCardTone()}`}>
              <div class="font-medium">{heartbeatStatusTitle()}</div>
              <div class="mt-1">{heartbeatRunMessage() || tr("soul.heartbeat_idle_message")}</div>
            </div>
          </div>

          <div class="rounded-2xl border border-dls-border bg-dls-surface p-6 space-y-4">
            <div class="space-y-2">
              <label class="text-xs font-medium text-dls-secondary">{tr("soul.current_focus")}</label>
              <input
                type="text"
                value={focusInput()}
                onInput={(event) => setFocusInput(event.currentTarget.value)}
                placeholder={tr("soul.focus_placeholder")}
                class="w-full rounded-xl border border-dls-border bg-dls-hover/40 px-3 py-2 text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none"
              />
              <button
                type="button"
                class="rounded-lg border border-dls-border px-3 py-1.5 text-xs text-dls-text hover:bg-dls-hover disabled:opacity-60"
                disabled={props.newTaskDisabled || !focusInput().trim()}
                onClick={() =>
                  runPrompt(
                    formatTr("soul.update_focus_prompt", {
                      section: tr("soul.current_focus"),
                      value: focusInput().trim(),
                    }),
                  )
                }
              >
                {tr("soul.update_focus")}
              </button>
            </div>

            <div class="space-y-2">
              <label class="text-xs font-medium text-dls-secondary">{tr("soul.boundaries")}</label>
              <input
                type="text"
                value={boundariesInput()}
                onInput={(event) => setBoundariesInput(event.currentTarget.value)}
                placeholder={tr("soul.boundaries_placeholder")}
                class="w-full rounded-xl border border-dls-border bg-dls-hover/40 px-3 py-2 text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none"
              />
              <button
                type="button"
                class="rounded-lg border border-dls-border px-3 py-1.5 text-xs text-dls-text hover:bg-dls-hover disabled:opacity-60"
                disabled={props.newTaskDisabled || !boundariesInput().trim()}
                onClick={() =>
                  runPrompt(
                    currentLocale() === "cs"
                      ? `Aktualizuj v .opencode/soul.md sekci Preferences o tuto hranici: ${boundariesInput().trim()}. Zachovej stávající preference, přidej to jako jasné guardrail a shrň výsledný seznam hranic.`
                      : `Update .opencode/soul.md Preferences with this boundary: ${boundariesInput().trim()}. Keep existing preferences, append this as a clear guardrail, and summarize the final boundaries list.`,
                  )
                }
              >
                {tr("soul.update_boundaries")}
              </button>
            </div>

            <div class="space-y-2 rounded-xl border border-dls-border bg-dls-hover/30 p-3">
              <div class="flex items-center gap-2 text-sm text-dls-text">
                <Activity size={14} class="text-dls-secondary" />
                {tr("soul.cadence")}
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <select
                  class="rounded-lg border border-dls-border bg-dls-surface px-2 py-1.5 text-xs text-dls-text"
                  value={cadence()}
                  onChange={(event) => setCadence(event.currentTarget.value)}
                >
                  <For each={cadenceOptions}>
                    {(option) => <option value={option.cron}>{tr(option.labelKey)}</option>}
                  </For>
                </select>
                <button
                  type="button"
                  class="rounded-lg border border-dls-border px-3 py-1.5 text-xs text-dls-text hover:bg-dls-hover disabled:opacity-60"
                disabled={props.newTaskDisabled}
                onClick={() =>
                  runPrompt(
                      currentLocale() === "cs"
                        ? `Aktualizuj scheduler job soul-heartbeat na ${cadenceLabel()} s cron výrazem ${cadence()}. Potvrď, že se změna povedla, uveď další očekávané okno heartbeatů a zmiň, jestli se změnil práh pro stale detection.`
                        : `Update the soul-heartbeat scheduler job to ${cadenceLabel()} using cron ${cadence()}. Confirm the scheduler update succeeded, report the next expected heartbeat window, and mention whether stale detection threshold changed.`,
                    )
                  }
                >
                  {tr("soul.apply_cadence")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
