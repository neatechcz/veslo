import { expect } from "@wdio/globals";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

const isolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
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

describe("Veslo automations desktop flow", () => {
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
