import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import type { AutomationRun, VesloAutomation } from "./automations.js";
import {
  appendOrReplaceAutomationRun,
  readAutomationStore,
  resolveAutomationsPath,
  resolveLegacyAgentLabAutomationsPath,
  upsertAutomation,
  writeAutomationStore,
} from "./automation-store.js";

const workspaceId = "workspace-test";

test("empty store returns schema version and empty lists", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = await readAutomationStore(workspaceRoot, workspaceId);

    expect(store.schemaVersion).toBe(1);
    expect(store.items).toEqual([]);
    expect(store.runs).toEqual([]);
    expect(store.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

test("create and upsert write .opencode/veslo/automations.json", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const automation = makeAutomation({ id: "auto_daily", name: "Daily Check" });

    const store = await upsertAutomation(workspaceRoot, automation);
    const persisted = JSON.parse(await readFile(resolveAutomationsPath(workspaceRoot), "utf8"));

    expect(store.items).toHaveLength(1);
    expect(persisted.items).toEqual([automation]);
    expect(persisted.runs).toEqual([]);
    expect(resolveAutomationsPath(workspaceRoot)).toBe(join(workspaceRoot, ".opencode", "veslo", "automations.json"));

    const updated = { ...automation, name: "Daily Check Updated", updatedAt: "2026-06-01T11:00:00.000Z" };
    const updatedStore = await upsertAutomation(workspaceRoot, updated);

    expect(updatedStore.items).toEqual([updated]);
    expect(JSON.parse(await readFile(resolveAutomationsPath(workspaceRoot), "utf8")).items).toEqual([updated]);
  });
});

test("run history is preserved separately from automation definitions", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const automation = makeAutomation({ id: "auto_run_history" });
    const run = makeRun({ id: "run_auto_run_history_1", automationId: automation.id });

    await upsertAutomation(workspaceRoot, automation);
    const withRun = await appendOrReplaceAutomationRun(workspaceRoot, run);
    const persisted = JSON.parse(await readFile(resolveAutomationsPath(workspaceRoot), "utf8"));

    expect(withRun.items).toEqual([automation]);
    expect(withRun.runs).toEqual([run]);
    expect(persisted.items[0].lastRunId).toBeNull();
    expect(persisted.runs).toEqual([run]);

    const replacement = { ...run, status: "failed" as const, error: "boom" };
    const replaced = await appendOrReplaceAutomationRun(workspaceRoot, replacement);

    expect(replaced.items).toEqual([automation]);
    expect(replaced.runs).toEqual([replacement]);
  });
});

test("old Agent Lab automations migrate when the new file is missing", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const legacyStore = {
      schemaVersion: 1,
      updatedAt: Date.parse("2026-06-01T10:00:00.000Z"),
      items: [{
        id: "agentlab_daily",
        name: "Legacy Daily",
        enabled: true,
        schedule: { kind: "daily", hour: 9, minute: 0 },
        prompt: "Legacy prompt",
        createdAt: Date.parse("2026-06-01T10:00:00.000Z"),
        lastRunAt: Date.parse("2026-06-02T09:00:00.000Z"),
        lastRunSessionId: "ses_legacy",
      }],
    };
    const legacyPath = resolveLegacyAgentLabAutomationsPath(workspaceRoot);
    await mkdir(join(workspaceRoot, ".opencode", "veslo", "agentlab"), { recursive: true });
    await writeFile(legacyPath, JSON.stringify(legacyStore, null, 2) + "\n", "utf8");

    const store = await readAutomationStore(workspaceRoot, workspaceId);

    expect(store.items).toEqual([{
      id: "agentlab_daily",
      workspaceId,
      name: "Legacy Daily",
      enabled: true,
      status: "active",
      schedule: { kind: "daily", hour: 9, minute: 0 },
      prompt: "Legacy prompt",
      target: {},
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
      lastRunId: "run_agentlab_daily_2026-06-02T09-00-00-000Z",
    }]);
    expect(store.runs).toEqual([{
      id: "run_agentlab_daily_2026-06-02T09-00-00-000Z",
      automationId: "agentlab_daily",
      scheduledFor: "2026-06-02T09:00:00.000Z",
      startedAt: "2026-06-02T09:00:00.000Z",
      finishedAt: "2026-06-02T09:00:00.000Z",
      status: "success",
      sessionId: "ses_legacy",
      createdSession: false,
    }]);
    expect(JSON.parse(await readFile(resolveAutomationsPath(workspaceRoot), "utf8"))).toEqual(store);
    expect(await readFile(legacyPath, "utf8")).toContain("Legacy Daily");
  });
});

test("successful one-shot automation remains in store as completed", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const automation = makeAutomation({
      id: "auto_one_shot",
      enabled: false,
      status: "completed",
      schedule: { kind: "oneShot", runAt: "2026-06-02T09:00:00.000Z" },
      completedAt: "2026-06-02T09:05:00.000Z",
      lastRunId: "run_auto_one_shot",
    });
    const run = makeRun({
      id: "run_auto_one_shot",
      automationId: automation.id,
      scheduledFor: "2026-06-02T09:00:00.000Z",
      startedAt: "2026-06-02T09:00:01.000Z",
      finishedAt: "2026-06-02T09:05:00.000Z",
      status: "success",
    });

    await writeAutomationStore(workspaceRoot, {
      schemaVersion: 1,
      updatedAt: "2026-06-02T09:05:00.000Z",
      items: [automation],
      runs: [run],
    });

    const store = await readAutomationStore(workspaceRoot, workspaceId);

    expect(store.items).toEqual([automation]);
    expect(store.runs).toEqual([run]);
  });
});

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-automation-store-"));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function makeAutomation(overrides: Partial<VesloAutomation> = {}): VesloAutomation {
  return {
    id: "auto_daily",
    workspaceId,
    name: "Daily",
    enabled: true,
    status: "active",
    schedule: { kind: "daily", hour: 9, minute: 0 },
    prompt: "Run daily check",
    target: {},
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    nextRunAt: null,
    completedAt: null,
    lastRunId: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run_auto_daily_1",
    automationId: "auto_daily",
    scheduledFor: "2026-06-01T09:00:00.000Z",
    startedAt: "2026-06-01T09:00:01.000Z",
    finishedAt: "2026-06-01T09:02:00.000Z",
    status: "success",
    sessionId: "ses_daily",
    createdSession: false,
    error: null,
    ...overrides,
  };
}
