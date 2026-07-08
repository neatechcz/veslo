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

type WorkspaceRef = { id: string; path: string };

export type AutomationRunner = {
  start(): Promise<void>;
  stop(): void;
  upsertWorkspace(workspace: WorkspaceRef): Promise<void>;
  removeWorkspace(workspaceId: string): void;
  refreshWorkspace(workspaceId: string): Promise<void>;
  runNow(workspaceId: string, automationId: string): Promise<AutomationRun>;
};

type TimerHandle = unknown;

type TimerEntry = {
  handle: TimerHandle;
  generation: number;
  key: string;
};

type RunnerOptions = {
  workspaces: WorkspaceRef[];
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  beforeReadWorkspaceStore?: (workspaceId: string) => Promise<void> | void;
  beforePersistMissingNextRunAt?: (workspaceId: string, automationId: string) => Promise<void> | void;
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
  const refreshGenerationsByWorkspace = new Map<string, number>();
  const inFlightRunIds = new Set<string>();
  let stopped = true;
  let generation = 0;

  async function start(): Promise<void> {
    generation += 1;
    stopped = false;
    for (const workspace of workspaceById.values()) {
      await refreshWorkspace(workspace.id);
    }
  }

  function stop(): void {
    stopped = true;
    generation += 1;
    for (const workspaceId of workspaceById.keys()) {
      bumpWorkspaceRefreshGeneration(workspaceId);
    }
    for (const workspaceId of timersByWorkspace.keys()) {
      clearWorkspaceTimers(workspaceId);
    }
  }

  async function upsertWorkspace(workspace: WorkspaceRef): Promise<void> {
    const current = workspaceById.get(workspace.id);
    workspaceById.set(workspace.id, workspace);

    if (current?.path !== workspace.path) {
      generation += 1;
      bumpWorkspaceRefreshGeneration(workspace.id);
      clearWorkspaceTimers(workspace.id);
    }

    if (!stopped) {
      await refreshWorkspace(workspace.id);
    }
  }

  function removeWorkspace(workspaceId: string): void {
    generation += 1;
    bumpWorkspaceRefreshGeneration(workspaceId);
    clearWorkspaceTimers(workspaceId);
    workspaceById.delete(workspaceId);
  }

  async function refreshWorkspace(workspaceId: string): Promise<void> {
    const workspace = requireWorkspace(workspaceId);
    const refreshGeneration = bumpWorkspaceRefreshGeneration(workspace.id);
    clearWorkspaceTimers(workspace.id);
    if (stopped) return;

    const store = await readStore(workspace);
    if (!isRefreshCurrent(workspace.id, refreshGeneration)) return;
    for (const item of store.items) {
      if (!isRefreshCurrent(workspace.id, refreshGeneration)) return;
      if (!isRunnableAutomation(item)) continue;

      let automation = item;
      let nextRunAt = automation.nextRunAt ?? null;
      if (!nextRunAt) {
        const initializedAutomation = await initializeMissingNextRunAt(workspace, automation.id);
        if (!initializedAutomation) continue;
        automation = initializedAutomation;
        nextRunAt = automation.nextRunAt ?? null;
      }

      if (!nextRunAt) continue;
      await recoverOrSchedule(workspace, automation.id, nextRunAt, refreshGeneration);
    }
  }

  async function runNow(workspaceId: string, automationId: string): Promise<AutomationRun> {
    const workspace = requireWorkspace(workspaceId);
    const store = await readStore(workspace);
    const automation = store.items.find((item) => item.id === automationId);
    if (!automation) {
      throw new ApiError(404, "not_found", "Automation not found");
    }

    const nowMs = now();
    const overdueScheduledFor = overdueActiveOneShotScheduledFor(automation, nowMs);
    const scheduledFor = overdueScheduledFor ?? nowIso(() => nowMs);
    const baseRunId = stableRunId(automation.id, scheduledFor);
    const runId = overdueScheduledFor ? baseRunId : uniqueRunId(store, baseRunId);
    const finalRun = await executeOccurrence(workspace, automation, scheduledFor, runId, {
      kind: overdueScheduledFor ? "scheduled" : "manual",
    });
    await schedulePersistedNext(workspace, automation.id);
    return finalRun;
  }

  async function recoverOrSchedule(
    workspace: WorkspaceRef,
    automationId: string,
    scheduledFor: string,
    refreshGeneration: number,
  ): Promise<void> {
    if (!isRefreshCurrent(workspace.id, refreshGeneration)) return;
    const scheduledMs = Date.parse(scheduledFor);
    const nowMs = now();
    if (scheduledMs > nowMs) {
      if (!isRefreshCurrent(workspace.id, refreshGeneration)) return;
      scheduleCachedTimer(workspace, automationId, scheduledFor, scheduledMs - nowMs);
      return;
    }

    if (nowMs - scheduledMs > RECOVERY_GRACE_MS) {
      if (!isRefreshCurrent(workspace.id, refreshGeneration)) return;
      const skipped = await skipStaleOccurrence(workspace, automationId, scheduledFor);
      if (skipped) {
        await schedulePersistedNext(workspace, automationId);
      }
      return;
    }

    if (!isRefreshCurrent(workspace.id, refreshGeneration)) return;
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
    const store = await readStore(workspace);
    const automation = store.items.find((item) => item.id === automationId);
    if (!automation || !isRunnableAutomation(automation) || automation.nextRunAt !== scheduledFor) {
      return null;
    }

    const runId = stableRunId(automation.id, scheduledFor);
    const existing = store.runs.find((run) => run.id === runId);
    if (existing && isTerminalRun(existing)) {
      await persistAutomationAfterScheduledRun(workspace, automation.id, existing, now());
      return existing;
    }
    if (existing?.status === "running" && inFlightRunIds.has(existing.id)) {
      return existing;
    }

    return executeOccurrence(workspace, automation, scheduledFor, runId, { kind: "scheduled" });
  }

  async function executeOccurrence(
    workspace: WorkspaceRef,
    automation: VesloAutomation,
    scheduledFor: string,
    runId: string,
    persistence: { kind: "scheduled" | "manual" },
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
        if (persistence.kind === "scheduled") {
          await persistAutomationAfterScheduledRun(workspace, automation.id, prepared.run, now());
        } else {
          await persistAutomationAfterManualRun(workspace, automation.id, prepared.run, now());
        }
      }
      return prepared.run;
    }

    inFlightRunIds.add(runId);
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
      if (persistence.kind === "scheduled") {
        await persistAutomationAfterScheduledRun(workspace, automation.id, successRun, now());
      } else {
        await persistAutomationAfterManualRun(workspace, automation.id, successRun, now());
      }
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
      if (persistence.kind === "scheduled") {
        await persistAutomationAfterScheduledRun(workspace, automation.id, failedRun, now());
      } else {
        await persistAutomationAfterManualRun(workspace, automation.id, failedRun, now());
      }
      return failedRun;
    } finally {
      inFlightRunIds.delete(runId);
    }
  }

  async function skipStaleOccurrence(
    workspace: WorkspaceRef,
    automationId: string,
    scheduledFor: string,
  ): Promise<AutomationRun | null> {
    const store = await readStore(workspace);
    const automation = store.items.find((item) => item.id === automationId);
    if (!automation || !isRunnableAutomation(automation) || automation.nextRunAt !== scheduledFor) {
      return null;
    }

    const runId = stableRunId(automation.id, scheduledFor);
    const existing = store.runs.find((run) => run.id === runId);
    if (existing && isTerminalRun(existing)) {
      await persistAutomationAfterScheduledRun(workspace, automation.id, existing, now());
      return existing;
    }
    if (existing?.status === "running" && inFlightRunIds.has(existing.id)) {
      return existing;
    }

    const skippedRun: AutomationRun = {
      id: runId,
      automationId: automation.id,
      scheduledFor,
      startedAt: existing?.startedAt ?? null,
      finishedAt: nowIso(now),
      status: "skipped",
      sessionId: null,
      createdSession: false,
      error: STALE_SKIP_ERROR,
    };
    await appendRun(workspace, skippedRun);
    await persistAutomationAfterScheduledRun(workspace, automation.id, skippedRun, now());
    return skippedRun;
  }

  async function persistAutomationAfterScheduledRun(
    workspace: WorkspaceRef,
    automationId: string,
    run: AutomationRun,
    finishedMs: number,
  ): Promise<void> {
    const finishedAt = nowIso(() => finishedMs);
    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      const items = store.items.map((item) => {
        if (item.id !== automationId) return item;

        if (run.status === "failed") {
          return {
            ...item,
            enabled: false,
            status: "failed" as const,
            updatedAt: finishedAt,
            lastRunId: run.id,
          };
        }

        if (item.schedule.kind === "oneShot") {
          return {
            ...item,
            enabled: false,
            status: "completed" as const,
            completedAt: finishedAt,
            nextRunAt: null,
            updatedAt: finishedAt,
            lastRunId: run.id,
          };
        }

        return {
          ...item,
          enabled: true,
          status: "active" as const,
          nextRunAt: computeNextFutureRunAt(item, run.scheduledFor, finishedMs),
          updatedAt: finishedAt,
          lastRunId: run.id,
        };
      });
      return { ...store, updatedAt: nowIso(now), items };
    });
  }

  async function persistAutomationAfterManualRun(
    workspace: WorkspaceRef,
    automationId: string,
    run: AutomationRun,
    finishedMs: number,
  ): Promise<void> {
    const finishedAt = nowIso(() => finishedMs);
    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      const items = store.items.map((item) => {
        if (item.id !== automationId) return item;
        return {
          ...item,
          updatedAt: finishedAt,
          lastRunId: run.id,
        };
      });
      return { ...store, updatedAt: nowIso(now), items };
    });
  }

  async function initializeMissingNextRunAt(
    workspace: WorkspaceRef,
    automationId: string,
  ): Promise<VesloAutomation | null> {
    await options.beforePersistMissingNextRunAt?.(workspace.id, automationId);

    let saved: VesloAutomation | null = null;
    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      const timestamp = nowIso(now);
      const items = store.items.map((item) => {
        if (item.id !== automationId) return item;
        if (!isRunnableAutomation(item) || item.nextRunAt) {
          saved = item;
          return item;
        }
        const updated = {
          ...item,
          nextRunAt: computeNextAutomationRunAt(item.schedule, now()),
          updatedAt: timestamp,
        };
        saved = updated;
        return updated;
      });
      return { ...store, updatedAt: timestamp, items };
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
      if (existing && isTerminalRun(existing)) {
        result = { run: existing, shouldExecute: false };
        return store;
      }
      if (existing?.status === "running" && inFlightRunIds.has(existing.id)) {
        result = { run: existing, shouldExecute: false };
        return store;
      }
      return { ...store, updatedAt: nowIso(now), runs: appendOrReplaceRun(store.runs, run) };
    });
    return result;
  }

  async function schedulePersistedNext(workspace: WorkspaceRef, automationId: string): Promise<void> {
    if (stopped || !hasWorkspace(workspace)) return;
    const store = await readStore(workspace);
    if (stopped || !hasWorkspace(workspace)) return;
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
    if (stopped || !hasWorkspace(workspace)) return;
    const key = timerKey(workspace.id, automationId, scheduledFor);
    const entries = timersByWorkspace.get(workspace.id) ?? new Set<TimerEntry>();
    if ([...entries].some((entry) => entry.key === key)) {
      return;
    }
    const timerGeneration = generation;
    let entry: TimerEntry | null = null;
    const handle = scheduleTimeout(() => {
      if (stopped || timerGeneration !== generation) return;
      void (async () => {
        try {
          if (!hasWorkspace(workspace)) return;
          const run = await runScheduledOccurrence(workspace, automationId, scheduledFor);
          if (run) {
            await schedulePersistedNext(workspace, automationId);
          }
        } catch {
          // Timer callbacks must not surface unhandled rejections.
        } finally {
          if (entry) {
            removeTimerEntry(workspace.id, entry);
          }
        }
      })();
    }, Math.max(0, delayMs));
    entry = { handle, generation: timerGeneration, key };
    entries.add(entry);
    timersByWorkspace.set(workspace.id, entries);
  }

  function removeTimerEntry(workspaceId: string, entry: TimerEntry): void {
    const entries = timersByWorkspace.get(workspaceId);
    if (!entries) return;
    entries.delete(entry);
    if (entries.size === 0) {
      timersByWorkspace.delete(workspaceId);
    }
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

  function hasWorkspace(workspace: WorkspaceRef): boolean {
    const current = workspaceById.get(workspace.id);
    return current?.path === workspace.path;
  }

  async function readStore(workspace: WorkspaceRef): Promise<AutomationStoreData> {
    await options.beforeReadWorkspaceStore?.(workspace.id);
    return readAutomationStore(workspace.path, workspace.id);
  }

  function bumpWorkspaceRefreshGeneration(workspaceId: string): number {
    const nextGeneration = (refreshGenerationsByWorkspace.get(workspaceId) ?? 0) + 1;
    refreshGenerationsByWorkspace.set(workspaceId, nextGeneration);
    return nextGeneration;
  }

  function isRefreshCurrent(workspaceId: string, refreshGeneration: number): boolean {
    return !stopped && workspaceById.has(workspaceId) && refreshGenerationsByWorkspace.get(workspaceId) === refreshGeneration;
  }

  return { start, stop, upsertWorkspace, removeWorkspace, refreshWorkspace, runNow };
}

function isRunnableAutomation(automation: VesloAutomation): boolean {
  return automation.enabled && automation.status === "active";
}

function overdueActiveOneShotScheduledFor(automation: VesloAutomation, nowMs: number): string | null {
  if (!isRunnableAutomation(automation) || automation.schedule.kind !== "oneShot") {
    return null;
  }
  const scheduledFor = automation.nextRunAt ?? automation.schedule.runAt;
  return Date.parse(scheduledFor) <= nowMs ? scheduledFor : null;
}

function isTerminalRun(run: AutomationRun): boolean {
  return run.status === "success" || run.status === "failed" || run.status === "skipped";
}

function timerKey(workspaceId: string, automationId: string, scheduledFor: string): string {
  return `${workspaceId}\u0000${automationId}\u0000${scheduledFor}`;
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
