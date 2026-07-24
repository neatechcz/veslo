import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..", "..");
const runtime = process.env.VESLO_ORCHESTRATOR_TEST_RUNTIME?.trim() || "bun";
const orchestratorCli = join(repoRoot, "packages", "orchestrator", "dist", "cli.js");
const opencodeBinary = process.env.VESLO_OPENCODE_BINARY?.trim() || join(
  repoRoot,
  "packages",
  "desktop",
  "src-tauri",
  "sidecars",
  process.platform === "win32" ? "opencode.exe" : "opencode",
);
const artifactDir = resolve(
  process.env.VESLO_OPENCODE_DIRECTORY_RUNTIME_ARTIFACT_DIR?.trim() ||
    join(repoRoot, ".tmp", "runtime-oracle", `directory-scoped-runtime-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`),
);

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createTcpServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("unable to allocate port"));
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitFor(check, label, timeoutMs = 45_000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${label} timed out: ${lastError instanceof Error ? lastError.message : String(lastError ?? "no matching result")}`);
}

async function requestJson(baseUrl, pathname, input = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: input.method ?? "GET",
    headers: {
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      ...(input.headers ?? {}),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: input.signal ?? AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function openEventStream(url) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200, `event stream failed: ${url}`);
  assert.ok(response.body, `event stream missing body: ${url}`);
  const events = [];
  const done = (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, "");
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try { events.push(JSON.parse(payload)); } catch { /* non-JSON upstream event */ }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  return {
    events,
    async close() {
      controller.abort();
      await done.catch(() => undefined);
    },
  };
}

const skillMarkdown = (name, marker) => `---\nname: ${name}\ndescription: ${marker}\n---\n\n${marker}\n`;

async function publishManifest(workspace, marker, revision) {
  const source = join(workspace, ".opencode", "skills", "same-name", "SKILL.md");
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, skillMarkdown("same-name", marker), "utf8");
  await writeFile(
    join(workspace, ".opencode", "veslo.runtime.skills.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      workspaceRoot: workspace,
      revision,
      entries: [{ name: "same-name", path: source, source: "workspace-local" }],
    }, null, 2)}\n`,
    "utf8",
  );
}

async function prepareWorkspace(workspace, marker, revision) {
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "opencode.jsonc"), `${JSON.stringify({ "$schema": "https://opencode.ai/config.json" }, null, 2)}\n`, "utf8");
  await publishManifest(workspace, marker, revision);
}

function findSkill(items, name) {
  return Array.isArray(items) ? items.find((item) => item?.name === name) ?? null : null;
}

function engineForWorkspace(health, workspaceId) {
  const engines = health?.engines;
  return Array.isArray(engines) ? engines.find((engine) => engine?.workspaceId === workspaceId) ?? null : null;
}

function eventSessionId(event) {
  const properties = event?.properties;
  if (!properties || typeof properties !== "object") return null;
  const direct = typeof properties.sessionID === "string"
    ? properties.sessionID
    : typeof properties.sessionId === "string" ? properties.sessionId : null;
  if (direct) return direct;
  const info = properties.info;
  if (info && typeof info === "object") {
    if (typeof info.sessionID === "string") return info.sessionID;
    if (typeof info.id === "string") return info.id;
  }
  const part = properties.part;
  if (part && typeof part === "object" && typeof part.sessionID === "string") return part.sessionID;
  return null;
}

function eventForSession(events, sessionId) {
  return events.find((event) => eventSessionId(event) === sessionId) ?? null;
}

const root = await mkdtemp(join(tmpdir(), "veslo-directory-scoped-runtime-"));
const workspaceA = join(root, "workspace-a");
const workspaceB = join(root, "workspace-b");
const dataDir = join(root, "orchestrator-data");
const daemonPort = await freePort();
const daemonUrl = `http://127.0.0.1:${daemonPort}`;
const lifecycleToken = "directory-scoped-runtime-token";
const logs = { orchestrator: "" };
let daemon = null;

const result = {
  schema: "veslo-opencode-directory-scoped-runtime/v1",
  ok: false,
  topology: "shared-directory-scoped",
  engine: null,
  skills: null,
  activeReload: null,
  eventRouting: null,
  placement: null,
  errors: [],
};

try {
  assert.ok(existsSync(orchestratorCli), `missing compiled orchestrator: ${orchestratorCli}`);
  assert.ok(existsSync(opencodeBinary), `missing bundled OpenCode: ${opencodeBinary}`);
  await mkdir(artifactDir, { recursive: true });
  await prepareWorkspace(workspaceA, "runtime-marker-A", "a1");
  await prepareWorkspace(workspaceB, "runtime-marker-B", "b1");

  daemon = spawn(runtime, [
    orchestratorCli,
    "daemon", "run",
    "--data-dir", dataDir,
    "--daemon-host", "127.0.0.1",
    "--daemon-port", String(daemonPort),
    "--opencode-host", "127.0.0.1",
    "--opencode-bin", opencodeBinary,
    "--allow-external",
    "--lifecycle-token", lifecycleToken,
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      VESLO_DISABLE_SANDBOX: "1",
      VESLO_SHARED_OPENCODE_ENGINE: "1",
      VESLO_SHARED_OPENCODE_DIRECTORY_SCOPED: "1",
      VESLO_DATA_DIR: dataDir,
      OPENCODE_CONFIG_CONTENT: "{}",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  daemon.stdout.setEncoding("utf8");
  daemon.stderr.setEncoding("utf8");
  daemon.stdout.on("data", (chunk) => { logs.orchestrator += chunk; });
  daemon.stderr.on("data", (chunk) => { logs.orchestrator += chunk; });
  await waitFor(async () => (await requestJson(daemonUrl, "/health")).body?.ok === true, "orchestrator health");

  for (const [id, path] of [["workspace-a", workspaceA], ["workspace-b", workspaceB]]) {
    const registered = await requestJson(daemonUrl, "/workspaces", {
      method: "POST",
      body: { path, serverWorkspaceId: id, appWorkspaceId: id },
    });
    assert.equal(registered.response.status, 200, JSON.stringify(registered.body));
  }

  const proxy = (workspaceId, path) => `/workspace/${encodeURIComponent(workspaceId)}/opencode${path}`;
  const sessionA = await requestJson(daemonUrl, proxy("workspace-a", "/session"), { method: "POST", body: { title: "A" } });
  const sessionB = await requestJson(daemonUrl, proxy("workspace-b", "/session"), { method: "POST", body: { title: "B" } });
  assert.equal(sessionA.response.status, 200, JSON.stringify(sessionA.body));
  assert.equal(sessionB.response.status, 200, JSON.stringify(sessionB.body));
  assert.equal(typeof sessionA.body?.id, "string");
  assert.equal(typeof sessionB.body?.id, "string");

  const initialHealth = await requestJson(daemonUrl, "/health");
  assert.equal(initialHealth.body?.engineTopology, "shared-directory-scoped");
  const initialEngine = initialHealth.body?.sharedEngine;
  assert.ok(initialEngine?.pid, JSON.stringify(initialHealth.body));
  assert.equal(typeof initialEngine?.engineOwnerId, "string", JSON.stringify(initialHealth.body));
  const skillsA = await requestJson(daemonUrl, proxy("workspace-a", "/skill"));
  const skillsB = await requestJson(daemonUrl, proxy("workspace-b", "/skill"));
  assert.equal(findSkill(skillsA.body, "same-name")?.description, "runtime-marker-A");
  assert.equal(findSkill(skillsB.body, "same-name")?.description, "runtime-marker-B");

  const [eventsA, eventsB] = await Promise.all([
    openEventStream(`${daemonUrl}${proxy("workspace-a", "/event")}`),
    openEventStream(`${daemonUrl}${proxy("workspace-b", "/event")}`),
  ]);
  try {
    const [eventSessionA, eventSessionB] = await Promise.all([
      requestJson(daemonUrl, proxy("workspace-a", "/session"), { method: "POST", body: { title: "stream A" } }),
      requestJson(daemonUrl, proxy("workspace-b", "/session"), { method: "POST", body: { title: "stream B" } }),
    ]);
    assert.equal(eventSessionA.response.status, 200, JSON.stringify(eventSessionA.body));
    assert.equal(eventSessionB.response.status, 200, JSON.stringify(eventSessionB.body));
    await waitFor(
      () => eventForSession(eventsA.events, eventSessionA.body?.id) && eventForSession(eventsB.events, eventSessionB.body?.id),
      "workspace-scoped session events",
    );
    assert.equal(eventForSession(eventsA.events, eventSessionB.body?.id), null, "A event stream must not receive B session events");
    assert.equal(eventForSession(eventsB.events, eventSessionA.body?.id), null, "B event stream must not receive A session events");
    const ownA = eventForSession(eventsA.events, eventSessionA.body?.id);
    const ownB = eventForSession(eventsB.events, eventSessionB.body?.id);
    assert.equal(ownA?.properties?.vesloBinding?.workspaceId, "workspace-a");
    assert.equal(ownB?.properties?.vesloBinding?.workspaceId, "workspace-b");
    result.eventRouting = {
      aSessionId: eventSessionA.body.id,
      bSessionId: eventSessionB.body.id,
      aSawOwnEvent: true,
      bSawOwnEvent: true,
      aSawBEvent: false,
      bSawAEvent: false,
      aBindingWorkspaceId: ownA.properties.vesloBinding.workspaceId,
      bBindingWorkspaceId: ownB.properties.vesloBinding.workspaceId,
    };
  } finally {
    await Promise.all([eventsA.close(), eventsB.close()]);
  }

  const register = await requestJson(daemonUrl, "/workspace/workspace-a/runs/register", {
    method: "POST",
    headers: { "X-Veslo-Orchestrator-Token": lifecycleToken },
    body: {
      conversationId: "conversation-a",
      runId: "run-a",
      opencodeSessionId: sessionA.body.id,
      directory: workspaceA,
      kind: "prompt",
    },
  });
  assert.equal(register.response.status, 200, JSON.stringify(register.body));
  await publishManifest(workspaceA, "runtime-marker-A2", "a2");
  const deferred = await requestJson(daemonUrl, proxy("workspace-a", "/skill"));
  assert.equal(deferred.response.status, 409, JSON.stringify(deferred.body));
  assert.equal(deferred.body?.error, "directory_skill_view_refresh_deferred");
  const bDuringADefer = await requestJson(daemonUrl, proxy("workspace-b", "/skill"));
  assert.equal(findSkill(bDuringADefer.body, "same-name")?.description, "runtime-marker-B");

  const abort = await requestJson(daemonUrl, proxy("workspace-a", `/session/${encodeURIComponent(sessionA.body.id)}/abort`), { method: "POST" });
  assert.ok([200, 204].includes(abort.response.status), JSON.stringify(abort.body));
  const terminal = await requestJson(daemonUrl, "/workspace/workspace-a/runs/run-a/aborted", {
    method: "POST",
    headers: { "X-Veslo-Orchestrator-Token": lifecycleToken },
    body: {},
  });
  assert.equal(terminal.response.status, 200, JSON.stringify(terminal.body));
  const lifecycleAfterTerminal = await waitFor(async () => {
    const health = await requestJson(daemonUrl, "/health");
    const instance = health.body?.directoryInstances?.find((item) => item?.directoryInstanceKey === workspaceA);
    return instance?.state === "ready" && instance?.directoryInstanceEpoch === 1 && instance?.skillViewRevision === "a2"
      ? health
      : null;
  }, "automatic A directory-scoped refresh after terminal run");
  const refreshedA = await waitFor(async () => {
    const response = await requestJson(daemonUrl, proxy("workspace-a", "/skill"));
    return response.response.ok ? response : null;
  }, "A directory-scoped refresh");
  assert.equal(findSkill(refreshedA.body, "same-name")?.description, "runtime-marker-A2");
  const finalHealth = lifecycleAfterTerminal;
  assert.equal(finalHealth.body?.sharedEngine?.pid, initialEngine.pid, "A disposal must not restart the shared process");
  assert.equal(engineForWorkspace(finalHealth.body, "workspace-a"), null);
  assert.equal(engineForWorkspace(finalHealth.body, "workspace-b"), null);
  const instances = finalHealth.body?.directoryInstances;
  const instanceA = Array.isArray(instances) ? instances.find((item) => item?.directoryInstanceKey === workspaceA) : null;
  const instanceB = Array.isArray(instances) ? instances.find((item) => item?.directoryInstanceKey === workspaceB) : null;
  assert.deepEqual(
    { epoch: instanceA?.directoryInstanceEpoch, revision: instanceA?.skillViewRevision },
    { epoch: 1, revision: "a2" },
  );
  assert.deepEqual(
    { epoch: instanceB?.directoryInstanceEpoch, revision: instanceB?.skillViewRevision },
    { epoch: 0, revision: "b1" },
  );

  // Placement is decided when the workspace is first admitted.  A later
  // project-config edit must not move an existing session from this shared
  // process into a pooled one.
  await writeFile(
    join(workspaceA, "opencode.jsonc"),
    `${JSON.stringify({ mcp: {} }, null, 2)}\n`,
    "utf8",
  );
  const afterConfigEdit = await requestJson(daemonUrl, proxy("workspace-a", "/skill"));
  assert.equal(findSkill(afterConfigEdit.body, "same-name")?.description, "runtime-marker-A2");
  const healthAfterConfigEdit = await requestJson(daemonUrl, "/health");
  assert.equal(healthAfterConfigEdit.body?.sharedEngine?.pid, initialEngine.pid);
  assert.equal(engineForWorkspace(healthAfterConfigEdit.body, "workspace-a"), null);

  // A newly admitted workspace with the same process-level setting is not
  // compatible with the shared launch configuration.  It receives a pooled
  // process, rather than contaminating the shared one.
  const workspaceC = join(root, "workspace-c");
  await prepareWorkspace(workspaceC, "runtime-marker-C", "c1");
  await writeFile(
    join(workspaceC, "opencode.jsonc"),
    `${JSON.stringify({ mcp: {} }, null, 2)}\n`,
    "utf8",
  );
  const registeredC = await requestJson(daemonUrl, "/workspaces", {
    method: "POST",
    body: { path: workspaceC, serverWorkspaceId: "workspace-c", appWorkspaceId: "workspace-c" },
  });
  assert.equal(registeredC.response.status, 200, JSON.stringify(registeredC.body));
  const sessionC = await requestJson(daemonUrl, proxy("workspace-c", "/session"), {
    method: "POST",
    body: { title: "C" },
  });
  assert.equal(sessionC.response.status, 200, JSON.stringify(sessionC.body));
  const skillsC = await requestJson(daemonUrl, proxy("workspace-c", "/skill"));
  assert.equal(findSkill(skillsC.body, "same-name")?.description, "runtime-marker-C");
  const mixedPlacementHealth = await requestJson(daemonUrl, "/health");
  const pooledC = engineForWorkspace(mixedPlacementHealth.body, "workspace-c");
  assert.ok(pooledC?.pid, JSON.stringify(mixedPlacementHealth.body));
  assert.notEqual(pooledC.pid, initialEngine.pid, "incompatible workspace must not share the directory-scoped process");
  assert.equal(mixedPlacementHealth.body?.sharedEngine?.pid, initialEngine.pid);

  result.ok = true;
  result.engine = {
    pid: initialEngine.pid,
    engineOwnerId: initialEngine.engineOwnerId,
    processCount: 1,
  };
  result.skills = { a: "runtime-marker-A2", b: "runtime-marker-B" };
  result.activeReload = {
    deferredStatus: deferred.response.status,
    deferredError: deferred.body?.error ?? null,
    pidStableAfterDisposal: finalHealth.body?.sharedEngine?.pid === initialEngine.pid,
    directoryInstances: instances,
  };
  result.placement = {
    pinnedAfterConfigEdit: engineForWorkspace(healthAfterConfigEdit.body, "workspace-a") === null,
    sharedPid: initialEngine.pid,
    incompatibleWorkspacePooledPid: pooledC.pid,
    incompatibleWorkspaceShared: pooledC.pid === initialEngine.pid,
  };
} catch (error) {
  result.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await stop(daemon);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "result.json"), `${JSON.stringify({ ...result, logs }, null, 2)}\n`, "utf8");
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ ...result, artifactDir }, null, 2));
if (!result.ok) process.exitCode = 1;
