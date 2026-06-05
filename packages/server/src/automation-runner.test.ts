import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import type { AutomationExecutionInput } from "./automation-runner.js";
import { createAutomationRunner } from "./automation-runner.js";
import { readAutomationStore, writeAutomationStore } from "./automation-store.js";
import type { AutomationRun, VesloAutomation } from "./automations.js";

const workspaceId = "ws_1";
const baseNow = Date.parse("2026-06-05T12:00:00.000Z");

test("schedules active future one-shot on start", async () => {
  await withHarness(async (harness) => {
    await harness.writeStore([harness.makeAutomation({
      id: "auto_future",
      schedule: { kind: "oneShot", runAt: "2026-06-05T12:05:00.000Z" },
      nextRunAt: "2026-06-05T12:05:00.000Z",
    })]);

    await harness.runner.start();

    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delayMs).toBe(5 * 60 * 1000);
    expect(harness.executions).toEqual([]);
  });
});

test("due one-shot within 24h grace runs after restart", async () => {
  await withHarness(async (harness) => {
    await harness.writeStore([harness.makeAutomation({
      id: "auto_due",
      schedule: { kind: "oneShot", runAt: "2026-06-05T11:00:00.000Z" },
      nextRunAt: "2026-06-05T11:00:00.000Z",
    })]);

    await harness.runner.start();
    await harness.flush();

    const store = await harness.readStore();
    expect(harness.executions.map((input) => input.automation.id)).toEqual(["auto_due"]);
    expect(store.runs[0]).toMatchObject({
      id: "run_auto_due_1780657200000",
      automationId: "auto_due",
      scheduledFor: "2026-06-05T11:00:00.000Z",
      status: "success",
      sessionId: "ses_new",
      createdSession: true,
    });
  });
});

test("stale one-shot older than grace is skipped and completed", async () => {
  await withHarness(async (harness) => {
    await harness.writeStore([harness.makeAutomation({
      id: "auto_stale",
      schedule: { kind: "oneShot", runAt: "2026-06-04T10:00:00.000Z" },
      nextRunAt: "2026-06-04T10:00:00.000Z",
    })]);

    await harness.runner.start();

    const store = await harness.readStore();
    expect(harness.executions).toEqual([]);
    expect(store.runs).toEqual([{
      id: "run_auto_stale_1780567200000",
      automationId: "auto_stale",
      scheduledFor: "2026-06-04T10:00:00.000Z",
      startedAt: null,
      finishedAt: "2026-06-05T12:00:00.000Z",
      status: "skipped",
      sessionId: null,
      createdSession: false,
      error: "Scheduled automation was missed by more than 24 hours",
    }]);
    expect(store.items[0]).toMatchObject({
      id: "auto_stale",
      enabled: false,
      status: "completed",
      completedAt: "2026-06-05T12:00:00.000Z",
      lastRunId: "run_auto_stale_1780567200000",
    });
  });
});

test("successful one-shot becomes completed", async () => {
  await withHarness(async (harness) => {
    await harness.writeStore([harness.makeAutomation({
      id: "auto_once",
      schedule: { kind: "oneShot", runAt: "2026-06-05T12:00:00.000Z" },
      nextRunAt: "2026-06-05T12:00:00.000Z",
      target: { preferredSessionId: "ses_existing" },
    })]);

    const run = await harness.runner.runNow(workspaceId, "auto_once");
    const store = await harness.readStore();

    expect(run).toMatchObject({
      automationId: "auto_once",
      scheduledFor: "2026-06-05T12:00:00.000Z",
      status: "success",
      sessionId: "ses_existing",
      createdSession: false,
    });
    expect(store.items[0]).toMatchObject({
      id: "auto_once",
      enabled: false,
      status: "completed",
      completedAt: "2026-06-05T12:00:00.000Z",
      lastRunId: run.id,
    });
  });
});

test("recurring computes next future occurrence after success", async () => {
  await withHarness(async (harness) => {
    await harness.writeStore([harness.makeAutomation({
      id: "auto_recurring",
      schedule: { kind: "interval", seconds: 3600 },
      nextRunAt: "2026-06-05T11:00:00.000Z",
    })]);

    await harness.runner.start();
    await harness.flush();

    const store = await harness.readStore();
    expect(harness.executions).toHaveLength(1);
    expect(store.items[0]).toMatchObject({
      id: "auto_recurring",
      enabled: true,
      status: "active",
      nextRunAt: "2026-06-05T13:00:00.000Z",
      lastRunId: "run_auto_recurring_1780657200000",
    });
    expect(store.runs.map((run) => run.status)).toEqual(["success"]);
    expect(harness.activeTimers()).toHaveLength(1);
    expect(harness.activeTimers()[0]?.delayMs).toBe(60 * 60 * 1000);
  });
});

test("duplicate scheduled occurrence does not run twice", async () => {
  await withHarness(async (harness) => {
    await harness.writeStore([
      harness.makeAutomation({
        id: "auto_dupe",
        schedule: { kind: "oneShot", runAt: "2026-06-05T11:30:00.000Z" },
        nextRunAt: "2026-06-05T11:30:00.000Z",
      }),
    ], [{
      id: "run_auto_dupe_1780659000000",
      automationId: "auto_dupe",
      scheduledFor: "2026-06-05T11:30:00.000Z",
      startedAt: "2026-06-05T11:30:01.000Z",
      finishedAt: "2026-06-05T11:32:00.000Z",
      status: "success",
      sessionId: "ses_existing",
      createdSession: false,
      error: null,
    }]);

    await harness.runner.start();
    await harness.flush();

    const store = await harness.readStore();
    expect(harness.executions).toEqual([]);
    expect(store.runs).toHaveLength(1);
  });
});

test("missing preferred session path records createdSession true", async () => {
  await withHarness(async (harness) => {
    await harness.writeStore([harness.makeAutomation({
      id: "auto_create_session",
      schedule: { kind: "oneShot", runAt: "2026-06-05T12:00:00.000Z" },
      nextRunAt: "2026-06-05T12:00:00.000Z",
      target: {},
    })]);

    const run = await harness.runner.runNow(workspaceId, "auto_create_session");

    expect(run.sessionId).toBe("ses_new");
    expect(run.createdSession).toBe(true);
  });
});

test("executor failure records failed run and disables automation", async () => {
  await withHarness(async (harness) => {
    harness.failExecution = new Error("executor exploded");
    await harness.writeStore([harness.makeAutomation({
      id: "auto_fail",
      schedule: { kind: "oneShot", runAt: "2026-06-05T12:00:00.000Z" },
      nextRunAt: "2026-06-05T12:00:00.000Z",
    })]);

    await harness.runner.start();
    const store = await harness.readStore();
    const run = store.runs[0]!;

    expect(run).toMatchObject({
      id: "run_auto_fail_1780660800000",
      status: "failed",
      error: "executor exploded",
      createdSession: false,
    });
    expect(store.items[0]).toMatchObject({
      id: "auto_fail",
      enabled: false,
      status: "failed",
      lastRunId: "run_auto_fail_1780660800000",
    });
  });
});

test("persisted running scheduled run within grace is retried on recovery", async () => {
  await withHarness(async (harness) => {
    await harness.writeStore([harness.makeAutomation({
      id: "auto_recover_running",
      schedule: { kind: "oneShot", runAt: "2026-06-05T11:00:00.000Z" },
      nextRunAt: "2026-06-05T11:00:00.000Z",
    })], [{
      id: "run_auto_recover_running_1780657200000",
      automationId: "auto_recover_running",
      scheduledFor: "2026-06-05T11:00:00.000Z",
      startedAt: "2026-06-05T11:00:01.000Z",
      finishedAt: null,
      status: "running",
      sessionId: null,
      createdSession: false,
      error: null,
    }]);

    await harness.runner.start();
    await harness.flush();

    const store = await harness.readStore();
    expect(harness.executions.map((input) => input.automation.id)).toEqual(["auto_recover_running"]);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({
      id: "run_auto_recover_running_1780657200000",
      status: "success",
      sessionId: "ses_new",
      createdSession: true,
    });
    expect(store.items[0]).toMatchObject({
      id: "auto_recover_running",
      enabled: false,
      status: "completed",
      lastRunId: "run_auto_recover_running_1780657200000",
    });
  });
});

test("stale persisted running one-shot is skipped and completed on recovery", async () => {
  await withHarness(async (harness) => {
    await harness.writeStore([harness.makeAutomation({
      id: "auto_stale_running",
      schedule: { kind: "oneShot", runAt: "2026-06-04T10:00:00.000Z" },
      nextRunAt: "2026-06-04T10:00:00.000Z",
    })], [{
      id: "run_auto_stale_running_1780567200000",
      automationId: "auto_stale_running",
      scheduledFor: "2026-06-04T10:00:00.000Z",
      startedAt: "2026-06-04T10:00:01.000Z",
      finishedAt: null,
      status: "running",
      sessionId: null,
      createdSession: false,
      error: null,
    }]);

    await harness.runner.start();

    const store = await harness.readStore();
    expect(harness.executions).toEqual([]);
    expect(store.runs).toEqual([{
      id: "run_auto_stale_running_1780567200000",
      automationId: "auto_stale_running",
      scheduledFor: "2026-06-04T10:00:00.000Z",
      startedAt: "2026-06-04T10:00:01.000Z",
      finishedAt: "2026-06-05T12:00:00.000Z",
      status: "skipped",
      sessionId: null,
      createdSession: false,
      error: "Scheduled automation was missed by more than 24 hours",
    }]);
    expect(store.items[0]).toMatchObject({
      id: "auto_stale_running",
      enabled: false,
      status: "completed",
      completedAt: "2026-06-05T12:00:00.000Z",
      lastRunId: "run_auto_stale_running_1780567200000",
    });
  });
});

test("finishing an execution preserves concurrent automation edits", async () => {
  const executionGate = new Deferred<void>();
  await withHarness(async (harness) => {
    harness.executionGate = executionGate;
    await harness.writeStore([harness.makeAutomation({
      id: "auto_edit_during_run",
      name: "Original name",
      schedule: { kind: "interval", seconds: 3600 },
      prompt: "Original prompt",
      target: { preferredSessionId: "ses_original" },
      nextRunAt: "2026-06-05T11:00:00.000Z",
    })]);

    const startPromise = harness.runner.start();
    await harness.waitForExecutions(1);

    const storeDuringRun = await harness.readStore();
    await harness.writeStore([{
      ...storeDuringRun.items[0]!,
      name: "Edited name",
      schedule: { kind: "daily", hour: 9, minute: 15 },
      prompt: "Edited prompt",
      target: { preferredSessionId: "ses_edited", fallbackTitle: "Edited fallback" },
      updatedAt: "2026-06-05T12:00:01.000Z",
    }], storeDuringRun.runs);

    executionGate.resolve();
    await startPromise;

    const store = await harness.readStore();
    expect(store.items[0]).toMatchObject({
      id: "auto_edit_during_run",
      name: "Edited name",
      schedule: { kind: "daily", hour: 9, minute: 15 },
      prompt: "Edited prompt",
      target: { preferredSessionId: "ses_edited", fallbackTitle: "Edited fallback" },
      enabled: true,
      status: "active",
      lastRunId: "run_auto_edit_during_run_1780657200000",
    });
  });
});

test("fired timer entries are not retained when refreshing recurring automations", async () => {
  await withHarness(async (harness) => {
    await harness.writeStore([harness.makeAutomation({
      id: "auto_timer_cleanup",
      schedule: { kind: "interval", seconds: 300 },
      nextRunAt: "2026-06-05T12:05:00.000Z",
    })]);
    await harness.runner.start();
    const firedTimerId = harness.activeTimers()[0]?.id;
    expect(firedTimerId).toBe(1);

    harness.currentMs = Date.parse("2026-06-05T12:05:00.000Z");
    await harness.fireTimer(firedTimerId);

    await harness.waitForActiveTimers(1);
    await harness.runner.refreshWorkspace(workspaceId);

    expect(harness.clearedTimerIds).not.toContain(firedTimerId);
    await harness.waitForActiveTimers(1);
  });
});

test("overlapping workspace refreshes do not schedule stale duplicate timers", async () => {
  const firstRefreshRead = new Deferred<void>();
  await withHarness(async (harness) => {
    let blockNextRead = false;
    let blockedReads = 0;
    harness.beforeReadWorkspaceStore = async () => {
      if (!blockNextRead) return;
      blockNextRead = false;
      blockedReads += 1;
      await firstRefreshRead.promise;
    };

    await harness.writeStore([]);
    await harness.runner.start();
    await harness.writeStore([harness.makeAutomation({
      id: "auto_overlap",
      schedule: { kind: "oneShot", runAt: "2026-06-05T12:05:00.000Z" },
      nextRunAt: "2026-06-05T12:05:00.000Z",
    })]);

    blockNextRead = true;
    const staleRefresh = harness.runner.refreshWorkspace(workspaceId);
    await harness.flush();
    expect(blockedReads).toBe(1);

    await harness.writeStore([harness.makeAutomation({
      id: "auto_overlap",
      schedule: { kind: "oneShot", runAt: "2026-06-05T12:10:00.000Z" },
      nextRunAt: "2026-06-05T12:10:00.000Z",
    })]);
    await harness.runner.refreshWorkspace(workspaceId);
    expect(harness.activeTimers()).toHaveLength(1);
    expect(harness.activeTimers()[0]?.delayMs).toBe(10 * 60 * 1000);

    firstRefreshRead.resolve();
    await staleRefresh;

    expect(harness.activeTimers()).toHaveLength(1);
    expect(harness.activeTimers()[0]?.delayMs).toBe(10 * 60 * 1000);
  });
});

test("runNow preserves a future active one-shot schedule", async () => {
  await withHarness(async (harness) => {
    await harness.writeStore([harness.makeAutomation({
      id: "auto_manual_future",
      schedule: { kind: "oneShot", runAt: "2026-06-05T12:30:00.000Z" },
      nextRunAt: "2026-06-05T12:30:00.000Z",
    })]);

    const run = await harness.runner.runNow(workspaceId, "auto_manual_future");
    const store = await harness.readStore();

    expect(run.status).toBe("success");
    expect(store.items[0]).toMatchObject({
      id: "auto_manual_future",
      enabled: true,
      status: "active",
      completedAt: null,
      nextRunAt: "2026-06-05T12:30:00.000Z",
      lastRunId: run.id,
    });
  });
});

test("runNow preserves recurring cadence", async () => {
  await withHarness(async (harness) => {
    await harness.writeStore([harness.makeAutomation({
      id: "auto_manual_recurring",
      schedule: { kind: "interval", seconds: 3600 },
      nextRunAt: "2026-06-05T12:30:00.000Z",
    })]);

    const run = await harness.runner.runNow(workspaceId, "auto_manual_recurring");
    const store = await harness.readStore();

    expect(run.status).toBe("success");
    expect(store.items[0]).toMatchObject({
      id: "auto_manual_recurring",
      enabled: true,
      status: "active",
      completedAt: null,
      nextRunAt: "2026-06-05T12:30:00.000Z",
      lastRunId: run.id,
    });
  });
});

async function withHarness(fn: (harness: RunnerHarness) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-automation-runner-"));
  const harness = new RunnerHarness(workspaceRoot);
  try {
    await fn(harness);
  } finally {
    harness.runner.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

class RunnerHarness {
  currentMs = baseNow;
  executions: AutomationExecutionInput[] = [];
  failExecution: Error | null = null;
  executionGate: Deferred<void> | null = null;
  beforeReadWorkspaceStore: (() => Promise<void>) | null = null;
  timers: Array<{ id: number; callback: () => void; delayMs: number; cleared: boolean; fired: boolean }> = [];
  clearedTimerIds: number[] = [];
  private nextTimerId = 1;
  readonly runner;

  constructor(readonly workspaceRoot: string) {
    this.runner = createAutomationRunner({
      workspaces: [{ id: workspaceId, path: this.workspaceRoot }],
      now: () => this.currentMs,
      beforeReadWorkspaceStore: async () => {
        await this.beforeReadWorkspaceStore?.();
      },
      setTimeout: (callback, delayMs) => {
        const timer = { id: this.nextTimerId++, callback, delayMs, cleared: false, fired: false };
        this.timers.push(timer);
        return timer.id;
      },
      clearTimeout: (handle) => {
        const timer = this.timers.find((item) => item.id === handle);
        if (timer) {
          timer.cleared = true;
          this.clearedTimerIds.push(timer.id);
        }
      },
      execute: async (input) => {
        this.executions.push(input);
        await this.executionGate?.promise;
        if (this.failExecution) {
          throw this.failExecution;
        }
        return {
          sessionId: input.target.preferredSessionId ?? "ses_new",
          createdSession: !input.target.preferredSessionId,
        };
      },
    });
  }

  async flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  async waitForExecutions(count: number): Promise<void> {
    await this.waitFor(() => this.executions.length >= count, `Expected ${count} executions`);
  }

  async waitForActiveTimers(count: number): Promise<void> {
    await this.waitFor(() => this.activeTimers().length === count, `Expected ${count} active timers`);
  }

  async fireTimer(timerId: number | undefined): Promise<void> {
    const timer = this.timers.find((item) => item.id === timerId);
    if (!timer) throw new Error(`Timer ${timerId} not found`);
    timer.fired = true;
    timer.callback();
    await this.flush();
  }

  activeTimers(): Array<{ id: number; callback: () => void; delayMs: number; cleared: boolean; fired: boolean }> {
    return this.timers.filter((timer) => !timer.cleared && !timer.fired);
  }

  private async waitFor(predicate: () => boolean, message: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await this.flush();
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(message);
  }

  async writeStore(items: VesloAutomation[], runs: AutomationRun[] = []): Promise<void> {
    await writeAutomationStore(this.workspaceRoot, {
      schemaVersion: 1,
      updatedAt: new Date(this.currentMs).toISOString(),
      items,
      runs,
    });
  }

  async readStore() {
    return readAutomationStore(this.workspaceRoot, workspaceId);
  }

  makeAutomation(overrides: Partial<VesloAutomation> = {}): VesloAutomation {
    return {
      id: "auto_test",
      workspaceId,
      name: "Test automation",
      enabled: true,
      status: "active",
      schedule: { kind: "oneShot", runAt: "2026-06-05T12:00:00.000Z" },
      prompt: "Run the automation",
      target: {},
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
      nextRunAt: null,
      completedAt: null,
      lastRunId: null,
      ...overrides,
    };
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveValue!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolveValue = resolve;
    });
  }

  resolve(value: T): void;
  resolve(this: Deferred<void>): void;
  resolve(value?: T): void {
    this.resolveValue(value as T);
  }
}
