import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
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
const bundledOpenCode = process.env.VESLO_OPENCODE_BINARY?.trim() || join(
  repoRoot,
  "packages",
  "desktop",
  "src-tauri",
  "sidecars",
  process.platform === "win32" ? "opencode.exe" : "opencode",
);
const runtime = process.env.VESLO_ORCHESTRATOR_TEST_RUNTIME?.trim() || "bun";
const artifactDir = resolve(
  process.env.VESLO_SERVER_ORCHESTRATOR_OPENCODE_ARTIFACT_DIR?.trim() ||
    join(repoRoot, ".tmp", "runtime-oracle", `server-orchestrator-opencode-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`),
);
const root = await mkdtemp(join(tmpdir(), "veslo-server-orchestrator-opencode-"));
const workspace = join(root, "workspace");
const orchestratorDataDir = join(root, "orchestrator-data");
const serverDataDir = join(root, "server-data");
const xdgConfigHome = join(root, "xdg-config");
const xdgDataHome = join(root, "xdg-data");
const logs = { provider: "", orchestrator: "", server: "" };
const children = [];
const providerRequests = [];
let activeProviderRequests = 0;
let maxProviderConcurrency = 0;

function track(child, key) {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { logs[key] += chunk; });
  child.stderr?.on("data", (chunk) => { logs[key] += chunk; });
  children.push(child);
  return child;
}

function tail(value, max = 8_000) {
  return value.length > max ? value.slice(-max) : value;
}

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

async function requestJson(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(20_000),
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function lifecycleHeaders(token) {
  return { "X-Veslo-Orchestrator-Token": token, "content-type": "application/json" };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 2_500)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    if (typeof part.content === "string") return part.content;
    return "";
  }).join("");
}

function providerText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return contentText(messages.at(-1)?.content) || "oracle-empty";
}

const result = {
  schema: "veslo-server-orchestrator-opencode/v1",
  ok: false,
  generatedAt: new Date().toISOString(),
  components: {
    server: serverBinary,
    orchestrator: orchestratorCli,
    opencode: bundledOpenCode,
    ui: false,
    tauriPilot: false,
  },
  workspaceId: null,
  workspaceDirectory: workspace,
  engineSlotId: null,
  engineGenerations: [],
  conversations: [],
  queue: null,
  abortIsolation: null,
  generationLoss: null,
  httpContract: null,
  provider: null,
  compiledServerSha256: null,
  errors: [],
};

const clientToken = `runtime-client-${randomUUID()}`;
const lifecycleToken = `runtime-lifecycle-${randomUUID()}`;
const hostToken = `runtime-host-${randomUUID()}`;
const providerPort = await freePort();
const orchestratorPort = await freePort();
const serverPort = await freePort();
const providerUrl = `http://127.0.0.1:${providerPort}`;
const orchestratorUrl = `http://127.0.0.1:${orchestratorPort}`;
const serverUrl = `http://127.0.0.1:${serverPort}`;
const providerDelayMs = Number.parseInt(process.env.VESLO_RUNTIME_PROVIDER_DELAY_MS ?? "6000", 10);

await mkdir(workspace, { recursive: true });
await mkdir(artifactDir, { recursive: true });

const provider = createServer(async (request, response) => {
  if (request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "oracle", object: "model", owned_by: "veslo-runtime" }] }));
    return;
  }
  if (request.url !== "/v1/chat/completions") {
    response.writeHead(404);
    response.end();
    return;
  }
  activeProviderRequests += 1;
  maxProviderConcurrency = Math.max(maxProviderConcurrency, activeProviderRequests);
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const text = providerText(body);
    const requestId = providerRequests.length + 1;
    providerRequests.push({ requestId, text, at: Date.now() });
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    response.write(`data: ${JSON.stringify({
      id: `runtime-${requestId}`,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: `reply:${text}` }, finish_reason: null }],
    })}\n\n`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, providerDelayMs));
    response.write(`data: ${JSON.stringify({
      id: `runtime-${requestId}`,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`);
    response.end("data: [DONE]\n\n");
  } catch (error) {
    logs.provider += `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`;
    if (!response.headersSent) response.writeHead(500);
    response.end();
  } finally {
    activeProviderRequests -= 1;
  }
});
provider.on("error", (error) => { logs.provider += `${error.stack ?? error.message}\n`; });
await new Promise((resolveListen, reject) => provider.listen(providerPort, "127.0.0.1", (error) => error ? reject(error) : resolveListen()));

const commonEnv = {
  ...process.env,
  VESLO_DISABLE_SANDBOX: "1",
  VESLO_E2E_FAULT_INJECTION: "1",
  VESLO_ENGINE_LOSS_CALLBACK_URL: serverUrl,
  VESLO_ORCHESTRATOR_LIFECYCLE_TOKEN: lifecycleToken,
  VESLO_SHARED_OPENCODE_ENGINE: "0",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    model: "deterministic/oracle",
    provider: {
      deterministic: {
        npm: "@ai-sdk/openai-compatible",
        name: "Veslo runtime deterministic provider",
        options: { baseURL: `${providerUrl}/v1`, apiKey: "runtime-oracle" },
        models: { oracle: { name: "Veslo runtime deterministic model" } },
      },
    },
  }),
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  XDG_CONFIG_HOME: xdgConfigHome,
  XDG_DATA_HOME: xdgDataHome,
};

async function submitConversation(workspaceId, input) {
  const body = {
    clientMessageId: input.clientMessageId,
    origin: input.origin ?? "runtime:integration",
    source: "headless-runtime",
    target: input.conversationId
      ? { conversationId: input.conversationId, directory: workspace }
      : { directory: workspace, pendingClientSessionId: input.pendingClientSessionId },
    draft: {
      mode: "prompt",
      text: input.text,
      parts: [{ type: "text", text: input.text }],
    },
    options: {
      model: { providerID: "deterministic", modelID: "oracle" },
      ...(input.submitQueuePolicy ? { submitQueuePolicy: input.submitQueuePolicy } : {}),
    },
  };
  return await requestJson(
    serverUrl,
    `/workspace/${encodeURIComponent(workspaceId)}/conversations/submit`,
    { method: "POST", headers: authHeaders(clientToken), body: JSON.stringify(body) },
  );
}

async function runStatus(workspaceId, conversationId, runId) {
  return (await requestJson(
    serverUrl,
    `/workspace/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}`,
    { headers: authHeaders(clientToken) },
  )).body;
}

async function orchestratorActiveStatus(workspaceId, conversationId) {
  const result = await requestJson(
    orchestratorUrl,
    `/workspace/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}/runs/active`,
    { headers: lifecycleHeaders(lifecycleToken) },
  );
  return result.response.ok ? result.body : null;
}

async function orchestratorRunStatus(workspaceId, conversationId, runId) {
  const result = await requestJson(
    orchestratorUrl,
    `/workspace/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}`,
    { headers: lifecycleHeaders(lifecycleToken) },
  );
  return result.response.ok ? result.body : null;
}

async function queueStatus(workspaceId, conversationId, queueItemId) {
  return (await requestJson(
    serverUrl,
    `/workspace/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(queueItemId)}`,
    { headers: authHeaders(clientToken) },
  )).body;
}

try {
  assert.ok(existsSync(orchestratorCli), `missing compiled orchestrator: ${orchestratorCli}`);
  assert.ok(existsSync(serverBinary), `missing compiled server: ${serverBinary}`);
  assert.ok(existsSync(bundledOpenCode), `missing bundled OpenCode: ${bundledOpenCode}`);

  const orchestrator = track(spawn(runtime, [
    orchestratorCli,
    "daemon",
    "run",
    "--data-dir", orchestratorDataDir,
    "--daemon-host", "127.0.0.1",
    "--daemon-port", String(orchestratorPort),
    "--max-engines", "1",
    "--opencode-host", "127.0.0.1",
    "--opencode-bin", bundledOpenCode,
    "--allow-external",
    "--lifecycle-token", lifecycleToken,
  ], {
    cwd: repoRoot,
    env: { ...commonEnv, VESLO_DATA_DIR: orchestratorDataDir },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }), "orchestrator");
  await waitFor(async () => (await requestJson(orchestratorUrl, "/health")).body?.ok === true, "orchestrator health");

  const server = track(spawn(serverBinary, [
    "--host", "127.0.0.1",
    "--port", String(serverPort),
    "--token", clientToken,
    "--host-token", hostToken,
    "--workspace", workspace,
    "--orchestrator-url", orchestratorUrl,
    "--orchestrator-lifecycle-token", lifecycleToken,
  ], {
    cwd: workspace,
    env: { ...commonEnv, VESLO_DATA_DIR: serverDataDir, VESLO_SERVER_URL: serverUrl },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }), "server");
  result.compiledServerSha256 = createHash("sha256").update(await readFile(serverBinary)).digest("hex");
  await waitFor(async () => (await requestJson(serverUrl, "/health")).body?.ok === true, "server health");

  const unauthorizedLoss = await requestJson(serverUrl, "/internal/orchestrator/engine-loss", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Veslo-Orchestrator-Token": "wrong-token" },
    body: JSON.stringify({}),
  });
  assert.equal(unauthorizedLoss.response.status, 401);
  const malformedLoss = await requestJson(serverUrl, "/internal/orchestrator/engine-loss", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Veslo-Orchestrator-Token": lifecycleToken },
    body: JSON.stringify({ eventId: "malformed" }),
  });
  assert.equal(malformedLoss.response.status, 400);
  result.httpContract = { unauthorizedStatus: unauthorizedLoss.response.status, malformedStatus: malformedLoss.response.status };

  const workspaces = (await requestJson(serverUrl, "/workspaces", { headers: authHeaders(clientToken) })).body;
  const workspaceRecord = workspaces.workspaces?.[0] ?? workspaces.items?.[0];
  assert.ok(workspaceRecord?.id, "server must expose one workspace");
  result.workspaceId = workspaceRecord.id;
  await requestJson(orchestratorUrl, "/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: workspace, serverWorkspaceId: result.workspaceId, appWorkspaceId: result.workspaceId }),
  });

  const conversationRecords = await Promise.all(Array.from({ length: 10 }, (_, index) => requestJson(
    serverUrl,
    `/workspace/${encodeURIComponent(result.workspaceId)}/conversations`,
    {
      method: "POST",
      headers: authHeaders(clientToken),
      body: JSON.stringify({ directory: workspace, title: `Runtime conversation ${index + 1}` }),
    },
  )));
  assert.ok(conversationRecords.every((item) => item.response.status === 201), "server must create all real conversations");
  const conversations = conversationRecords.map((item, index) => ({
    index,
    conversationId: item.body.conversationId,
    opencodeSessionId: item.body.opencodeSessionId,
    text: `runtime-conversation-${index + 1}`,
    clientMessageId: `runtime-message-${index + 1}`,
  }));
  assert.equal(new Set(conversations.map((item) => item.conversationId)).size, 10);
  assert.equal(new Set(conversations.map((item) => item.opencodeSessionId)).size, 10);
  const firstSubmitPromises = conversations.map((conversation) => submitConversation(result.workspaceId, conversation));
  const activeStatuses = await waitFor(async () => {
    const statuses = await Promise.all(conversations.map((conversation) => orchestratorActiveStatus(result.workspaceId, conversation.conversationId)));
    return statuses.every((status) => status?.engineOwnerState === "attached") ? statuses : null;
  }, "all real server runs attached before upstream completion");
  const submitted = conversations.map((conversation, index) => ({
    ...conversations[index],
    payload: {
      status: "submitted",
      conversationId: conversation.conversationId,
      opencodeSessionId: conversation.opencodeSessionId,
      runId: activeStatuses[index].runId,
    },
  }));
  result.debugInitialSubmits = submitted.map((item) => item.payload);
  assert.equal(new Set(submitted.map((item) => item.payload.conversationId)).size, 10);
  assert.equal(new Set(submitted.map((item) => item.payload.opencodeSessionId)).size, 10);
  assert.equal(new Set(submitted.map((item) => item.payload.runId)).size, 10);
  const ownerIds = new Set(activeStatuses.map((status) => status.engineOwnerId));
  assert.equal(ownerIds.size, 1, "all ten server submissions must share one generation");
  assert.ok([...ownerIds][0]);
  result.engineSlotId = activeStatuses[0].engineSlotId;
  result.engineGenerations.push({
    engineSlotId: activeStatuses[0].engineSlotId,
    engineOwnerId: activeStatuses[0].engineOwnerId,
    enginePid: activeStatuses[0].enginePid,
    engineStartedAt: activeStatuses[0].engineStartedAt,
    engineBaseUrl: activeStatuses[0].engineBaseUrl,
  });
  await waitFor(() => providerRequests.length >= 10, "ten real provider requests");
  assert.equal(new Set(providerRequests.slice(0, 10).map((request) => request.text)).size, 10);
  assert.ok(maxProviderConcurrency > 1, `real provider requests did not overlap: ${maxProviderConcurrency}`);

  const queueSubmit = await submitConversation(result.workspaceId, {
    conversationId: submitted[0].payload.conversationId,
    clientMessageId: "runtime-message-queued-follow-up",
    text: "runtime-queued-follow-up",
    submitQueuePolicy: "send-now",
  });
  assert.equal(queueSubmit.response.status, 202, JSON.stringify(queueSubmit.body));
  assert.equal(queueSubmit.body.status, "queued");
  const queuedItem = {
    queueItemId: queueSubmit.body.queueItemId,
    reservedRunId: queueSubmit.body.reservedRunId,
    conversationId: submitted[0].payload.conversationId,
  };
  assert.ok(queuedItem.queueItemId && queuedItem.reservedRunId);
  assert.equal((await queueStatus(result.workspaceId, queuedItem.conversationId, queuedItem.queueItemId)).status, "pending");

  const abortResponse = await requestJson(
    serverUrl,
    `/workspace/${encodeURIComponent(result.workspaceId)}/conversations/${encodeURIComponent(submitted[0].payload.conversationId)}/abort`,
    {
      method: "POST",
      headers: authHeaders(clientToken),
      body: JSON.stringify({ directory: workspace, runId: submitted[0].payload.runId }),
    },
  );
  assert.equal(abortResponse.response.status, 200, JSON.stringify(abortResponse.body));
  await waitFor(async () => providerRequests.some((request) => request.text === "runtime-queued-follow-up"), "queued run reaches real OpenCode");
  const drainedQueue = await waitFor(async () => {
    const status = await queueStatus(result.workspaceId, queuedItem.conversationId, queuedItem.queueItemId);
    return status.status === "submitted" || status.status === "failed" ? status : null;
  }, "queued item transitions after abort");
  assert.equal(drainedQueue.status, "submitted");
  const abortedStatus = await waitFor(async () => {
    const status = await runStatus(result.workspaceId, submitted[0].payload.conversationId, submitted[0].payload.runId);
    return status.status === "aborted" ? status : null;
  }, "aborted run becomes terminal");
  result.queue = {
    queueItemId: queuedItem.queueItemId,
    reservedRunId: queuedItem.reservedRunId,
    queueState: drainedQueue.status,
    abortedRunId: abortedStatus.runId,
    queuedProviderRequestObserved: true,
  };
  result.abortIsolation = {
    abortedRunId: abortedStatus.runId,
    independentRunId: submitted[1].payload.runId,
    independentConversationId: submitted[1].payload.conversationId,
    independentStatus: (await runStatus(result.workspaceId, submitted[1].payload.conversationId, submitted[1].payload.runId)).status,
  };

  const lossTargets = submitted.slice(1, 4);
  const lossRuns = lossTargets.map((item) => item.payload);
  const oldOwnerId = activeStatuses[1].engineOwnerId;
  assert.ok(oldOwnerId);
  const oldEngine = (await requestJson(orchestratorUrl, "/health")).body.engines?.[0];
  assert.equal(oldEngine?.engineOwnerId, oldOwnerId);

  const killResponse = await requestJson(orchestratorUrl, `/e2e/workspace/${encodeURIComponent(result.workspaceId)}/kill-child`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  assert.equal(killResponse.response.status, 202, JSON.stringify(killResponse.body));
  const lostStatuses = await waitFor(async () => {
    const observations = await Promise.all(lossTargets.map(async (item, index) => ({
      server: await runStatus(result.workspaceId, item.payload.conversationId, lossRuns[index].runId),
      orchestrator: await orchestratorRunStatus(result.workspaceId, item.payload.conversationId, lossRuns[index].runId),
    })));
    result.debugLostStatuses = observations.map((observation) => ({
      serverStatus: observation.server.status,
      serverOwnerState: observation.server.engineOwnerState,
      orchestratorStatus: observation.orchestrator?.status,
      orchestratorOwnerState: observation.orchestrator?.engineOwnerState,
      orchestratorOwnerId: observation.orchestrator?.engineOwnerId,
    }));
    return observations.every((observation) =>
      observation.server.status === "failed" &&
      observation.orchestrator?.status === "failed" &&
      observation.orchestrator.engineOwnerState === "lost"
    ) ? observations.map((observation) => observation.server) : null;
  }, "server receives engine-loss for real runs", 60_000);
  assert.ok(result.debugLostStatuses.every((status) =>
    status.serverStatus === "failed" &&
    status.orchestratorStatus === "failed" &&
    status.orchestratorOwnerState === "lost" &&
    status.orchestratorOwnerId === oldOwnerId
  ));
  const replacement = await waitFor(async () => {
    const health = (await requestJson(orchestratorUrl, "/health")).body;
    const engine = health.engines?.[0];
    return engine?.state === "ready" && engine.engineOwnerId !== oldOwnerId ? engine : null;
  }, "orchestrator starts a replacement real OpenCode generation", 60_000);
  result.engineGenerations.push({
    engineSlotId: replacement.workspaceId,
    engineOwnerId: replacement.engineOwnerId,
    enginePid: replacement.pid,
    engineStartedAt: replacement.spawnedAt,
    engineBaseUrl: replacement.baseUrl,
  });

  const recoverySubmitPromise = submitConversation(result.workspaceId, {
    conversationId: submitted[4].payload.conversationId,
    clientMessageId: "runtime-message-after-generation-loss",
    text: "runtime-after-generation-loss",
  });
  const recoveredActiveStatus = await waitFor(
    () => orchestratorActiveStatus(result.workspaceId, submitted[4].payload.conversationId),
    "recovery run attaches to replacement generation",
  );
  const recoverySubmit = await recoverySubmitPromise;
  assert.equal(recoverySubmit.response.status, 200, JSON.stringify(recoverySubmit.body));
  const recoveredStatus = recoveredActiveStatus;
  assert.equal(recoveredStatus.engineOwnerId, replacement.engineOwnerId);
  assert.notEqual(recoveredStatus.engineOwnerId, oldOwnerId);
  await waitFor(() => providerRequests.some((request) => request.text === "runtime-after-generation-loss"), "recovery run reaches replacement OpenCode");
  const firstSubmits = await Promise.all(firstSubmitPromises);
  assert.ok(firstSubmits.every((item) => [200, 502].includes(item.response.status)), `initial submit statuses: ${firstSubmits.map((item) => item.response.status).join(",")}`);

  result.conversations = submitted.map((item) => ({
    conversationId: item.payload.conversationId,
    opencodeSessionId: item.payload.opencodeSessionId,
    runId: item.payload.runId,
    reservedRunId: item.payload.runId,
    clientMessageId: item.clientMessageId,
    firstOwnerId: item.payload.conversationId === submitted[4].payload.conversationId ? oldOwnerId : [...ownerIds][0],
  }));
  result.generationLoss = {
    oldOwnerId,
    replacementOwnerId: replacement.engineOwnerId,
    lostRunIds: lostStatuses.map((status) => status.runId),
    recoveredRunId: recoveredStatus.runId,
    callbackSchema: "veslo-engine-loss/v1",
  };
  result.provider = {
    baseUrl: providerUrl,
    requestCount: providerRequests.length,
    distinctPromptCount: new Set(providerRequests.map((request) => request.text)).size,
    maxConcurrency: maxProviderConcurrency,
    delayMs: providerDelayMs,
  };
  result.debugProviderRequests = providerRequests;
  result.ok = true;
} catch (error) {
  result.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  result.debugProviderRequests = providerRequests;
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) await stopChild(child);
  await new Promise((resolveClose) => provider.close(() => resolveClose()));
  result.logs = {
    provider: tail(logs.provider),
    orchestrator: tail(logs.orchestrator),
    server: tail(logs.server),
  };
  result.artifactDir = artifactDir;
  await writeFile(join(artifactDir, "veslo-server-orchestrator-opencode.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(join(artifactDir, "provider.log"), logs.provider, "utf8");
  await writeFile(join(artifactDir, "orchestrator.log"), logs.orchestrator, "utf8");
  await writeFile(join(artifactDir, "server.log"), logs.server, "utf8");
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify(result, null, 2));
