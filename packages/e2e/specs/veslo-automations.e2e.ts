import { expect } from "@wdio/globals";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

type TauriInvokeResult<T> = {
  ok: boolean;
  value?: T;
  error?: string;
};

type VesloServerInfo = {
  running?: boolean;
  baseUrl?: string | null;
  clientToken?: string | null;
  hostToken?: string | null;
};

type EngineInfo = {
  running?: boolean;
  runtime?: string | null;
  baseUrl?: string | null;
  projectDir?: string | null;
  opencodeUsername?: string | null;
  opencodePassword?: string | null;
};

type WorkspaceInfo = {
  id: string;
  path?: string | null;
  directory?: string | null;
  baseUrl?: string | null;
  workspaceType?: string | null;
};

type WorkspaceBootstrap = {
  activeId?: string | null;
  workspaces: WorkspaceInfo[];
};

type WorkspaceListResponse = {
  activeId?: string | null;
  items?: WorkspaceInfo[];
};

type AutomationSchedule = {
  kind: "oneShot";
  runAt: string;
};

type VesloAutomation = {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  status: "active" | "paused" | "completed" | "failed" | "cancelled";
  schedule: AutomationSchedule;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string | null;
  completedAt?: string | null;
  lastRunId?: string | null;
};

type AutomationRun = {
  id: string;
  automationId: string;
  scheduledFor: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  status: "queued" | "running" | "success" | "failed" | "skipped";
  sessionId?: string | null;
  createdSession: boolean;
  error?: string | null;
};

type AutomationListResponse = {
  items: VesloAutomation[];
  updatedAt?: string;
};

type AutomationCreateResponse = {
  automation: VesloAutomation;
};

type AutomationRunsResponse = {
  items: AutomationRun[];
};

type GlobalMaterializationSyncResponse = {
  scope: string;
  synced: boolean;
  rootDir: string;
  materializedSkills: Array<{
    name: string;
    source?: string;
    removalPolicy?: string;
    target?: string;
    skillDir?: string;
  }>;
};

type VesloConnection = {
  baseUrl: string;
  clientToken: string;
  hostToken: string;
};

type AutomationCardSnapshot = {
  automationId: string;
  workspaceId: string;
  text: string;
};

type ScheduledAutomationsPageSnapshot = {
  url: string;
  windowHandleCount: number | null;
  hash: string;
  title: string;
  body: string;
  refreshDisabled: boolean | null;
  workspaceOptions: string[];
  cards: AutomationCardSnapshot[];
  errors: string[];
};

const isolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
const secondaryAutomationWorkspaceRoot = () =>
  join(isolatedProfileRoot(), "workspaces", "automations-secondary-workspace");
const personalGlobalManagedSkillPath = () =>
  join(
    isolatedProfileRoot(),
    ".config",
    "opencode",
    "skills",
    "veslo-managed",
    "veslo-automations",
    "SKILL.md",
  );

function trimText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function trimBaseUrl(value: string | null | undefined): string {
  return trimText(value).replace(/\/+$/, "");
}

function normalizePath(value: string | null | undefined): string {
  return trimText(value).replace(/\\/g, "/").replace(/\/+$/, "");
}

function workspaceDirectory(workspace: WorkspaceInfo): string {
  return trimText(workspace.directory) || trimText(workspace.path);
}

function futureIso(delayMs: number): string {
  return new Date(Date.now() + delayMs).toISOString();
}

async function tauriInvoke<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const result = await browser.executeAsync(
    (
      args: { command: string; payload: Record<string, unknown> },
      done: (value: TauriInvokeResult<unknown>) => void,
    ) => {
      const invoke = (
        window as typeof window & {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__?.invoke;

      if (typeof invoke !== "function") {
        done({ ok: false, error: "Tauri invoke bridge is unavailable." });
        return;
      }

      invoke(args.command, args.payload).then(
        (value) => done({ ok: true, value }),
        (error) => done({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    },
    { command, payload },
  ) as TauriInvokeResult<T>;

  if (!result.ok) {
    throw new Error(`Tauri invoke failed for ${command}: ${result.error ?? "unknown error"}`);
  }

  return result.value as T;
}

async function readActiveWorkspace(): Promise<WorkspaceInfo> {
  const bootstrap = await tauriInvoke<WorkspaceBootstrap>("workspace_bootstrap");
  const activeWorkspace = bootstrap.workspaces.find((workspace) => workspace.id === bootstrap.activeId);
  if (!activeWorkspace) {
    throw new Error(`Active workspace is not ready (activeId=${bootstrap.activeId ?? "none"}).`);
  }
  return activeWorkspace;
}

async function readSecondaryAutomationWorkspace(): Promise<WorkspaceInfo> {
  const directory = secondaryAutomationWorkspaceRoot();
  const bootstrap = await tauriInvoke<WorkspaceBootstrap>("workspace_bootstrap");
  const workspace = bootstrap.workspaces.find((candidate) => normalizePath(candidate.path) === normalizePath(directory));
  if (!workspace) {
    throw new Error("Secondary automations workspace fixture was not seeded.");
  }
  return workspace;
}

async function waitForLocalVesloServerReady(timeout = 60_000): Promise<VesloConnection> {
  let readyConnection: VesloConnection | null = null;

  await browser.waitUntil(
    async () => {
      const latest = await tauriInvoke<VesloServerInfo>("veslo_server_info").catch(() => null);
      const baseUrl = trimBaseUrl(latest?.baseUrl);
      const clientToken = trimText(latest?.clientToken);
      const hostToken = trimText(latest?.hostToken);
      if (!latest?.running || !baseUrl || !clientToken || !hostToken) return false;

      const response = await fetch(`${baseUrl}/health`).catch(() => null);
      if (!response?.ok) return false;
      const payload = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      if (payload?.ok !== true) return false;

      readyConnection = { baseUrl, clientToken, hostToken };
      return true;
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: "Local Veslo server did not become ready for automations E2E.",
    },
  );

  if (!readyConnection) {
    throw new Error("Local Veslo server became ready without connection details.");
  }

  return readyConnection;
}

async function fetchJson<T>(
  connection: Pick<VesloConnection, "baseUrl" | "clientToken">,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${connection.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${connection.clientToken}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text.trim()) {
    payload = JSON.parse(text);
  }

  if (!response.ok) {
    throw new Error(`Request ${init.method ?? "GET"} ${path} failed with ${response.status}: ${text}`);
  }

  return payload as T;
}

async function fetchWorkspaces(connection: VesloConnection): Promise<WorkspaceListResponse> {
  return fetchJson<WorkspaceListResponse>(connection, "/workspaces");
}

async function waitForServerWorkspaceByDirectory(
  connection: VesloConnection,
  directory: string,
  timeout = 90_000,
): Promise<WorkspaceInfo> {
  let latest: WorkspaceInfo | null = null;
  const normalizedDirectory = normalizePath(directory);

  await browser.waitUntil(
    async () => {
      const payload = await fetchWorkspaces(connection).catch(() => null);
      latest = payload?.items?.find((workspace) =>
        normalizePath(workspace.directory) === normalizedDirectory ||
        normalizePath(workspace.path) === normalizedDirectory
      ) ?? null;
      return Boolean(latest?.id);
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: `Veslo server workspace for ${directory} was not listed.`,
    },
  );

  return latest!;
}

async function waitForServerWorkspaceOpenCodeUrl(
  connection: VesloConnection,
  workspaceId: string,
  timeout = 90_000,
): Promise<WorkspaceInfo> {
  let latest: WorkspaceInfo | null = null;

  await browser.waitUntil(
    async () => {
      const payload = await fetchWorkspaces(connection).catch(() => null);
      latest = payload?.items?.find((workspace) => workspace.id === workspaceId) ?? null;
      return Boolean(trimBaseUrl(latest?.baseUrl));
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: `Veslo server workspace ${workspaceId} did not expose an OpenCode baseUrl.`,
    },
  );

  return latest!;
}

async function ensureActiveEngineReady(): Promise<{ workspace: WorkspaceInfo; connection: VesloConnection }> {
  const workspace = await readActiveWorkspace();
  const directory = trimText(workspace.directory) || trimText(workspace.path);
  if (!directory) throw new Error("Active workspace directory is not ready.");

  await tauriInvoke<EngineInfo>("engine_start", {
    projectDir: directory,
    preferSidecar: true,
    runtime: "veslo-orchestrator",
    workspacePaths: [directory],
  });

  await browser.waitUntil(
    async () => {
      const info = await tauriInvoke<EngineInfo>("engine_info").catch(() => null);
      return Boolean(
        info?.running &&
          trimBaseUrl(info.baseUrl) &&
          normalizePath(info.projectDir) === normalizePath(directory),
      );
    },
    {
      timeout: 180_000,
      interval: 500,
      timeoutMsg: `Active OpenCode engine did not become ready for ${directory}.`,
    },
  );

  await tauriInvoke<VesloServerInfo>("veslo_server_restart");
  const connection = await waitForLocalVesloServerReady();
  await waitForServerWorkspaceOpenCodeUrl(connection, workspace.id);
  return { workspace, connection };
}

async function syncGlobalSkillMaterialization(connection: VesloConnection): Promise<GlobalMaterializationSyncResponse> {
  const response = await fetch(`${connection.baseUrl}/skills/materialization/sync-global`, {
    method: "POST",
    headers: {
      "x-veslo-host-token": connection.hostToken,
      accept: "application/json",
    },
  });
  const payload = (await response.json()) as GlobalMaterializationSyncResponse;
  expect(response.status).toBe(200);
  return payload;
}

async function createAutomation(
  connection: VesloConnection,
  workspaceId: string,
  input: {
    id: string;
    name: string;
    runAt: string;
    prompt: string;
  },
): Promise<VesloAutomation> {
  const payload = await fetchJson<AutomationCreateResponse>(
    connection,
    `/workspace/${encodeURIComponent(workspaceId)}/automations`,
    {
      method: "POST",
      body: JSON.stringify({
        id: input.id,
        name: input.name,
        prompt: input.prompt,
        schedule: { kind: "oneShot", runAt: input.runAt },
        target: { fallbackTitle: input.name },
      }),
    },
  );
  return payload.automation;
}

async function listAutomations(connection: VesloConnection, workspaceId: string): Promise<VesloAutomation[]> {
  const payload = await fetchJson<AutomationListResponse>(
    connection,
    `/workspace/${encodeURIComponent(workspaceId)}/automations`,
  );
  return Array.isArray(payload.items) ? payload.items : [];
}

async function listAutomationRuns(
  connection: VesloConnection,
  workspaceId: string,
  automationId: string,
): Promise<AutomationRun[]> {
  const payload = await fetchJson<AutomationRunsResponse>(
    connection,
    `/workspace/${encodeURIComponent(workspaceId)}/automations/${encodeURIComponent(automationId)}/runs`,
  );
  return Array.isArray(payload.items) ? payload.items : [];
}

async function waitForCompletedAutomation(
  connection: VesloConnection,
  workspaceId: string,
  automationId: string,
): Promise<{ automation: VesloAutomation; run: AutomationRun }> {
  let latestAutomation: VesloAutomation | null = null;
  let latestRuns: AutomationRun[] = [];

  await browser.waitUntil(
    async () => {
      const automations = await listAutomations(connection, workspaceId);
      latestAutomation = automations.find((automation) => automation.id === automationId) ?? null;
      latestRuns = latestAutomation ? await listAutomationRuns(connection, workspaceId, automationId) : [];
      const successfulRun = latestRuns.find((run) => run.status === "success" && trimText(run.sessionId));
      return Boolean(latestAutomation?.status === "completed" && latestAutomation.completedAt && successfulRun);
    },
    {
      timeout: 120_000,
      interval: 1_000,
      timeoutMsg: `Automation ${automationId} did not complete successfully. Latest automation=${JSON.stringify(latestAutomation)} runs=${JSON.stringify(latestRuns)}`,
    },
  );

  const run = latestRuns.find((item) => item.status === "success" && trimText(item.sessionId));
  if (!latestAutomation || !run) {
    throw new Error(`Automation ${automationId} completed wait ended without a successful run.`);
  }
  return { automation: latestAutomation, run };
}

async function restartVesloServerAndReconnect(): Promise<VesloConnection> {
  await tauriInvoke<VesloServerInfo>("veslo_server_restart");
  return waitForLocalVesloServerReady();
}

async function ensureVesloServerConnection(): Promise<VesloConnection> {
  try {
    return await waitForLocalVesloServerReady(30_000);
  } catch {
    return restartVesloServerAndReconnect();
  }
}

async function readScheduledAutomationsPageSnapshot(): Promise<ScheduledAutomationsPageSnapshot> {
  const domSnapshot = await browser.execute(() => {
    const e2eWindow = window as typeof window & { __vesloE2eErrors?: string[] };
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="scheduled-automation-card"]')).map((card) => ({
      automationId: card.dataset.automationId ?? "",
      workspaceId: card.dataset.automationWorkspaceId ?? "",
      text: card.innerText,
    }));
    const refresh = document.querySelector<HTMLButtonElement>('[data-testid="scheduled-automations-refresh"]');
    const workspaceSelect = document.querySelector<HTMLSelectElement>('select');
    return {
      hash: window.location.hash,
      title: document.title,
      body: document.body.innerText.slice(0, 3000),
      refreshDisabled: refresh ? refresh.disabled : null,
      workspaceOptions: workspaceSelect ? Array.from(workspaceSelect.options).map((option) => `${option.value}:${option.text}`) : [],
      cards,
      errors: e2eWindow.__vesloE2eErrors ?? [],
    };
  });
  const url = await browser.getUrl().catch(() => "");
  const handles = await browser.getWindowHandles().catch(() => null);
  return {
    ...domSnapshot,
    url,
    windowHandleCount: handles?.length ?? null,
  };
}

async function waitForAutomationCards(automationNames: string[]): Promise<AutomationCardSnapshot[]> {
  let latestSnapshot: ScheduledAutomationsPageSnapshot = {
    url: "",
    windowHandleCount: null,
    hash: "",
    title: "",
    body: "",
    refreshDisabled: null,
    workspaceOptions: [],
    cards: [],
    errors: [],
  };
  await browser.waitUntil(
    async () => {
      latestSnapshot = await readScheduledAutomationsPageSnapshot();
      return automationNames.every((name) => latestSnapshot.cards.some((card) => card.text.includes(name)));
    },
    {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `Automation cards did not include ${automationNames.join(", ")}. Latest snapshot=${JSON.stringify(latestSnapshot)}`,
    },
  );
  return latestSnapshot.cards;
}

async function clickAutomationEdit(automationId: string): Promise<void> {
  await browser.waitUntil(
    async () => browser.execute((targetAutomationId) => {
      const card = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="scheduled-automation-card"]'))
        .find((candidate) => candidate.dataset.automationId === targetAutomationId);
      const editButton = card?.querySelector<HTMLButtonElement>('[data-testid="scheduled-automation-edit"]') ?? null;
      return Boolean(editButton && !editButton.disabled);
    }, automationId),
    {
      timeout: 10_000,
      interval: 250,
      timeoutMsg: `Automation ${automationId} edit button did not become enabled.`,
    },
  );

  const clicked = await browser.execute((targetAutomationId) => {
    const card = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="scheduled-automation-card"]'))
      .find((candidate) => candidate.dataset.automationId === targetAutomationId);
    const editButton = card?.querySelector<HTMLButtonElement>('[data-testid="scheduled-automation-edit"]') ?? null;
    if (!editButton || editButton.disabled) return false;
    editButton?.click();
    return Boolean(editButton);
  }, automationId);

  expect(clicked).toBe(true);
}

async function waitForScheduledAutomationsPage(): Promise<void> {
  try {
    await $('[data-testid="scheduled-automations-page"]').waitForExist({ timeout: 15_000 });
    await browser.execute(() => {
      const e2eWindow = window as typeof window & {
        __vesloE2eErrors?: string[];
        __vesloE2eErrorCaptureInstalled?: boolean;
      };
      if (e2eWindow.__vesloE2eErrorCaptureInstalled) return;
      e2eWindow.__vesloE2eErrorCaptureInstalled = true;
      e2eWindow.__vesloE2eErrors = [];
      window.addEventListener("error", (event) => {
        e2eWindow.__vesloE2eErrors?.push(event.message || String(event.error ?? "window error"));
      });
      window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason;
        e2eWindow.__vesloE2eErrors?.push(reason instanceof Error ? reason.message : String(reason));
      });
    });
  } catch (error) {
    const snapshot = await browser.execute(() => ({
      hash: window.location.hash,
      title: document.title,
      body: document.body.innerText.slice(0, 2000),
    })).catch((snapshotError) => ({
      hash: "unavailable",
      title: "unavailable",
      body: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
    }));
    throw new Error(
      `Scheduled automations page did not render. Snapshot=${JSON.stringify(snapshot)}`,
      { cause: error },
    );
  }
}

describe("Veslo automations desktop flow", () => {
  it("shows and edits automations from inactive workspaces on the global page", async () => {
    const secondaryWorkspace = await readSecondaryAutomationWorkspace();
    const activeWorkspace = await readActiveWorkspace();
    const activeDirectory = workspaceDirectory(activeWorkspace);
    const secondaryDirectory = workspaceDirectory(secondaryWorkspace);
    const runSuffix = Date.now();

    const connection = await ensureVesloServerConnection();
    const activeServerWorkspace = await waitForServerWorkspaceByDirectory(connection, activeDirectory);
    const secondaryServerWorkspace = await waitForServerWorkspaceByDirectory(connection, secondaryDirectory);
    expect(activeServerWorkspace.id).not.toBe(secondaryServerWorkspace.id);

    const activeAutomationName = `E2E active automation ${runSuffix}`;
    const inactiveAutomationName = `E2E inactive automation ${runSuffix}`;
    const editedInactiveAutomationName = `E2E inactive edited ${runSuffix}`;
    const futureRunAt = futureIso(30 * 60 * 1000);

    const activeAutomation = await createAutomation(connection, activeServerWorkspace.id, {
      id: `e2e_active_workspace_${runSuffix}`,
      name: activeAutomationName,
      runAt: futureRunAt,
      prompt: "This active workspace automation should appear on the global Automations page.",
    });
    const inactiveAutomation = await createAutomation(connection, secondaryServerWorkspace.id, {
      id: `e2e_inactive_workspace_${runSuffix}`,
      name: inactiveAutomationName,
      runAt: futureRunAt,
      prompt: "This inactive workspace automation should remain editable from the global Automations page.",
    });

    await navigateToHash("/dashboard/scheduled");
    await waitForHashRoute("#/dashboard/scheduled", 10_000);
    await waitForScheduledAutomationsPage();
    const refreshButton = await $('[data-testid="scheduled-automations-refresh"]');
    await refreshButton.waitForEnabled({ timeout: 10_000 });
    await refreshButton.click();

    const cards = await waitForAutomationCards([activeAutomationName, inactiveAutomationName]);
    expect(cards.find((card) => card.automationId === activeAutomation.id)?.workspaceId).toBe(activeServerWorkspace.id);
    expect(cards.find((card) => card.automationId === inactiveAutomation.id)?.workspaceId).toBe(secondaryServerWorkspace.id);

    await clickAutomationEdit(inactiveAutomation.id);
    await $('[data-testid="scheduled-automation-edit-modal"]').waitForExist({ timeout: 10_000 });
    const nameInput = await $('[data-testid="scheduled-automation-edit-name"]');
    await nameInput.setValue(editedInactiveAutomationName);
    await $('[data-testid="scheduled-automation-edit-save"]').click();

    await browser.waitUntil(
      async () => {
        const automations = await listAutomations(connection, secondaryServerWorkspace.id);
        return automations.some((automation) =>
          automation.id === inactiveAutomation.id &&
          automation.name === editedInactiveAutomationName
        );
      },
      {
        timeout: 20_000,
        interval: 500,
        timeoutMsg: "Inactive workspace automation edit was not persisted through the server API.",
      },
    );

    const updatedCards = await waitForAutomationCards([activeAutomationName, editedInactiveAutomationName]);
    expect(updatedCards.find((card) => card.automationId === inactiveAutomation.id)?.text)
      .toContain(editedInactiveAutomationName);
  });

  it("runs persisted one-shot automations and keeps future automations after server restart", async () => {
    const { workspace, connection } = await ensureActiveEngineReady();
    const workspaceId = workspace.id;
    const runSuffix = Date.now();

    const globalSync = await syncGlobalSkillMaterialization(connection);
    const managedSkillPath = personalGlobalManagedSkillPath();
    expect(globalSync.synced).toBe(true);
    expect(globalSync.materializedSkills.some((skill) =>
      skill.name === "veslo-automations" &&
      skill.target === "personal-global" &&
      skill.source === "platform" &&
      skill.removalPolicy === "locked"
    )).toBe(true);
    expect(existsSync(managedSkillPath)).toBe(true);
    expect(readFileSync(managedSkillPath, "utf8")).toContain("veslo_create_automation");

    const dueRunAt = futureIso(4_000);
    const dueAutomation = await createAutomation(connection, workspaceId, {
      id: `e2e_one_shot_due_${runSuffix}`,
      name: `E2E one-shot due ${runSuffix}`,
      runAt: dueRunAt,
      prompt: "Create a very short acknowledgement that this Veslo automation ran.",
    });
    expect(dueAutomation.nextRunAt).toBe(dueRunAt);

    const completed = await waitForCompletedAutomation(connection, workspaceId, dueAutomation.id);
    expect(completed.automation.status).toBe("completed");
    expect(completed.automation.lastRunId).toBe(completed.run.id);
    expect(completed.run.status).toBe("success");
    expect(trimText(completed.run.sessionId)).not.toBe("");

    const futureRunAt = futureIso(10 * 60 * 1000);
    const futureAutomation = await createAutomation(connection, workspaceId, {
      id: `e2e_one_shot_future_${runSuffix}`,
      name: `E2E one-shot future ${runSuffix}`,
      runAt: futureRunAt,
      prompt: "This future automation should survive a Veslo server restart.",
    });
    expect(futureAutomation.status).toBe("active");
    expect(futureAutomation.nextRunAt).toBe(futureRunAt);

    const restartedConnection = await restartVesloServerAndReconnect();
    await waitForServerWorkspaceOpenCodeUrl(restartedConnection, workspaceId);
    const automationsAfterRestart = await listAutomations(restartedConnection, workspaceId);
    const futureAfterRestart = automationsAfterRestart.find((automation) => automation.id === futureAutomation.id);

    expect(futureAfterRestart?.status).toBe("active");
    expect(futureAfterRestart?.nextRunAt).toBe(futureRunAt);
    expect(futureAfterRestart?.schedule).toEqual({ kind: "oneShot", runAt: futureRunAt });
  });
});
