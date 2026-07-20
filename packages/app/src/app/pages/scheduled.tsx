import { For, Match, Show, Switch, createMemo, createSignal, untrack, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";

import type {
  AutomationWorkspaceSummary,
  VesloAutomation,
  VesloAutomationCreatePayload,
  VesloAutomationRun,
  VesloAutomationSchedule,
  VesloAutomationStatus,
  VesloAutomationUpdatePayload,
  WorkspaceAutomationItem,
} from "../types";
import { formatRelativeTime } from "../utils";
import { currentLocale, t, type Language } from "../../i18n";
import { createAsyncAction } from "../hooks/create-async-action";
import {
  buildSchedule,
  resolveLocalScheduleTimezone,
  scheduledDayOptions,
} from "./scheduled-automation-schedule";

import Button from "../components/button";
import {
  BookOpen,
  Brain,
  Calendar,
  Clock,
  FolderOpen,
  MessageSquare,
  Plus,
  Play,
  RefreshCw,
  Trash2,
  TrendingUp,
  Trophy,
  X,
} from "lucide-solid";

export type ScheduledTasksViewProps = {
  automationItems: WorkspaceAutomationItem[];
  automationWorkspaces: AutomationWorkspaceSummary[];
  defaultAutomationWorkspaceId: string | null;
  source: "local" | "remote";
  sourceReady: boolean;
  status: string | null;
  busy: boolean;
  lastUpdatedAt: number | null;
  refreshJobs: (options?: { force?: boolean }) => void;
  createAutomation: (workspaceId: string, payload: VesloAutomationCreatePayload) => Promise<void> | void;
  updateAutomation: (workspaceId: string, automationId: string, payload: VesloAutomationUpdatePayload) => Promise<void> | void;
  deleteAutomation: (workspaceId: string, automationId: string) => Promise<void> | void;
  runAutomation: (workspaceId: string, automationId: string) => Promise<void> | void;
  newTaskDisabled: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;
  canReloadWorkspace: boolean;
};

type AutomationTemplate = {
  icon: Component<{ size?: number; class?: string }>;
  nameKey: string;
  descriptionKey: string;
  promptKey: string;
  tone?: string;
  scheduleMode: "daily" | "interval";
  scheduleTime?: string;
  scheduleDays?: string[];
  intervalHours?: number;
};

const automationTemplates: AutomationTemplate[] = [
  {
    icon: Calendar,
    nameKey: "scheduled.template_daily_planning_name",
    descriptionKey: "scheduled.template_daily_planning_description",
    promptKey: "scheduled.template_daily_planning_prompt",
    tone: "text-blue-9",
    scheduleMode: "daily",
    scheduleTime: "08:30",
    scheduleDays: ["mo", "tu", "we", "th", "fr"],
  },
  {
    icon: BookOpen,
    nameKey: "scheduled.template_inbox_zero_name",
    descriptionKey: "scheduled.template_inbox_zero_description",
    promptKey: "scheduled.template_inbox_zero_prompt",
    tone: "text-teal-9",
    scheduleMode: "daily",
    scheduleTime: "17:30",
    scheduleDays: ["mo", "tu", "we", "th", "fr"],
  },
  {
    icon: MessageSquare,
    nameKey: "scheduled.template_meeting_prep_name",
    descriptionKey: "scheduled.template_meeting_prep_description",
    promptKey: "scheduled.template_meeting_prep_prompt",
    tone: "text-indigo-9",
    scheduleMode: "daily",
    scheduleTime: "18:00",
    scheduleDays: ["mo", "tu", "we", "th", "fr"],
  },
  {
    icon: TrendingUp,
    nameKey: "scheduled.template_weekly_wins_name",
    descriptionKey: "scheduled.template_weekly_wins_description",
    promptKey: "scheduled.template_weekly_wins_prompt",
    tone: "text-emerald-9",
    scheduleMode: "daily",
    scheduleTime: "16:00",
    scheduleDays: ["fr"],
  },
  {
    icon: Trophy,
    nameKey: "scheduled.template_learning_digest_name",
    descriptionKey: "scheduled.template_learning_digest_description",
    promptKey: "scheduled.template_learning_digest_prompt",
    tone: "text-amber-9",
    scheduleMode: "daily",
    scheduleTime: "10:00",
    scheduleDays: ["su"],
  },
  {
    icon: Brain,
    nameKey: "scheduled.template_habit_check_name",
    descriptionKey: "scheduled.template_habit_check_description",
    promptKey: "scheduled.template_habit_check_prompt",
    tone: "text-pink-9",
    scheduleMode: "interval",
    intervalHours: 6,
  },
];

const pad2 = (value: number) => String(value).padStart(2, "0");

const toRelative = (value?: string | null, locale: Language = currentLocale()) => {
  const neverLabel = t("scheduled.never", locale);
  if (!value) return neverLabel;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return neverLabel;
  return formatRelativeTime(parsed);
};

const describeSchedule = (schedule: VesloAutomationSchedule, locale: Language = currentLocale()) => {
  const tr = (key: string, replacements?: Record<string, string>) => {
    let value = t(key, locale);
    for (const [name, replacement] of Object.entries(replacements ?? {})) {
      value = value.replace(`{${name}}`, replacement);
    }
    return value;
  };

  if (schedule.kind === "daily") {
    return tr("scheduled.every_day_at", { time: `${pad2(schedule.hour)}:${pad2(schedule.minute)}` });
  }
  if (schedule.kind === "weekly") {
    const dayKey = [
      "",
      "scheduled.day_mon",
      "scheduled.day_tue",
      "scheduled.day_wed",
      "scheduled.day_thu",
      "scheduled.day_fri",
      "scheduled.day_sat",
      "scheduled.day_sun",
    ][schedule.weekday] ?? "scheduled.custom_schedule";
    return `${tr(dayKey)} ${tr("scheduled.at_time", { time: `${pad2(schedule.hour)}:${pad2(schedule.minute)}` }).toLowerCase()}`;
  }
  if (schedule.kind === "interval") {
    const hours = Math.max(1, Math.round(schedule.seconds / 3600));
    return hours === 1 ? tr("scheduled.every_hour") : tr("scheduled.every_n_hours", { n: String(hours) });
  }
  if (schedule.kind === "oneShot") {
    return tr("scheduled.one_shot_at", { time: new Date(schedule.runAt).toLocaleString(locale) });
  }
  return `${tr("scheduled.cron_label")} ${schedule.expression}`;
};

const automationStatusLabel = (status: VesloAutomationStatus, locale: Language = currentLocale()) => {
  const tr = (key: string) => t(key, locale);
  if (status === "active") return tr("scheduled.status_active");
  if (status === "paused") return tr("scheduled.status_paused");
  if (status === "completed") return tr("scheduled.status_completed");
  if (status === "cancelled") return tr("scheduled.status_cancelled");
  return tr("scheduled.status_failed");
};

const statusTone = (status?: string | null) => {
  if (status === "active" || status === "success") return "border-emerald-7/60 bg-emerald-3/60 text-emerald-11";
  if (status === "failed" || status === "cancelled") return "border-red-7/60 bg-red-3/60 text-red-11";
  if (status === "paused" || status === "running" || status === "queued") return "border-amber-7/60 bg-amber-3/60 text-amber-11";
  if (status === "completed") return "border-blue-7/60 bg-blue-3/60 text-blue-11";
  return "border-gray-6 bg-gray-2 text-gray-9";
};

const latestRunFor = (automation: VesloAutomation, runs: VesloAutomationRun[]) => {
  if (automation.lastRunId) {
    const matched = runs.find((run) => run.id === automation.lastRunId);
    if (matched) return matched;
  }
  return [...runs].sort((a, b) => Date.parse(b.finishedAt ?? b.startedAt ?? b.scheduledFor) - Date.parse(a.finishedAt ?? a.startedAt ?? a.scheduledFor))[0] ?? null;
};

const AutomationTemplateCard = (props: {
  icon: Component<{ size?: number; class?: string }>;
  name: string;
  description: string;
  tone?: string;
  onClick?: () => void;
  disabled?: boolean;
}) => {
  return (
    <button
      type="button"
      onClick={() => props.onClick?.()}
      disabled={props.disabled}
      class={`group w-full rounded-2xl border bg-gray-1 p-5 text-left transition-shadow hover:shadow-md ${
        props.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      } border-gray-4 hover:border-gray-5`}
    >
      <div class={`mb-4 flex h-8 w-8 items-center justify-center rounded-lg border border-gray-3 bg-gray-1 ${props.tone ?? ""}`}>
        <Dynamic component={props.icon} size={18} />
      </div>
      <div class="mb-1 text-sm font-semibold text-gray-12">{props.name}</div>
      <p class="text-[13px] text-gray-10 leading-relaxed group-hover:text-gray-12">{props.description}</p>
    </button>
  );
};

const AutomationCard = (props: {
  item: WorkspaceAutomationItem;
  busy: boolean;
  onDelete: () => void;
  onEdit: () => void;
  onRun: () => void;
}) => {
  const locale = () => currentLocale();
  const tr = (key: string) => t(key, locale());
  const automation = () => props.item.automation;
  const latestRun = createMemo(() => latestRunFor(automation(), props.item.runs));
  const target = () => automation().target;
  const workspace = () => props.item.workspace;

  return (
    <div
      data-testid="scheduled-automation-card"
      data-automation-id={automation().id}
      data-automation-workspace-id={workspace().serverWorkspaceId ?? ""}
      class="flex flex-col gap-4 rounded-2xl border border-gray-4 bg-gray-1 p-5 shadow-sm"
    >
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex min-w-0 items-start gap-3">
          <div class={`flex h-8 w-8 items-center justify-center rounded-lg border bg-gray-1 ${statusTone(automation().status)}`}>
            <Calendar size={18} />
          </div>
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="text-sm font-semibold text-gray-12 truncate">{automation().name}</h3>
              <span class={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${statusTone(automation().status)}`}>
                {automationStatusLabel(automation().status, locale())}
              </span>
            </div>
            <div class="mt-1 text-xs text-gray-9">{describeSchedule(automation().schedule, locale())}</div>
            <div class="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-8">
              <span>{tr("scheduled.workspace_label")} <span class="font-medium text-gray-11">{workspace().name}</span></span>
              <Show when={workspace().status !== "ready"}>
                <span class="rounded-full border border-amber-7/50 bg-amber-3/60 px-2 py-0.5 text-amber-11">
                  {workspace().status}
                </span>
              </Show>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            data-testid="scheduled-automation-run"
            onClick={() => props.onRun()}
            disabled={props.busy || automation().status === "cancelled" || !workspace().serverWorkspaceId}
            class={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              props.busy || automation().status === "cancelled" || !workspace().serverWorkspaceId
                ? "border-gray-5 text-gray-8"
                : "border-gray-5 text-gray-10 hover:bg-gray-2/70 hover:text-gray-12"
            }`}
          >
            <Play size={12} />
            {tr("scheduled.run")}
          </button>
          <button
            type="button"
            data-testid="scheduled-automation-edit"
            onClick={() => props.onEdit()}
            disabled={props.busy || !workspace().serverWorkspaceId}
            class={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              props.busy || !workspace().serverWorkspaceId
                ? "border-gray-5 text-gray-8"
                : "border-gray-5 text-gray-10 hover:bg-gray-2/70 hover:text-gray-12"
            }`}
          >
            {tr("scheduled.edit")}
          </button>
          <button
            type="button"
            data-testid="scheduled-automation-delete"
            onClick={() => props.onDelete()}
            disabled={props.busy || automation().status === "cancelled" || !workspace().serverWorkspaceId}
            class={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              props.busy || automation().status === "cancelled" || !workspace().serverWorkspaceId
                ? "border-gray-5 text-gray-8"
                : "border-red-6 text-red-10 hover:bg-red-3"
            }`}
          >
            <Trash2 size={12} />
            {tr("scheduled.delete")}
          </button>
        </div>
      </div>

      <div class="grid gap-3 md:grid-cols-2">
        <div class="rounded-xl border border-gray-4 bg-gray-2/60 px-3 py-3">
          <div class="text-[10px] uppercase text-gray-8">{tr("scheduled.prompt_label")}</div>
          <div class="mt-1 line-clamp-3 break-words text-sm text-gray-12">{automation().prompt}</div>
        </div>
        <div class="rounded-xl border border-gray-4 bg-gray-2/60 px-3 py-3 space-y-2">
          <div class="text-[10px] uppercase text-gray-8">{tr("scheduled.run_context")}</div>
          <Show when={target()?.fallbackTitle ?? target()?.preferredSessionId} fallback={<div class="text-xs text-gray-9">{tr("scheduled.default")}</div>}>
            <div class="flex items-center gap-2 text-xs text-gray-9">
              <FolderOpen size={14} class="text-gray-8" />
              <span class="break-all text-gray-12">{target()?.fallbackTitle ?? target()?.preferredSessionId}</span>
            </div>
          </Show>
          <Show when={target()?.agent}>
            <div class="text-xs text-gray-9">{tr("scheduled.agent")} <span class="text-gray-12">{target()?.agent}</span></div>
          </Show>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-4 text-xs text-gray-9">
        <div class="flex items-center gap-1">
          <Clock size={12} />
          {tr("scheduled.next_run")} {toRelative(automation().nextRunAt, locale())}
        </div>
        <div>
          {tr("scheduled.last_run")}{" "}
          <Show when={latestRun()} fallback={toRelative(null, locale())}>
            {(run) => `${toRelative(run().finishedAt ?? run().startedAt ?? run().scheduledFor, locale())} (${run().status})`}
          </Show>
        </div>
        <div>{tr("scheduled.created")} {toRelative(automation().createdAt, locale())}</div>
      </div>
    </div>
  );
};

export default function ScheduledTasksView(props: ScheduledTasksViewProps) {
  const locale = () => currentLocale();
  const tr = (key: string, replacements?: Record<string, string>) => {
    let value = t(key, locale());
    for (const [name, replacement] of Object.entries(replacements ?? {})) {
      value = value.replace(`{${name}}`, replacement);
    }
    return value;
  };

  const [createModalOpen, setCreateModalOpen] = createSignal(false);
  const [editTarget, setEditTarget] = createSignal<WorkspaceAutomationItem | null>(null);
  const [automationName, setAutomationName] = createSignal(tr("scheduled.default_name"));
  const [automationProject, setAutomationProject] = createSignal("");
  const [automationPrompt, setAutomationPrompt] = createSignal(tr("scheduled.default_prompt"));
  const [automationWorkspaceId, setAutomationWorkspaceId] = createSignal("");
  const [automationAgent, setAutomationAgent] = createSignal("");
  const [automationVariant, setAutomationVariant] = createSignal("");
  const [automationStatus, setAutomationStatus] = createSignal<VesloAutomationStatus>("active");
  const [automationEnabled, setAutomationEnabled] = createSignal(true);
  const [scheduleMode, setScheduleMode] = createSignal<"daily" | "interval" | "oneShot">("daily");
  const [scheduleTime, setScheduleTime] = createSignal("09:00");
  const [scheduleDays, setScheduleDays] = createSignal(["mo", "tu", "we", "th", "fr"]);
  const [intervalHours, setIntervalHours] = createSignal(6);
  const [runAtDate, setRunAtDate] = createSignal(new Date().toISOString().slice(0, 10));
  const [runAtTime, setRunAtTime] = createSignal("09:00");
  const [quickMinutes, setQuickMinutes] = createSignal(0);
  const [statusFilter, setStatusFilter] = createSignal<"active" | "paused" | "completed" | "failed">("active");
  const [workspaceFilter, setWorkspaceFilter] = createSignal("all");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [deleteTarget, setDeleteTarget] = createSignal<WorkspaceAutomationItem | null>(null);
  const createAction = createAsyncAction();
  const updateAction = createAsyncAction();
  const runAction = createAsyncAction();
  const deleteAction = createAsyncAction();
  const scheduleTimezone = createMemo(() => resolveLocalScheduleTimezone());

  const createModalDisabled = createMemo(() => !props.sourceReady || props.busy);
  const readyWorkspaces = createMemo(() => props.automationWorkspaces.filter((workspace) => workspace.status === "ready" && workspace.serverWorkspaceId));
  const noReadyWorkspaces = createMemo(() => readyWorkspaces().length === 0);
  const defaultWorkspaceId = createMemo(() => {
    const preferredWorkspace = readyWorkspaces().find((workspace) => workspace.serverWorkspaceId === props.defaultAutomationWorkspaceId);
    return preferredWorkspace?.serverWorkspaceId ?? readyWorkspaces()[0]?.serverWorkspaceId ?? "";
  });
  const serverUnavailable = createMemo(() => !props.sourceReady);
  const sourceDescription = createMemo(() =>
    props.sourceReady
      ? tr("scheduled.source_server_desc")
      : props.source === "remote"
        ? tr("scheduled.support_remote")
        : tr("scheduled.support_local_server"),
  );
  const lastUpdatedLabel = createMemo(() => props.lastUpdatedAt ? formatRelativeTime(props.lastUpdatedAt) : tr("scheduled.not_synced"));
  const selectedSchedule = createMemo(() =>
    buildSchedule(scheduleMode(), {
      timeValue: scheduleTime(),
      days: scheduleDays(),
      intervalHours: intervalHours(),
      runAtDate: runAtDate(),
      runAtTime: runAtTime(),
      quickMinutes: quickMinutes(),
    }, scheduleTimezone()),
  );
  const canCreateAutomation = createMemo(() => {
    return automationName().trim().length > 0 && automationPrompt().trim().length > 0 && Boolean(selectedSchedule()) && Boolean(automationWorkspaceId()) && !createModalDisabled();
  });
  const statusGroups = createMemo(() => ({
    active: props.automationItems.filter((item) => item.automation.status === "active"),
    paused: props.automationItems.filter((item) => item.automation.status === "paused"),
    completed: props.automationItems.filter((item) => item.automation.status === "completed"),
    failed: props.automationItems.filter((item) => item.automation.status === "failed" || item.automation.status === "cancelled"),
  }));
  const visibleItems = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    return statusGroups()[statusFilter()].filter((item) => {
      if (workspaceFilter() !== "all" && item.workspace.serverWorkspaceId !== workspaceFilter()) return false;
      if (!query) return true;
      return [
        item.automation.name,
        item.automation.prompt,
        item.workspace.name,
        item.workspace.path ?? "",
      ].some((value) => value.toLowerCase().includes(query));
    });
  });

  const resetScheduleForm = () => {
    setScheduleMode("daily");
    setScheduleTime("09:00");
    setScheduleDays(["mo", "tu", "we", "th", "fr"]);
    setIntervalHours(6);
    setRunAtDate(new Date().toISOString().slice(0, 10));
    setRunAtTime("09:00");
    setQuickMinutes(0);
  };

  const loadScheduleForm = (schedule: VesloAutomationSchedule) => {
    if (schedule.kind === "daily") {
      setScheduleMode("daily");
      setScheduleTime(`${pad2(schedule.hour)}:${pad2(schedule.minute)}`);
      setScheduleDays(["mo", "tu", "we", "th", "fr"]);
      return;
    }
    if (schedule.kind === "weekly") {
      const day = scheduledDayOptions.find((option) => option.weekday === schedule.weekday)?.id;
      setScheduleMode("daily");
      setScheduleTime(`${pad2(schedule.hour)}:${pad2(schedule.minute)}`);
      setScheduleDays(day ? [day] : ["mo", "tu", "we", "th", "fr"]);
      return;
    }
    if (schedule.kind === "interval") {
      setScheduleMode("interval");
      setIntervalHours(Math.max(1, Math.round(schedule.seconds / 3600)));
      return;
    }
    if (schedule.kind === "oneShot") {
      const parsed = new Date(schedule.runAt);
      setScheduleMode("oneShot");
      if (Number.isFinite(parsed.getTime())) {
        setRunAtDate(parsed.toISOString().slice(0, 10));
        setRunAtTime(parsed.toISOString().slice(11, 16));
      }
      return;
    }
    resetScheduleForm();
  };

  const openCreateModal = () => {
    if (createModalDisabled()) return;
    const workspaceId = defaultWorkspaceId();
    setAutomationWorkspaceId(workspaceId);
    setAutomationName(tr("scheduled.default_name"));
    setAutomationPrompt(tr("scheduled.default_prompt"));
    setAutomationAgent("");
    setAutomationVariant("");
    setAutomationStatus("active");
    setAutomationEnabled(true);
    resetScheduleForm();
    if (!automationProject().trim()) setAutomationProject(automationName().trim());
    setCreateModalOpen(true);
  };

  const applyAutomationTemplate = (template: AutomationTemplate) => {
    resetScheduleForm();
    setAutomationName(tr(template.nameKey));
    setAutomationPrompt(tr(template.promptKey));
    setScheduleMode(template.scheduleMode);
    if (template.scheduleMode === "interval") {
      setIntervalHours(template.intervalHours ?? 6);
    } else {
      setScheduleTime(template.scheduleTime ?? "09:00");
      setScheduleDays(template.scheduleDays ?? ["mo", "tu", "we", "th", "fr"]);
    }
    setAutomationProject(tr(template.nameKey));
    setAutomationWorkspaceId(defaultWorkspaceId());
    setAutomationAgent("");
    setAutomationVariant("");
    setAutomationStatus("active");
    setAutomationEnabled(true);
  };

  const openEditModal = (item: WorkspaceAutomationItem) => {
    const target = item.automation.target;
    setEditTarget(item);
    setAutomationWorkspaceId(item.workspace.serverWorkspaceId ?? "");
    setAutomationName(item.automation.name);
    setAutomationPrompt(item.automation.prompt);
    setAutomationProject(target?.fallbackTitle ?? target?.preferredSessionId ?? item.automation.name);
    setAutomationAgent(target?.agent ?? "");
    setAutomationVariant(target?.variant ?? "");
    setAutomationStatus(item.automation.status);
    setAutomationEnabled(item.automation.enabled);
    loadScheduleForm(item.automation.schedule);
  };

  const handleCreateAutomation = async () => {
    const schedule = selectedSchedule();
    if (!schedule || !canCreateAutomation()) return;
    await createAction.execute(() => untrack(() => (async () => {
      const targetTitle = automationProject().trim() || automationName().trim();
      await props.createAutomation(automationWorkspaceId(), {
        name: automationName().trim(),
        prompt: automationPrompt().trim(),
        schedule,
        target: targetTitle ? { fallbackTitle: targetTitle } : undefined,
        });
      setCreateModalOpen(false);
    })()));
  };

  const handleUpdateAutomation = async () => {
    const target = editTarget();
    const schedule = selectedSchedule();
    const workspaceId = target?.workspace.serverWorkspaceId;
    if (!target || !workspaceId || !schedule || automationName().trim().length === 0 || automationPrompt().trim().length === 0) return;
    await updateAction.execute(() => untrack(() => (async () => {
      const targetPayload = {
        fallbackTitle: automationProject().trim() || undefined,
        agent: automationAgent().trim() || undefined,
        model: null,
        variant: automationVariant().trim() || null,
      };
      await props.updateAutomation(workspaceId, target.automation.id, {
        name: automationName().trim(),
        prompt: automationPrompt().trim(),
        schedule,
        enabled: automationEnabled(),
        status: automationStatus(),
        target: Object.values(targetPayload).some((value) => value) ? targetPayload : null,
      });
      setEditTarget(null);
    })()));
  };

  const runAutomationNow = async (item: WorkspaceAutomationItem) => {
    const workspaceId = item.workspace.serverWorkspaceId;
    if (!workspaceId) return;
    await runAction.execute(() => untrack(() => (async () => {
      await props.runAutomation(workspaceId, item.automation.id);
    })()));
  };

  const confirmDelete = async () => {
    const target = deleteTarget();
    const workspaceId = target?.workspace.serverWorkspaceId;
    if (!target || !workspaceId) return;
    await deleteAction.execute(() => untrack(() => (async () => {
      await props.deleteAutomation(workspaceId, target.automation.id);
      setDeleteTarget(null);
    })()));
  };

  const toggleDay = (id: string) => {
    setScheduleDays((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return Array.from(next);
    });
  };

  const updateIntervalHours = (value: string) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    setIntervalHours(Math.min(24, Math.max(1, parsed)));
  };

  return (
    <section data-testid="scheduled-automations-page" class="space-y-8">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div class="flex items-center gap-2">
            <h2 class="text-2xl font-semibold text-gray-12">{tr("scheduled.title")}</h2>
            <span class="rounded border border-gray-4 px-1.5 py-0.5 text-[10px] font-bold uppercase text-gray-8">
              {tr("scheduled.beta")}
            </span>
          </div>
          <p class="mt-2 text-sm text-gray-9">{sourceDescription()}</p>
          <div class="mt-1 text-xs text-gray-8">{tr("scheduled.last_updated")} {lastUpdatedLabel()}</div>
        </div>
        <div class="flex items-center gap-3">
          <button
            type="button"
            data-testid="scheduled-automations-refresh"
            onClick={() => props.refreshJobs({ force: true })}
            disabled={props.busy}
            class={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
              props.busy ? "text-gray-8" : "text-gray-9 hover:text-gray-12"
            }`}
          >
            <RefreshCw size={14} />
            {props.busy ? tr("scheduled.refreshing") : tr("scheduled.refresh")}
          </button>
          <button
            type="button"
            onClick={openCreateModal}
            disabled={createModalDisabled()}
            class={`flex items-center gap-1.5 rounded-md border border-transparent bg-dls-accent px-3 py-1.5 text-xs font-medium text-[#001932] transition-colors ${
              createModalDisabled() ? "opacity-50" : "hover:bg-[var(--dls-accent-hover)]"
            }`}
          >
            <Plus size={14} />
            {tr("scheduled.new_automation")}
          </button>
        </div>
      </div>

      <Show when={serverUnavailable()}>
        <div class="rounded-2xl border border-gray-5 bg-gray-2/70 px-5 py-5 shadow-sm">
          <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div class="flex items-start gap-3">
              <div class="flex h-10 w-10 items-center justify-center rounded-xl border border-gray-4 bg-gray-1">
                <RefreshCw size={18} class="text-gray-10" />
              </div>
              <div>
                <div class="text-sm font-semibold text-gray-12">{tr("scheduled.server_unavailable_title")}</div>
                <div class="mt-1 text-xs text-gray-9">{tr("scheduled.server_unavailable_hint")}</div>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => void props.reloadWorkspaceEngine()} disabled={!props.canReloadWorkspace || props.reloadBusy}>
                {props.reloadBusy ? tr("scheduled.reloading") : tr("scheduled.reload_veslo")}
              </Button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={props.status || createAction.error() || updateAction.error() || runAction.error() || deleteAction.error()}>
        <div class="rounded-xl border border-red-7/40 bg-red-3/60 px-5 py-4 text-sm text-red-11">
          {props.status ?? createAction.error() ?? updateAction.error() ?? runAction.error() ?? deleteAction.error()}
        </div>
      </Show>

      <div class="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={searchQuery()}
          onInput={(event) => setSearchQuery(event.currentTarget.value)}
          placeholder={tr("scheduled.search_placeholder")}
          class="min-w-[220px] flex-1 rounded-xl border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8 focus:border-gray-7 focus:outline-none"
        />
        <select
          value={workspaceFilter()}
          onChange={(event) => setWorkspaceFilter(event.currentTarget.value)}
          class="rounded-xl border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 focus:border-gray-7 focus:outline-none"
        >
          <option value="all">{tr("scheduled.all_workspaces")}</option>
          <For each={readyWorkspaces()}>
            {(workspace) => (
              <option value={workspace.serverWorkspaceId ?? ""}>
                {workspace.name}
              </option>
            )}
          </For>
        </select>
      </div>

      <Show when={props.automationWorkspaces.some((workspace) => workspace.status !== "ready")}>
        <div class="space-y-2">
          <For each={props.automationWorkspaces.filter((workspace) => workspace.status !== "ready")}>
            {(workspace) => (
              <div class="rounded-xl border border-amber-7/40 bg-amber-3/50 px-4 py-3 text-xs text-amber-12">
                <span class="font-semibold">{workspace.name}</span>: {workspace.error ?? tr("scheduled.workspace_unavailable")}
              </div>
            )}
          </For>
        </div>
      </Show>

      <div class="flex flex-wrap gap-2">
        <For
          each={[
            { id: "active" as const, label: tr("scheduled.status_active"), count: statusGroups().active.length },
            { id: "paused" as const, label: tr("scheduled.status_paused"), count: statusGroups().paused.length },
            { id: "completed" as const, label: tr("scheduled.status_completed"), count: statusGroups().completed.length },
            { id: "failed" as const, label: tr("scheduled.status_failed_cancelled"), count: statusGroups().failed.length },
          ]}
        >
          {(item) => (
            <button
              type="button"
              onClick={() => setStatusFilter(item.id)}
              class={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                statusFilter() === item.id
                  ? "border-[var(--dls-accent-border)] bg-[var(--dls-accent-tint)] text-dls-text"
                  : "border-transparent text-[var(--dls-button-ghost)] hover:bg-[var(--dls-accent-tint)] hover:text-dls-accent"
              }`}
            >
              {item.label} <span class="opacity-70">{item.count}</span>
            </button>
          )}
        </For>
      </div>

      <Show
        when={props.automationItems.length > 0}
        fallback={
          <div class="space-y-4">
            <div class="text-center text-sm text-gray-9">{tr("scheduled.no_automations")}</div>
          </div>
        }
      >
        <Show when={visibleItems().length > 0} fallback={<div class="rounded-xl border border-gray-4 bg-gray-2/60 px-5 py-4 text-sm text-gray-9">{tr("scheduled.no_filtered_automations")}</div>}>
          <div class="grid w-full grid-cols-1 gap-4">
            <For each={visibleItems()}>
              {(item) => (
                <AutomationCard
                  item={item}
                  busy={props.busy || runAction.busy() || deleteAction.busy()}
                  onDelete={() => setDeleteTarget(item)}
                  onEdit={() => openEditModal(item)}
                  onRun={() => void runAutomationNow(item)}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={deleteTarget()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm">
          <div class="w-full max-w-md overflow-hidden rounded-2xl border border-gray-6 bg-gray-1 shadow-2xl">
            <div class="space-y-4 p-6">
              <h3 class="text-lg font-semibold text-gray-12">{tr("scheduled.delete_title")}</h3>
              <p class="text-sm text-gray-9">{tr("scheduled.delete_desc_server")}</p>
              <div class="rounded-xl border border-gray-6 bg-gray-2 p-3 font-mono text-xs text-gray-9 break-all">
                {deleteTarget()?.automation.name}
              </div>
              <div class="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteAction.busy()}>
                  {tr("scheduled.cancel")}
                </Button>
                <Button variant="danger" onClick={confirmDelete} disabled={deleteAction.busy()}>
                  {deleteAction.busy() ? tr("scheduled.deleting") : tr("scheduled.delete")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={createModalOpen()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-[2px]">
          <div class="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-gray-6 bg-gray-1 shadow-2xl">
            <div class="space-y-6 p-8">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h2 class="text-xl font-semibold text-gray-12">{tr("scheduled.create_title")}</h2>
                  <p class="mt-2 text-xs text-gray-9">{tr("scheduled.create_description_server")}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(false)}
                  class="rounded-md p-1 text-[var(--dls-button-ghost)] transition-colors hover:bg-[var(--dls-accent-tint)] hover:text-dls-accent"
                >
                  <X size={18} />
                </button>
              </div>

              <div class="space-y-6">
                <div>
                  <label class="mb-2 block text-[11px] font-bold uppercase text-gray-8">{tr("scheduled.workspace_label")}</label>
                  <Show
                    when={!noReadyWorkspaces()}
                    fallback={
                      <div class="rounded-xl border border-amber-7/40 bg-amber-3/50 px-4 py-3 text-xs text-amber-12">
                        <div class="font-semibold">{tr("scheduled.no_ready_workspaces_title")}</div>
                        <div class="mt-1">{tr("scheduled.no_ready_workspaces_hint")}</div>
                      </div>
                    }
                  >
                    <select
                      value={automationWorkspaceId()}
                      onChange={(event) => setAutomationWorkspaceId(event.currentTarget.value)}
                      class="w-full rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:border-blue-7 focus:outline-none focus:ring-1 focus:ring-blue-9/20"
                    >
                      <For each={readyWorkspaces()}>
                        {(workspace) => (
                          <option value={workspace.serverWorkspaceId ?? ""}>
                            {workspace.name}
                          </option>
                        )}
                      </For>
                    </select>
                  </Show>
                </div>
                <div>
                  <div class="mb-2 block text-[11px] font-bold uppercase text-gray-8">{tr("scheduled.templates_label")}</div>
                  <div class="grid gap-3 md:grid-cols-2">
                    <For each={automationTemplates}>
                      {(card) => (
                        <AutomationTemplateCard
                          icon={card.icon}
                          name={tr(card.nameKey)}
                          description={tr(card.descriptionKey)}
                          tone={card.tone}
                          onClick={() => applyAutomationTemplate(card)}
                        />
                      )}
                    </For>
                  </div>
                </div>
                <div>
                  <label class="mb-2 block text-[11px] font-bold uppercase text-gray-8">{tr("scheduled.label_name")}</label>
                  <input
                    type="text"
                    value={automationName()}
                    onInput={(event) => setAutomationName(event.currentTarget.value)}
                    class="w-full rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:border-blue-7 focus:outline-none focus:ring-1 focus:ring-blue-9/20"
                  />
                </div>
                <div>
                  <label class="mb-2 block text-[11px] font-bold uppercase text-gray-8">{tr("scheduled.label_fallback_title")}</label>
                  <input
                    type="text"
                    value={automationProject()}
                    onInput={(event) => setAutomationProject(event.currentTarget.value)}
                    placeholder={tr("scheduled.placeholder_fallback_title")}
                    class="w-full rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:border-blue-7 focus:outline-none focus:ring-1 focus:ring-blue-9/20"
                  />
                </div>
                <div>
                  <label class="mb-2 block text-[11px] font-bold uppercase text-gray-8">{tr("scheduled.label_prompt")}</label>
                  <textarea
                    rows={4}
                    value={automationPrompt()}
                    onInput={(event) => setAutomationPrompt(event.currentTarget.value)}
                    class="w-full resize-none rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:border-blue-7 focus:outline-none focus:ring-1 focus:ring-blue-9/20"
                  />
                </div>
                <div>
                  <div class="mb-2 flex items-center justify-between gap-3">
                    <label class="block text-[11px] font-bold uppercase text-gray-8">{tr("scheduled.label_schedule")}</label>
                    <div class="flex rounded-lg bg-gray-3 p-0.5">
                      <For
                        each={[
                          { id: "daily" as const, label: tr("scheduled.mode_daily") },
                          { id: "interval" as const, label: tr("scheduled.mode_interval") },
                          { id: "oneShot" as const, label: tr("scheduled.mode_one_shot") },
                        ]}
                      >
                        {(item) => (
                          <button
                            type="button"
                            onClick={() => setScheduleMode(item.id)}
                            class={`rounded-md border px-3 py-1 text-[10px] font-medium transition-colors ${
                              scheduleMode() === item.id
                                ? "border-[var(--dls-accent-border)] bg-[var(--dls-accent-tint)] text-dls-text"
                                : "border-transparent text-[var(--dls-button-ghost)] hover:bg-[var(--dls-accent-tint)] hover:text-dls-accent"
                            }`}
                          >
                            {item.label}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>

                  <Switch>
                    <Match when={scheduleMode() === "daily"}>
                      <div class="flex flex-wrap items-center gap-3">
                        <div class="flex items-center justify-between rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12">
                          <input
                            type="time"
                            value={scheduleTime()}
                            onInput={(event) => setScheduleTime(event.currentTarget.value)}
                            class="bg-transparent focus:outline-none"
                          />
                          <Clock size={16} class="text-gray-8" />
                        </div>
                        <div class="flex flex-wrap gap-1">
                          <For each={scheduledDayOptions}>
                            {(day) => (
                              <button
                                type="button"
                                onClick={() => toggleDay(day.id)}
                                class={`h-8 w-8 rounded-md border text-[10px] font-medium transition-colors ${
                                  scheduleDays().includes(day.id)
                                    ? "border-[var(--dls-accent-border)] bg-[var(--dls-accent-tint)] text-dls-text"
                                    : "border-transparent text-[var(--dls-button-ghost)] hover:bg-[var(--dls-accent-tint)] hover:text-dls-accent"
                                }`}
                              >
                                {tr(day.labelKey)}
                              </button>
                            )}
                          </For>
                        </div>
                      </div>
                    </Match>
                    <Match when={scheduleMode() === "interval"}>
                      <div class="flex flex-wrap items-center gap-3">
                        <div class="flex items-center gap-2 rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12">
                          <span>{tr("scheduled.every")}</span>
                          <input
                            type="number"
                            min={1}
                            max={24}
                            value={intervalHours()}
                            onInput={(event) => updateIntervalHours(event.currentTarget.value)}
                            class="w-16 bg-transparent text-right focus:outline-none"
                          />
                          <span>{tr("scheduled.hours")}</span>
                        </div>
                      </div>
                    </Match>
                    <Match when={scheduleMode() === "oneShot"}>
                      <div class="flex flex-wrap items-center gap-3">
                        <input
                          type="date"
                          value={runAtDate()}
                          onInput={(event) => setRunAtDate(event.currentTarget.value)}
                          class="rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:outline-none"
                        />
                        <input
                          type="time"
                          value={runAtTime()}
                          onInput={(event) => setRunAtTime(event.currentTarget.value)}
                          class="rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:outline-none"
                        />
                        <div class="flex items-center gap-2 rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12">
                          <span>{tr("scheduled.quick_minutes")}</span>
                          <input
                            type="number"
                            min={0}
                            max={1440}
                            value={quickMinutes()}
                            onInput={(event) => setQuickMinutes(Math.max(0, Number.parseInt(event.currentTarget.value, 10) || 0))}
                            class="w-20 bg-transparent text-right focus:outline-none"
                          />
                        </div>
                      </div>
                    </Match>
                  </Switch>

                  <Show when={selectedSchedule()}>
                    {(schedule) => (
                      <div class="mt-2 text-[11px] text-gray-8">
                        {tr("scheduled.schedule_preview")} <span class="text-gray-12">{describeSchedule(schedule(), locale())}</span>
                      </div>
                    )}
                  </Show>
                </div>
              </div>
            </div>
            <div class="flex items-center justify-end gap-3 border-t border-gray-6 bg-gray-2/60 px-8 py-4">
              <button type="button" onClick={() => setCreateModalOpen(false)} class="px-4 py-2 text-xs font-medium text-gray-8 transition-colors hover:text-gray-12">
                {tr("scheduled.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void handleCreateAutomation()}
                disabled={!canCreateAutomation() || createAction.busy()}
                class={`rounded-md border border-transparent bg-dls-accent px-4 py-2 text-xs font-medium text-[#001932] transition-colors ${
                  !canCreateAutomation() || createAction.busy()
                    ? "cursor-not-allowed opacity-50"
                    : "hover:bg-[var(--dls-accent-hover)]"
                }`}
              >
                {createAction.busy() ? tr("scheduled.creating") : tr("scheduled.create")}
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={editTarget()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-[2px]">
          <div
            data-testid="scheduled-automation-edit-modal"
            class="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-gray-6 bg-gray-1 shadow-2xl"
          >
            <div class="space-y-6 p-8">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h2 class="text-xl font-semibold text-gray-12">{tr("scheduled.edit_title")}</h2>
                  <p class="mt-2 text-xs text-gray-9">
                    {tr("scheduled.edit_description")}{" "}
                    <span class="font-semibold text-gray-12">{editTarget()?.workspace.name}</span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditTarget(null)}
                  class="rounded-md p-1 text-[var(--dls-button-ghost)] transition-colors hover:bg-[var(--dls-accent-tint)] hover:text-dls-accent"
                >
                  <X size={18} />
                </button>
              </div>

              <div class="rounded-xl border border-blue-7/30 bg-blue-3/40 px-4 py-3 text-xs text-blue-12">
                {tr("scheduled.owning_workspace_hint")} <span class="font-semibold">{editTarget()?.workspace.name}</span>
              </div>

              <div class="grid gap-4 md:grid-cols-2">
                <div>
                  <label class="mb-2 block text-[11px] font-bold uppercase text-gray-8">{tr("scheduled.label_name")}</label>
                  <input
                    data-testid="scheduled-automation-edit-name"
                    type="text"
                    value={automationName()}
                    onInput={(event) => setAutomationName(event.currentTarget.value)}
                    class="w-full rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:border-blue-7 focus:outline-none focus:ring-1 focus:ring-blue-9/20"
                  />
                </div>
                <div>
                  <label class="mb-2 block text-[11px] font-bold uppercase text-gray-8">{tr("scheduled.label_fallback_title")}</label>
                  <input
                    type="text"
                    value={automationProject()}
                    onInput={(event) => setAutomationProject(event.currentTarget.value)}
                    class="w-full rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:border-blue-7 focus:outline-none focus:ring-1 focus:ring-blue-9/20"
                  />
                </div>
              </div>

              <div>
                <label class="mb-2 block text-[11px] font-bold uppercase text-gray-8">{tr("scheduled.label_prompt")}</label>
                <textarea
                  rows={4}
                  value={automationPrompt()}
                  onInput={(event) => setAutomationPrompt(event.currentTarget.value)}
                  class="w-full resize-none rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:border-blue-7 focus:outline-none focus:ring-1 focus:ring-blue-9/20"
                />
              </div>

              <div class="grid gap-4 md:grid-cols-2">
                <div>
                  <label class="mb-2 block text-[11px] font-bold uppercase text-gray-8">{tr("scheduled.agent")}</label>
                  <input
                    type="text"
                    value={automationAgent()}
                    onInput={(event) => setAutomationAgent(event.currentTarget.value)}
                    class="w-full rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:border-blue-7 focus:outline-none focus:ring-1 focus:ring-blue-9/20"
                  />
                </div>
                <div>
                  <label class="mb-2 block text-[11px] font-bold uppercase text-gray-8">{tr("scheduled.variant")}</label>
                  <input
                    type="text"
                    value={automationVariant()}
                    onInput={(event) => setAutomationVariant(event.currentTarget.value)}
                    class="w-full rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:border-blue-7 focus:outline-none focus:ring-1 focus:ring-blue-9/20"
                  />
                </div>
              </div>

              <div>
                <div class="mb-2 flex items-center justify-between gap-3">
                  <label class="block text-[11px] font-bold uppercase text-gray-8">{tr("scheduled.label_schedule")}</label>
                  <div class="flex rounded-lg bg-gray-3 p-0.5">
                    <For
                      each={[
                        { id: "daily" as const, label: tr("scheduled.mode_daily") },
                        { id: "interval" as const, label: tr("scheduled.mode_interval") },
                        { id: "oneShot" as const, label: tr("scheduled.mode_one_shot") },
                      ]}
                    >
                      {(item) => (
                        <button
                          type="button"
                          onClick={() => setScheduleMode(item.id)}
                          class={`rounded-md border px-3 py-1 text-[10px] font-medium transition-colors ${
                            scheduleMode() === item.id
                              ? "border-[var(--dls-accent-border)] bg-[var(--dls-accent-tint)] text-dls-text"
                              : "border-transparent text-[var(--dls-button-ghost)] hover:bg-[var(--dls-accent-tint)] hover:text-dls-accent"
                          }`}
                        >
                          {item.label}
                        </button>
                      )}
                    </For>
                  </div>
                </div>

                <Switch>
                  <Match when={scheduleMode() === "daily"}>
                    <div class="flex flex-wrap items-center gap-3">
                      <input
                        type="time"
                        value={scheduleTime()}
                        onInput={(event) => setScheduleTime(event.currentTarget.value)}
                        class="rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:outline-none"
                      />
                      <div class="flex flex-wrap gap-1">
                        <For each={scheduledDayOptions}>
                          {(day) => (
                            <button
                              type="button"
                              onClick={() => toggleDay(day.id)}
                              class={`h-8 w-8 rounded-md border text-[10px] font-medium transition-colors ${
                                scheduleDays().includes(day.id)
                                  ? "border-[var(--dls-accent-border)] bg-[var(--dls-accent-tint)] text-dls-text"
                                  : "border-transparent text-[var(--dls-button-ghost)] hover:bg-[var(--dls-accent-tint)] hover:text-dls-accent"
                              }`}
                            >
                              {tr(day.labelKey)}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </Match>
                  <Match when={scheduleMode() === "interval"}>
                    <div class="flex items-center gap-2 rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12">
                      <span>{tr("scheduled.every")}</span>
                      <input
                        type="number"
                        min={1}
                        max={24}
                        value={intervalHours()}
                        onInput={(event) => updateIntervalHours(event.currentTarget.value)}
                        class="w-16 bg-transparent text-right focus:outline-none"
                      />
                      <span>{tr("scheduled.hours")}</span>
                    </div>
                  </Match>
                  <Match when={scheduleMode() === "oneShot"}>
                    <div class="flex flex-wrap items-center gap-3">
                      <input
                        type="date"
                        value={runAtDate()}
                        onInput={(event) => setRunAtDate(event.currentTarget.value)}
                        class="rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:outline-none"
                      />
                      <input
                        type="time"
                        value={runAtTime()}
                        onInput={(event) => setRunAtTime(event.currentTarget.value)}
                        class="rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:outline-none"
                      />
                    </div>
                  </Match>
                </Switch>
              </div>

              <div class="grid gap-4 md:grid-cols-2">
                <div>
                  <label class="mb-2 block text-[11px] font-bold uppercase text-gray-8">{tr("scheduled.status_label")}</label>
                  <select
                    value={automationStatus()}
                    onChange={(event) => setAutomationStatus(event.currentTarget.value as VesloAutomationStatus)}
                    class="w-full rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:border-blue-7 focus:outline-none focus:ring-1 focus:ring-blue-9/20"
                  >
                    <option value="active">{tr("scheduled.status_active")}</option>
                    <option value="paused">{tr("scheduled.status_paused")}</option>
                    <option value="completed">{tr("scheduled.status_completed")}</option>
                    <option value="cancelled">{tr("scheduled.status_cancelled")}</option>
                    <option value="failed">{tr("scheduled.status_failed")}</option>
                  </select>
                </div>
                <label class="flex items-end gap-2 pb-2 text-sm text-gray-11">
                  <input
                    type="checkbox"
                    checked={automationEnabled()}
                    onChange={(event) => setAutomationEnabled(event.currentTarget.checked)}
                  />
                  {tr("scheduled.enabled_label")}
                </label>
              </div>
            </div>
            <div class="flex items-center justify-end gap-3 border-t border-gray-6 bg-gray-2/60 px-8 py-4">
              <Button variant="outline" onClick={() => setEditTarget(null)} disabled={updateAction.busy()}>
                {tr("scheduled.cancel")}
              </Button>
              <Button
                variant="primary"
                data-testid="scheduled-automation-edit-save"
                onClick={() => void handleUpdateAutomation()}
                disabled={updateAction.busy()}
              >
                {updateAction.busy() ? tr("scheduled.saving") : tr("scheduled.save_changes")}
              </Button>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
}
