import {
  assertLoopbackOrchestratorUrl,
  readOrchestratorBaseUrl,
  resolveOrchestratorWorkspace,
} from "./orchestrator-control.mjs";

const normalized = (value) => typeof value === "string" ? value.trim() : "";

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Event-stream gate control failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function pooledEngineForWorkspace(health, workspaceId) {
  if (health?.engineTopology !== "pooled-per-workspace") {
    throw new Error(`The workspace event-stream gate requires pooled-per-workspace topology, received ${health?.engineTopology ?? "missing"}.`);
  }
  const matches = (Array.isArray(health?.engines) ? health.engines : [])
    .filter((engine) => normalized(engine?.workspaceId) === workspaceId);
  if (matches.length !== 1) {
    throw new Error(`Expected one pooled engine for ${workspaceId}, found ${matches.length}.`);
  }
  return matches[0];
}

export async function resolveWorkspaceEventStreamGateTarget({ dataDir, workspaceIdentity }) {
  const baseUrl = await readOrchestratorBaseUrl(dataDir);
  const [health, workspaceList] = await Promise.all([
    fetchJson(`${baseUrl}/health`),
    fetchJson(`${baseUrl}/workspaces`),
  ]);
  const workspace = resolveOrchestratorWorkspace(workspaceList?.workspaces, workspaceIdentity);
  const engine = pooledEngineForWorkspace(health, workspace.id);
  return { baseUrl, workspace, engine };
}

export async function readWorkspaceEventStreamGateStatus({ baseUrl, workspaceId }) {
  const origin = assertLoopbackOrchestratorUrl(baseUrl);
  return fetchJson(`${origin}/e2e/workspace/${encodeURIComponent(workspaceId)}/event-stream-gate`);
}

export async function armWorkspaceEventStreamGate({ dataDir, workspaceIdentity }) {
  const target = await resolveWorkspaceEventStreamGateTarget({ dataDir, workspaceIdentity });
  const response = await fetchJson(
    `${target.baseUrl}/e2e/workspace/${encodeURIComponent(target.workspace.id)}/event-stream-gate/arm`,
    { method: "POST" },
  );
  return {
    baseUrl: target.baseUrl,
    workspaceId: target.workspace.id,
    engineBefore: target.engine,
    gate: response.gate,
  };
}

export async function releaseWorkspaceEventStreamGate({ baseUrl, workspaceId, gateId }) {
  const origin = assertLoopbackOrchestratorUrl(baseUrl);
  return fetchJson(
    `${origin}/e2e/workspace/${encodeURIComponent(workspaceId)}/event-stream-gate/release`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gateId }),
    },
  );
}

export async function readPooledWorkspaceEngine({ baseUrl, workspaceId }) {
  const origin = assertLoopbackOrchestratorUrl(baseUrl);
  const health = await fetchJson(`${origin}/health`);
  return pooledEngineForWorkspace(health, workspaceId);
}

export function sameEngineGeneration(left, right) {
  return Boolean(
    left &&
    right &&
    normalized(left.workspaceId) === normalized(right.workspaceId) &&
    normalized(left.engineOwnerId) === normalized(right.engineOwnerId) &&
    left.directoryInstanceEpoch === right.directoryInstanceEpoch &&
    left.pid === right.pid &&
    left.spawnedAt === right.spawnedAt,
  );
}
