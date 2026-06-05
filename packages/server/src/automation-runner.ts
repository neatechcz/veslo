import {
  type AutomationRun,
  type AutomationTarget,
  type VesloAutomation,
  computeNextAutomationRunAt,
} from "./automations.js";
import {
  type AutomationStoreData,
  mutateAutomationStore,
  readAutomationStore,
} from "./automation-store.js";
import { ApiError } from "./errors.js";

export type AutomationExecutionInput = {
  workspaceId: string;
  workspaceRoot: string;
  automation: VesloAutomation;
  scheduledFor: string;
  target: AutomationTarget;
  prompt: string;
};

export type AutomationExecutionResult = { sessionId: string; createdSession: boolean };

export type AutomationRunner = {
  start(): Promise<void>;
  stop(): void;
  refreshWorkspace(workspaceId: string): Promise<void>;
  runNow(workspaceId: string, automationId: string): Promise<AutomationRun>;
};

type WorkspaceRef = { id: string; path: string };

type TimerHandle = unknown;

type TimerEntry = {
  handle: TimerHandle;
  generation: number;
};

type RunnerOptions = {
  workspaces: WorkspaceRef[];
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  execute: (input: AutomationExecutionInput) => Promise<AutomationExecutionResult>;
};

const RECOVERY_GRACE_MS = 24 * 60 * 60 * 1000;
const STALE_SKIP_ERROR = "Scheduled automation was missed by more than 24 hours";

export function createAutomationRunner(options: RunnerOptions): AutomationRunner {
  const workspaceById = new Map(options.workspaces.map((workspace) => [workspace.id, workspace]));
  const now = options.now ?? Date.now;
  const scheduleTimeout = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearScheduledTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const timersByWorkspace = new Map<string, Set<TimerEntry>>();
  let stopped = true;
  let generation = 0;

  async function start(): Promise<void> {
    generation += 1;
    stopped = false;
    for (const workspace of options.workspaces) {
      await refreshWorkspace(workspace.id);
    }
  }

  function stop(): void {
    stopped = true;
    generation += 1;
    for (const workspaceId of timersByWorkspace.keys()) {
      clearWorkspaceTimers(workspaceId);
    }
  }

  async function refreshWorkspace(workspaceId: string): Promise<void> {
    const workspace = requireWorkspace(workspaceId);
    clearWorkspaceTimers(workspace.id);
    if (stopped) return;

    const store = await readAutomationStore(workspace.path, workspace.id);
    for (const item of store.items) {
      if (stopped) return;
      if (!isRunnableAutomation(item)) continue;

      let automation = item;
      let nextRunAt = automation.nextRunAt ?? null;
      if (!nextRunAt) {
        nextRunAt = computeNextAutomationRunAt(automation.schedule, now());
        automation = await persistAutomation(workspace, {
          ...automation,
          nextRunAt,
          updatedAt: nowIso(now),
        });
      }

      if (!nextRunAt) continue;
      await recoverOrSchedule(workspace, automation.id, nextRunAt);
    }
  }

  async function runNow(workspaceId: string, automationId: string): Promise<AutomationRun> {
    const workspace = requireWorkspace(workspaceId);
    const store = await readAutomationStore(workspace.path, workspace.id);
    const automation = store.items.find((item) => item.id === automationId);
    if (!automation) {
      throw new ApiError(404, "not_found", "Automation not found");
    }

    const scheduledFor = nowIso(now);
    const runId = uniqueRunId(store, stableRunId(automation.id, scheduledFor));
    const finalRun = await executeOccurrence(workspace, automation, scheduledFor, runId);
    await schedulePersistedNext(workspace, automation.id);
    return finalRun;
  }

  async function recoverOrSchedule(workspace: WorkspaceRef, automationId: string, scheduledFor: string): Promise<void> {
    const scheduledMs = Date.parse(scheduledFor);
    const nowMs = now();
    if (scheduledMs > nowMs) {
      scheduleCachedTimer(workspace, automationId, scheduledFor, scheduledMs - nowMs);
      return;
    }

    if (nowMs - scheduledMs > RECOVERY_GRACE_MS) {
      const skipped = await skipStaleOccurrence(workspace, automationId, scheduledFor);
      if (skipped) {
        await schedulePersistedNext(workspace, automationId);
      }
      return;
    }

    const finalRun = await runScheduledOccurrence(workspace, automationId, scheduledFor);
    if (finalRun) {
      await schedulePersistedNext(workspace, automationId);
    }
  }

  async function runScheduledOccurrence(
    workspace: WorkspaceRef,
    automationId: string,
    scheduledFor: string,
  ): Promise<AutomationRun | null> {
    const store = await readAutomationStore(workspace.path, workspace.id);
    const automation = store.items.find((item) => item.id === automationId);
    if (!automation || !isRunnableAutomation(automation) || automation.nextRunAt !== scheduledFor) {
      return null;
    }

    const runId = stableRunId(automation.id, scheduledFor);
    const existing = store.runs.find((run) => run.id === runId);
    if (existing && isInProgressOrTerminal(existing)) {
      if (isTerminalRun(existing)) {
        await persistAutomationAfterRun(workspace, automation, existing, now());
      }
      return existing;
    }

    return executeOccurrence(workspace, automation, scheduledFor, runId);
  }

  async function executeOccurrence(
    workspace: WorkspaceRef,
    automation: VesloAutomation,
    scheduledFor: string,
    runId: string,
  ): Promise<AutomationRun> {
    const startedAt = nowIso(now);
    const runningRun: AutomationRun = {
      id: runId,
      automationId: automation.id,
      scheduledFor,
      startedAt,
      finishedAt: null,
      status: "running",
      sessionId: null,
      createdSession: false,
      error: null,
    };
    const prepared = await appendRunningRun(workspace, runningRun);
    if (!prepared.shouldExecute) {
      if (isTerminalRun(prepared.run)) {
        await persistAutomationAfterRun(workspace, automation, prepared.run, now());
      }
      return prepared.run;
    }

    try {
      const result = await options.execute({
        workspaceId: workspace.id,
        workspaceRoot: workspace.path,
        automation,
        scheduledFor,
        target: automation.target,
        prompt: automation.prompt,
      });
      const successRun: AutomationRun = {
        ...runningRun,
        finishedAt: nowIso(now),
        status: "success",
        sessionId: result.sessionId,
        createdSession: result.createdSession,
        error: null,
      };
      await appendRun(workspace, successRun);
      await persistAutomationAfterRun(workspace, automation, successRun, now());
      return successRun;
    } catch (error) {
      const failedRun: AutomationRun = {
        ...runningRun,
        finishedAt: nowIso(now),
        status: "failed",
        sessionId: null,
        createdSession: false,
        error: errorMessage(error),
      };
      await appendRun(workspace, failedRun);
      await persistAutomationAfterRun(workspace, automation, failedRun, now());
      return failedRun;
    }
  }

  async function skipStaleOccurrence(
    workspace: WorkspaceRef,
    automationId: string,
    scheduledFor: string,
  ): Promise<AutomationRun | null> {
    const store = await readAutomationStore(workspace.path, workspace.id);
    const automation = store.items.find((item) => item.id === automationId);
    if (!automation || !isRunnableAutomation(automation) || automation.nextRunAt !== scheduledFor) {
      return null;
    }

    const runId = stableRunId(automation.id, scheduledFor);
    const existing = store.runs.find((run) => run.id === runId);
    if (existing && isInProgressOrTerminal(existing)) {
      if (isTerminalRun(existing)) {
        await persistAutomationAfterRun(workspace, automation, existing, now());
      }
      return existing;
    }

    const skippedRun: AutomationRun = {
      id: runId,
      automationId: automation.id,
      scheduledFor,
      startedAt: null,
      finishedAt: nowIso(now),
      status: "skipped",
      sessionId: null,
      createdSession: false,
      error: STALE_SKIP_ERROR,
    };
    await appendRun(workspace, skippedRun);
    await persistAutomationAfterRun(workspace, automation, skippedRun, now());
    return skippedRun;
  }

  async function persistAutomationAfterRun(
    workspace: WorkspaceRef,
    automation: VesloAutomation,
    run: AutomationRun,
    finishedMs: number,
  ): Promise<VesloAutomation> {
    const finishedAt = nowIso(() => finishedMs);
    let updated: VesloAutomation;

    if (run.status === "failed") {
      updated = {
        ...automation,
        enabled: false,
        status: "failed",
        updatedAt: finishedAt,
        lastRunId: run.id,
      };
    } else if (automation.schedule.kind === "oneShot") {
      updated = {
        ...automation,
        enabled: false,
        status: "completed",
        completedAt: finishedAt,
        nextRunAt: null,
        updatedAt: finishedAt,
        lastRunId: run.id,
      };
    } else {
      updated = {
        ...automation,
        enabled: true,
        status: "active",
        nextRunAt: computeNextFutureRunAt(automation, run.scheduledFor, finishedMs),
        updatedAt: finishedAt,
        lastRunId: run.id,
      };
    }

    return persistAutomation(workspace, updated);
  }

  async function persistAutomation(workspace: WorkspaceRef, automation: VesloAutomation): Promise<VesloAutomation> {
    let saved = automation;
    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      const items = store.items.map((item) => (item.id === automation.id ? automation : item));
      saved = items.find((item) => item.id === automation.id) ?? automation;
      return { ...store, updatedAt: nowIso(now), items };
    });
    return saved;
  }

  async function appendRun(workspace: WorkspaceRef, run: AutomationRun): Promise<void> {
    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      return { ...store, updatedAt: nowIso(now), runs: appendOrReplaceRun(store.runs, run) };
    });
  }

  async function appendRunningRun(
    workspace: WorkspaceRef,
    run: AutomationRun,
  ): Promise<{ run: AutomationRun; shouldExecute: boolean }> {
    let result: { run: AutomationRun; shouldExecute: boolean } = { run, shouldExecute: true };
    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      const existing = store.runs.find((item) => item.id === run.id);
      if (existing && isInProgressOrTerminal(existing)) {
        result = { run: existing, shouldExecute: false };
        return store;
      }
      return { ...store, updatedAt: nowIso(now), runs: appendOrReplaceRun(store.runs, run) };
    });
    return result;
  }

  async function schedulePersistedNext(workspace: WorkspaceRef, automationId: string): Promise<void> {
    if (stopped) return;
    const store = await readAutomationStore(workspace.path, workspace.id);
    const automation = store.items.find((item) => item.id === automationId);
    if (!automation || !isRunnableAutomation(automation) || !automation.nextRunAt) {
      return;
    }
    const scheduledMs = Date.parse(automation.nextRunAt);
    const delayMs = scheduledMs - now();
    if (delayMs > 0) {
      scheduleCachedTimer(workspace, automation.id, automation.nextRunAt, delayMs);
    }
  }

  function scheduleCachedTimer(
    workspace: WorkspaceRef,
    automationId: string,
    scheduledFor: string,
    delayMs: number,
  ): void {
    if (stopped) return;
    const timerGeneration = generation;
    const handle = scheduleTimeout(() => {
      if (stopped || timerGeneration !== generation) return;
      void runScheduledOccurrence(workspace, automationId, scheduledFor)
        .then((run) => {
          if (run) {
            return schedulePersistedNext(workspace, automationId);
          }
          return undefined;
        })
        .catch(() => undefined);
    }, Math.max(0, delayMs));
    const entry: TimerEntry = { handle, generation: timerGeneration };
    const entries = timersByWorkspace.get(workspace.id) ?? new Set<TimerEntry>();
    entries.add(entry);
    timersByWorkspace.set(workspace.id, entries);
  }

  function clearWorkspaceTimers(workspaceId: string): void {
    const entries = timersByWorkspace.get(workspaceId);
    if (!entries) return;
    for (const entry of entries) {
      clearScheduledTimeout(entry.handle);
    }
    timersByWorkspace.delete(workspaceId);
  }

  function requireWorkspace(workspaceId: string): WorkspaceRef {
    const workspace = workspaceById.get(workspaceId);
    if (!workspace) {
      throw new ApiError(404, "not_found", "Workspace not found");
    }
    return workspace;
  }

  return { start, stop, refreshWorkspace, runNow };
}

function isRunnableAutomation(automation: VesloAutomation): boolean {
  return automation.enabled && automation.status === "active";
}

function isInProgressOrTerminal(run: AutomationRun): boolean {
  return run.status === "running" || isTerminalRun(run);
}

function isTerminalRun(run: AutomationRun): boolean {
  return run.status === "success" || run.status === "failed" || run.status === "skipped";
}

function appendOrReplaceRun(runs: AutomationRun[], run: AutomationRun): AutomationRun[] {
  const nextRuns = [...runs];
  const existingIndex = nextRuns.findIndex((item) => item.id === run.id);
  if (existingIndex === -1) {
    nextRuns.push(run);
  } else {
    nextRuns[existingIndex] = run;
  }
  return nextRuns;
}

function uniqueRunId(store: AutomationStoreData, baseRunId: string): string {
  if (!store.runs.some((run) => run.id === baseRunId)) {
    return baseRunId;
  }
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = `${baseRunId}_${index}`;
    if (!store.runs.some((run) => run.id === candidate)) {
      return candidate;
    }
  }
  throw new Error("Unable to allocate automation run id");
}

function stableRunId(automationId: string, scheduledFor: string): string {
  return `run_${sanitizeIdPart(automationId)}_${sanitizeIdPart(String(Date.parse(scheduledFor)))}`;
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "automation";
}

function computeNextFutureRunAt(automation: VesloAutomation, scheduledFor: string, finishedMs: number): string | null {
  const scheduledMs = Date.parse(scheduledFor);
  const baseMs = Math.max(Number.isFinite(scheduledMs) ? scheduledMs : finishedMs, finishedMs);
  const nextRunAt = computeNextAutomationRunAt(automation.schedule, baseMs);
  if (!nextRunAt || Date.parse(nextRunAt) > finishedMs) {
    return nextRunAt;
  }
  return computeNextAutomationRunAt(automation.schedule, finishedMs);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}
