import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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
  process.env.VESLO_OPENCODE_DIRECTORY_SCALING_ARTIFACT_DIR?.trim() ||
    join(repoRoot, ".tmp", "runtime-oracle", `directory-scoped-scaling-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`),
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

function exec(command, args) {
  return new Promise((resolveResult, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolveResult(stdout);
    });
  });
}

async function processMetrics(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { available: false, reason: "invalid-pid" };
  try {
    if (process.platform === "win32") {
      const stdout = await exec("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-Process -Id ${pid} | Select-Object Id,WorkingSet64,PrivateMemorySize64,CPU | ConvertTo-Json -Compress`,
      ]);
      const value = JSON.parse(String(stdout).trim());
      return {
        available: true,
        pid: value.Id,
        workingSetBytes: value.WorkingSet64,
        privateMemoryBytes: value.PrivateMemorySize64,
        cpuSeconds: value.CPU,
      };
    }
    const stdout = await exec("ps", ["-o", "pid=,rss=,pcpu=", "-p", String(pid)]);
    const [actualPid, rssKb, cpuPercent] = String(stdout).trim().split(/\s+/);
    return {
      available: true,
      pid: Number(actualPid),
      rssBytes: Number(rssKb) * 1024,
      cpuPercent: Number(cpuPercent),
    };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

const skillMarkdown = (marker) => `---\nname: same-name\ndescription: ${marker}\n---\n\n${marker}\n`;

async function publishManifest(workspace, marker, revision) {
  const source = join(workspace, ".opencode", "skills", "same-name", "SKILL.md");
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, skillMarkdown(marker), "utf8");
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

async function prepareWorkspace(workspace, ordinal) {
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, "opencode.jsonc"),
    `${JSON.stringify({ "$schema": "https://opencode.ai/config.json" }, null, 2)}\n`,
    "utf8",
  );
  await publishManifest(workspace, `scale-marker-${ordinal}`, `scale-${ordinal}-v1`);
}

function skillMarker(items) {
  return Array.isArray(items)
    ? items.find((item) => item?.name === "same-name")?.description ?? null
    : null;
}

const root = await mkdtemp(join(tmpdir(), "veslo-directory-scoped-scaling-"));
const dataDir = join(root, "orchestrator-data");
const daemonPort = await freePort();
const daemonUrl = `http://127.0.0.1:${daemonPort}`;
const lifecycleToken = "directory-scoped-scaling-token";
const logs = { orchestrator: "" };
let daemon = null;

const result = {
  schema: "veslo-opencode-directory-scoped-scaling/v1",
  ok: false,
  topology: "shared-directory-scoped",
  stages: [],
  refreshDuringOtherWorkspaceRun: null,
  errors: [],
};

try {
  assert.ok(existsSync(orchestratorCli), `missing compiled orchestrator: ${orchestratorCli}`);
  assert.ok(existsSync(opencodeBinary), `missing bundled OpenCode: ${opencodeBinary}`);
  await mkdir(artifactDir, { recursive: true });

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

  const workspaces = [];
  const proxy = (workspaceId, path) => `/workspace/${encodeURIComponent(workspaceId)}/opencode${path}`;
  let expectedSharedPid = null;

  for (const targetCount of [2, 5, 10]) {
    const stageStartedAt = Date.now();
    while (workspaces.length < targetCount) {
      const ordinal = workspaces.length + 1;
      const id = `workspace-${ordinal}`;
      const path = join(root, id);
      await prepareWorkspace(path, ordinal);
      const registered = await requestJson(daemonUrl, "/workspaces", {
        method: "POST",
        body: { path, serverWorkspaceId: id, appWorkspaceId: id },
      });
      assert.equal(registered.response.status, 200, JSON.stringify(registered.body));
      workspaces.push({ id, path, ordinal, sessionId: null });
    }

    await Promise.all(workspaces.map(async (workspace) => {
      if (!workspace.sessionId) {
        const session = await requestJson(daemonUrl, proxy(workspace.id, "/session"), {
          method: "POST",
          body: { title: `scale-${workspace.ordinal}` },
        });
        assert.equal(session.response.status, 200, JSON.stringify(session.body));
        assert.equal(typeof session.body?.id, "string");
        workspace.sessionId = session.body.id;
      }
      const skills = await requestJson(daemonUrl, proxy(workspace.id, "/skill"));
      assert.equal(skillMarker(skills.body), `scale-marker-${workspace.ordinal}`);
    }));

    const health = await requestJson(daemonUrl, "/health");
    const engine = health.body?.sharedEngine;
    assert.equal(health.body?.engineTopology, "shared-directory-scoped");
    assert.ok(engine?.pid, JSON.stringify(health.body));
    if (expectedSharedPid === null) expectedSharedPid = engine.pid;
    assert.equal(engine.pid, expectedSharedPid, "all workspace stages must use one shared OpenCode process");
    const instances = Array.isArray(health.body?.directoryInstances) ? health.body.directoryInstances : [];
    assert.equal(instances.length, targetCount, "each workspace needs one directory instance");
    assert.equal(Object.keys(health.body?.engines ?? {}).length, 0, "no pooled engine may be allocated");
    result.stages.push({
      workspaceCount: targetCount,
      startupAndHydrationMs: Date.now() - stageStartedAt,
      openCodeProcessCount: 1,
      sharedPid: engine.pid,
      directoryInstanceCount: instances.length,
      memory: await processMetrics(engine.pid),
    });
  }

  const workspaceA = workspaces[0];
  const workspaceB = workspaces[1];
  const beforeRefresh = await requestJson(daemonUrl, "/health");
  const activeB = await requestJson(daemonUrl, `/workspace/${workspaceB.id}/runs/register`, {
    method: "POST",
    headers: { "X-Veslo-Orchestrator-Token": lifecycleToken },
    body: {
      conversationId: "scale-conversation-b",
      runId: "scale-run-b",
      opencodeSessionId: workspaceB.sessionId,
      directory: workspaceB.path,
      kind: "prompt",
    },
  });
  assert.equal(activeB.response.status, 200, JSON.stringify(activeB.body));
  await publishManifest(workspaceA.path, "scale-marker-1-v2", "scale-1-v2");
  const refreshedA = await requestJson(daemonUrl, proxy(workspaceA.id, "/skill"));
  assert.equal(skillMarker(refreshedA.body), "scale-marker-1-v2");
  const afterRefresh = await requestJson(daemonUrl, "/health");
  const instances = Array.isArray(afterRefresh.body?.directoryInstances) ? afterRefresh.body.directoryInstances : [];
  const instanceA = instances.find((item) => item?.directoryInstanceKey === workspaceA.path);
  const instanceB = instances.find((item) => item?.directoryInstanceKey === workspaceB.path);
  assert.equal(afterRefresh.body?.sharedEngine?.pid, beforeRefresh.body?.sharedEngine?.pid);
  assert.equal(instanceA?.directoryInstanceEpoch, 1);
  assert.equal(instanceA?.skillViewRevision, "scale-1-v2");
  assert.equal(instanceB?.directoryInstanceEpoch, 0);
  assert.equal(instanceB?.skillViewRevision, "scale-2-v1");

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  const idleHealth = await requestJson(daemonUrl, "/health");
  assert.equal(idleHealth.body?.sharedEngine?.pid, expectedSharedPid, "idle shared engine remains resident");
  result.refreshDuringOtherWorkspaceRun = {
    activeWorkspace: workspaceB.id,
    refreshedWorkspace: workspaceA.id,
    pidStable: afterRefresh.body?.sharedEngine?.pid === beforeRefresh.body?.sharedEngine?.pid,
    refreshedEpoch: instanceA?.directoryInstanceEpoch ?? null,
    unaffectedEpoch: instanceB?.directoryInstanceEpoch ?? null,
    idleResident: idleHealth.body?.sharedEngine?.pid === expectedSharedPid,
    idleMemory: await processMetrics(expectedSharedPid),
  };
  result.ok = true;
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
