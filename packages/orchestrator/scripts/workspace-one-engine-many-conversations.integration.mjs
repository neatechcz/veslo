import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..", "..");
const orchestratorCli = join(repoRoot, "packages", "orchestrator", "dist", "cli.js");
const serverBinary = join(
  repoRoot,
  "packages",
  "server",
  "dist",
  "bin",
  process.platform === "win32" ? "veslo-server.exe" : "veslo-server",
);
const runtime = process.env.VESLO_ORCHESTRATOR_TEST_RUNTIME?.trim() || "bun";
const artifactDir = resolve(
  process.env.VESLO_RUNTIME_ORACLE_ARTIFACT_DIR?.trim() ||
    join(repoRoot, ".tmp", "runtime-oracle", new Date().toISOString().replaceAll(/[:.]/g, "-")),
);
const root = join(artifactDir, "runtime");
const logs = { orchestrator: "", server: "", fakeOpencode: "" };
const children = [];

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("unable to allocate port"));
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

function tail(value, max = 5_000) {
  return value.length > max ? value.slice(-max) : value;
}

function track(child, key) {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { logs[key] += chunk; });
  child.stderr?.on("data", (chunk) => { logs[key] += chunk; });
  children.push(child);
  return child;
}

async function waitFor(check, label, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error(`${label} timed out: ${lastError instanceof Error ? lastError.message : String(lastError ?? "no result")}`);
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} -> ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

await mkdir(root, { recursive: true });
await mkdir(artifactDir, { recursive: true });
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
const fakeOpencode = join(root, "fake-opencode.js");
await writeFile(fakeOpencode, `
const http = require("node:http");
const portIndex = process.argv.indexOf("--port");
const port = Number(process.argv[portIndex + 1]);
const sessions = new Set();
const readBody = async (request) => { let raw = ""; for await (const chunk of request) raw += chunk; return raw ? JSON.parse(raw) : {}; };
const json = (response, status, payload) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); };
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/global/health" || url.pathname === "/health") return json(response, 200, { healthy: true, version: "1.17.13", provider: "deterministic-runtime-oracle" });
  if (url.pathname === "/project" || url.pathname === "/config" || url.pathname === "/provider" || url.pathname === "/mcp") return json(response, 200, { ok: true, provider: "deterministic-runtime-oracle" });
  if (request.method === "POST" && url.pathname === "/session") {
    const body = await readBody(request);
    const id = typeof body.id === "string" && body.id ? body.id : \`oracle-session-\${sessions.size + 1}\`;
    sessions.add(id);
    return json(response, 200, { id, info: { id }, parts: [], provider: "deterministic-runtime-oracle" });
  }
  if (url.pathname.startsWith("/session/")) {
    if (request.method === "POST") return json(response, 200, { ok: true, provider: "deterministic-runtime-oracle" });
    return json(response, 200, { id: url.pathname.split("/")[2], info: { id: url.pathname.split("/")[2] }, parts: [] });
  }
  if (url.pathname === "/event") {
    response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
    return;
  }
  return json(response, 404, { error: "not found" });
});
server.listen(port, "127.0.0.1");
`.trimStart(), "utf8");

const daemonPort = await freePort();
const serverPort = await freePort();
const daemonUrl = `http://127.0.0.1:${daemonPort}`;
const serverUrl = `http://127.0.0.1:${serverPort}`;
const token = `oracle-lifecycle-${Date.now()}`;
const clientToken = "oracle-client-token";
let workspaceId = "oracle-workspace";
const commonEnv = {
  ...process.env,
  VESLO_DATA_DIR: join(root, "data"),
  VESLO_ORCHESTRATOR_LIFECYCLE_TOKEN: token,
  VESLO_ENGINE_LOSS_CALLBACK_URL: serverUrl,
  VESLO_SERVER_URL: serverUrl,
  VESLO_E2E_FAULT_INJECTION: "1",
  VESLO_DISABLE_SANDBOX: "0",
  VESLO_SHARED_OPENCODE_ENGINE: "0",
  VESLO_OPENCODE_HEALTH_TIMEOUT_MS: "5_000",
};

const result = {
  schema: "veslo-runtime-oracle/v1",
  ok: false,
  generatedAt: new Date().toISOString(),
  topology: null,
  workspaceId,
  conversationIds: [],
  opencodeSessionIds: [],
  runIds: [],
  engineSlotId: null,
  engineGenerations: [],
  conversations: [],
  engineOwnerIdsBeforeLoss: [],
  engineOwnerIdAfterLoss: null,
  abortIsolation: null,
  generationLoss: null,
  eventRouting: { verifiedBy: "app-session-event-stream-focused-tests" },
  skillRevision: null,
  errors: [],
  compiledServer: serverBinary,
  compiledServerSha256: null,
  compiledServerVerified: false,
  deterministicProvider: "deterministic-runtime-oracle",
};

try {
  const daemon = track(spawn(runtime, [orchestratorCli, "daemon", "run", "--data-dir", commonEnv.VESLO_DATA_DIR, "--daemon-host", "127.0.0.1", "--daemon-port", String(daemonPort), "--max-engines", "1", "--opencode-host", "127.0.0.1", "--opencode-bin", fakeOpencode, "--allow-external", "--lifecycle-token", token], { cwd: repoRoot, env: commonEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }), "orchestrator");
  await waitFor(async () => (await requestJson(`${daemonUrl}/health`)).ok === true, "orchestrator health");

  const server = track(spawn(serverBinary, ["--host", "127.0.0.1", "--port", String(serverPort), "--token", clientToken, "--host-token", "oracle-host-token", "--workspace", workspace, "--orchestrator-url", daemonUrl, "--orchestrator-lifecycle-token", token], { cwd: workspace, env: commonEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }), "server");
  const serverDigest = createHash("sha256").update(await readFile(serverBinary)).digest("hex");
  const serverHealth = await waitFor(async () => {
    const health = await requestJson(`${serverUrl}/health`);
    return health.ok === true ? health : null;
  }, "compiled server health");
  assert.equal(typeof serverHealth.version, "string");
  result.compiledServerSha256 = serverDigest;
  result.compiledServerVerified = true;
  const workspaces = await requestJson(`${serverUrl}/workspaces`, { headers: authHeaders(clientToken) });
  workspaceId = workspaces.items?.[0]?.id;
  assert.ok(workspaceId, "server must expose one canonical workspace ID");
  result.workspaceId = workspaceId;
  await requestJson(`${daemonUrl}/workspaces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: workspace, serverWorkspaceId: workspaceId, appWorkspaceId: workspaceId }) });

  const conversations = Array.from({ length: 10 }, (_, index) => ({
    conversationId: `conversation-${index + 1}`,
    opencodeSessionId: `session-${index + 1}`,
    runId: `run-${index + 1}`,
  }));
  result.conversationIds = conversations.map((item) => item.conversationId);
  result.opencodeSessionIds = conversations.map((item) => item.opencodeSessionId);
  result.runIds = conversations.map((item) => item.runId);
  const lifecycleHeaders = { "Content-Type": "application/json", "X-Veslo-Orchestrator-Token": token };
  await Promise.all(conversations.map((item) => requestJson(`${daemonUrl}/workspace/${workspaceId}/runs/register`, { method: "POST", headers: lifecycleHeaders, body: JSON.stringify({ ...item, clientMessageId: `message-${item.runId}`, directory: workspace, kind: "prompt" }) })));
  await Promise.all(conversations.map((item) => requestJson(`${daemonUrl}/workspace/${workspaceId}/opencode/session`, { method: "POST", headers: { "Content-Type": "application/json", "x-veslo-conversation-run-id": item.runId }, body: JSON.stringify({ id: item.opencodeSessionId, directory: workspace }) })));

  const statusesBefore = await Promise.all(conversations.map((item) => requestJson(`${daemonUrl}/workspace/${workspaceId}/conversations/${item.conversationId}/runs/${item.runId}`, { headers: { "X-Veslo-Orchestrator-Token": token } })));
  result.topology = (await requestJson(`${daemonUrl}/health`)).engineTopology;
  assert.equal(result.topology, "pooled-per-workspace");
  const enginesBefore = (await requestJson(`${daemonUrl}/health`)).engines;
  assert.equal(enginesBefore.length, 1, "one workspace must have one engine slot");
  result.engineSlotId = enginesBefore[0].workspaceId;
  result.engineGenerations.push({ engineOwnerId: enginesBefore[0].engineOwnerId, pid: enginesBefore[0].pid, startedAt: enginesBefore[0].spawnedAt, baseUrl: enginesBefore[0].baseUrl });
  result.engineOwnerIdsBeforeLoss = statusesBefore.map((status) => status.engineOwnerId);
  assert.equal(new Set(result.engineOwnerIdsBeforeLoss).size, 1, "all ten runs must share one process generation");
  assert.ok(result.engineOwnerIdsBeforeLoss[0]);
  assert.ok(statusesBefore.every((status) => status.engineOwnerState === "attached"));
  assert.ok(statusesBefore.every((status) => status.status === "submitted" || status.status === "running"));
  result.conversations = statusesBefore.map((status, index) => ({
    conversationId: conversations[index].conversationId,
    opencodeSessionId: conversations[index].opencodeSessionId,
    clientMessageId: `message-${conversations[index].runId}`,
    runId: conversations[index].runId,
    reservedRunId: conversations[index].runId,
    status: status.status,
    engineOwnerId: status.engineOwnerId,
  }));

  await requestJson(`${daemonUrl}/workspace/${workspaceId}/runs/${conversations[0].runId}/aborted`, { method: "POST", headers: lifecycleHeaders, body: JSON.stringify({ error: "oracle abort" }) });
  const aborted = await requestJson(`${daemonUrl}/workspace/${workspaceId}/conversations/${conversations[0].conversationId}/runs/${conversations[0].runId}`, { headers: { "X-Veslo-Orchestrator-Token": token } });
  const unaffected = await requestJson(`${daemonUrl}/workspace/${workspaceId}/conversations/${conversations[1].conversationId}/runs/${conversations[1].runId}`, { headers: { "X-Veslo-Orchestrator-Token": token } });
  assert.equal(aborted.status, "aborted");
  assert.ok(unaffected.status === "submitted" || unaffected.status === "running");
  result.abortIsolation = { abortedRunId: aborted.runId, unaffectedRunId: unaffected.runId, unaffectedStatus: unaffected.status };
  result.conversations = result.conversations.map((conversation) =>
    conversation.runId === aborted.runId ? { ...conversation, status: aborted.status } : conversation,
  );

  await requestJson(`${daemonUrl}/e2e/workspace/${workspaceId}/kill-child`, { method: "POST" });
  const lostStatuses = await waitFor(async () => {
    const statuses = await Promise.all(conversations.slice(1).map((item) => requestJson(`${daemonUrl}/workspace/${workspaceId}/conversations/${item.conversationId}/runs/${item.runId}`, { headers: { "X-Veslo-Orchestrator-Token": token } })));
    return statuses.every((status) => status.status === "failed" && status.engineOwnerState === "lost") ? statuses : null;
  }, "generation loss reconciliation", 20_000);
  assert.ok(lostStatuses.every((status) => status.engineOwnerId === result.engineOwnerIdsBeforeLoss[1]));
  const restarted = await waitFor(async () => {
    const health = await requestJson(`${daemonUrl}/health`);
    const engine = health.engines?.[0];
    return engine?.state === "ready" && engine.engineOwnerId !== result.engineOwnerIdsBeforeLoss[0] ? engine : null;
  }, "engine generation restart", 20_000);
  result.engineOwnerIdAfterLoss = restarted.engineOwnerId;
  result.engineGenerations.push({ engineOwnerId: restarted.engineOwnerId, pid: restarted.pid, startedAt: restarted.spawnedAt, baseUrl: restarted.baseUrl });
  result.conversations = result.conversations.map((conversation) => {
    const lost = lostStatuses.find((status) => status.runId === conversation.runId);
    return lost ? { ...conversation, status: lost.status } : conversation;
  });
  result.generationLoss = { lostRunCount: lostStatuses.length, oldOwnerId: result.engineOwnerIdsBeforeLoss[0], newOwnerId: restarted.engineOwnerId, callbackSchema: "veslo-engine-loss/v1" };
  assert.notEqual(restarted.engineOwnerId, result.engineOwnerIdsBeforeLoss[0]);
  result.ok = true;
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  result.logs = { orchestrator: tail(logs.orchestrator), server: tail(logs.server), fakeOpencode: tail(logs.fakeOpencode) };
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) await stopChild(child);
  result.logs = { orchestrator: tail(logs.orchestrator), server: tail(logs.server), fakeOpencode: tail(logs.fakeOpencode) };
  await writeFile(join(artifactDir, "workspace-one-engine-many-conversations.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(join(artifactDir, "orchestrator.log"), logs.orchestrator, "utf8");
  await writeFile(join(artifactDir, "server.log"), logs.server, "utf8");
  await writeFile(join(artifactDir, "fake-opencode.log"), logs.fakeOpencode, "utf8");
}

console.log(JSON.stringify({ ...result, artifactDir }, null, 2));
