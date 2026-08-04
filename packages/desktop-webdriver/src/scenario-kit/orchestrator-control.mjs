import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
const normalized = (value) => typeof value === "string" ? value.trim() : "";

export function assertLoopbackOrchestratorUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/") {
    throw new Error("The orchestrator control boundary must be an explicit loopback HTTP origin.");
  }
  return url.origin;
}

export function resolveOrchestratorWorkspace(workspaces, identity) {
  const target = normalized(identity);
  const matches = (Array.isArray(workspaces) ? workspaces : []).filter((workspace) => [
    workspace?.id,
    workspace?.name,
    workspace?.serverWorkspaceId,
    workspace?.appWorkspaceId,
    workspace?.derivedLocalWorkspaceId,
    ...(Array.isArray(workspace?.legacyWorkspaceIds) ? workspace.legacyWorkspaceIds : []),
  ].some((candidate) => normalized(candidate) === target));
  if (matches.length !== 1) {
    throw new Error(`Expected one orchestrator workspace for ${target}, found ${matches.length}.`);
  }
  return matches[0];
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Orchestrator control request failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw new Error(`Direct process inspection was inconclusive for PID ${pid}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readOrchestratorBaseUrl(dataDir) {
  const statePath = resolve(dataDir, "veslo-orchestrator-state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  return assertLoopbackOrchestratorUrl(state?.daemon?.baseUrl);
}

export async function disposeDirectWorkspaceEngine({ dataDir, workspaceIdentity, timeoutMs = 20_000 }) {
  const baseUrl = await readOrchestratorBaseUrl(dataDir);
  const beforeHealth = await fetchJson(`${baseUrl}/health`);
  if (beforeHealth?.engineTopology === "shared-unsandboxed") {
    throw new Error("The idle-suspend regression requires a pooled direct engine, not shared-engine topology.");
  }
  const workspaceList = await fetchJson(`${baseUrl}/workspaces`);
  const workspace = resolveOrchestratorWorkspace(workspaceList?.workspaces, workspaceIdentity);
  const beforeMatches = (beforeHealth?.engines ?? []).filter((engine) => engine?.workspaceId === workspace.id);
  if (beforeMatches.length !== 1) {
    throw new Error(`Expected one running pooled engine for ${workspace.id}, found ${beforeMatches.length}.`);
  }
  const before = beforeMatches[0];
  if (before.childKind !== "direct") {
    throw new Error(`Idle-suspend regression requires childKind direct, received ${before.childKind ?? "missing"}.`);
  }
  if (before.state !== "ready" && before.state !== "idle") {
    throw new Error(`The direct pooled engine is not running before dispose: ${before.state ?? "missing"}.`);
  }
  if (!processIsAlive(before.pid)) {
    throw new Error(`The direct pooled engine PID ${before.pid ?? "missing"} was not alive before dispose.`);
  }

  await fetchJson(`${baseUrl}/instances/${encodeURIComponent(workspace.id)}/dispose`, { method: "POST" });
  const deadline = Date.now() + timeoutMs;
  let after = null;
  while (Date.now() < deadline) {
    const health = await fetchJson(`${baseUrl}/health`);
    after = (health?.engines ?? []).find((engine) => engine?.workspaceId === workspace.id) ?? null;
    if (
      after?.engineOwnerId === before.engineOwnerId &&
      after?.childKind === "direct" &&
      after?.state === "suspended" &&
      !processIsAlive(before.pid)
    ) {
      return {
        workspaceId: workspace.id,
        childKind: "direct",
        engineOwnerId: before.engineOwnerId,
        pid: before.pid,
        beforeState: before.state,
        afterState: after.state,
        childExitObserved: true,
      };
    }
    await pause(100);
  }
  const evidence = after ? {
    childKind: after.childKind ?? null,
    engineOwnerId: after.engineOwnerId ?? null,
    pid: after.pid ?? null,
    state: after.state ?? null,
    originalChildAlive: processIsAlive(before.pid),
  } : null;
  throw new Error(`Direct engine dispose did not prove a suspended snapshot and observed child exit: ${JSON.stringify(evidence)}`);
}
