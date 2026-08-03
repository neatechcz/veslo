import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";

import {
  createHeadlessServicesProfile,
  startHeadlessDaemonServices,
  startHeadlessServices,
} from "./headless-services.mjs";

async function requestJson(runtime, path, options = {}) {
  const response = await fetch(`${runtime.baseUrl}${path}`, options);
  const body = await response.json().catch(() => null);
  return { response, body };
}

function traceEventCount(trace, event) {
  return (trace.match(new RegExp(`"event":"${event}"`, "g")) ?? []).length;
}

async function activeWorkspace(runtime) {
  const { response, body } = await requestJson(runtime, "/workspaces", {
    headers: { Authorization: `Bearer ${runtime.token}` },
  });
  assert.equal(response.status, 200);
  const workspace = body?.items?.find((item) => item?.id === body?.activeId) ?? body?.items?.[0];
  assert.equal(typeof workspace?.id, "string");
  assert.equal(workspace.path, runtime.workspace);
  return workspace;
}

function submitBody(runtime, clientMessageId) {
  return {
    clientMessageId,
    origin: "session:normal",
    source: "enter",
    target: { directory: runtime.workspace, pendingClientSessionId: "pending-service-gate" },
    draft: {
      mode: "prompt",
      text: "service gate",
      parts: [{ type: "text", text: "service gate" }],
    },
  };
}

async function submitFirstMessage(
  runtime,
  workspace,
  clientMessageId,
  body = submitBody(runtime, clientMessageId),
  token = runtime.token,
  requestOptions = {},
) {
  return await requestJson(runtime, `/workspace/${encodeURIComponent(workspace.id)}/conversations/submit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-veslo-send-trace-id": "service-gate-first-submit",
    },
    body: JSON.stringify(body),
    ...requestOptions,
  });
}

async function queuedRunStatus(runtime, workspace, conversationId, queueItemId) {
  return await requestJson(
    runtime,
    `/workspace/${encodeURIComponent(workspace.id)}/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(queueItemId)}`,
    { headers: { Authorization: `Bearer ${runtime.token}` } },
  );
}

async function waitForQueuedRunStatus(runtime, workspace, conversationId, queueItemId, expectedStatus, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await queuedRunStatus(runtime, workspace, conversationId, queueItemId);
    if (result.response.status === 200 && result.body?.status === expectedStatus) return result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for queued run ${queueItemId} to become ${expectedStatus}`);
}

async function runStatus(runtime, workspace, conversationId, runId) {
  return await requestJson(
    runtime,
    `/workspace/${encodeURIComponent(workspace.id)}/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}`,
    { headers: { Authorization: `Bearer ${runtime.token}` } },
  );
}

async function waitForRunStatus(runtime, workspace, conversationId, runId, expectedStatus, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runStatus(runtime, workspace, conversationId, runId);
    if (result.response.status === 200 && result.body?.status === expectedStatus) return result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for run ${runId} to become ${expectedStatus}`);
}

async function daemonWorkspaceEngine(runtime) {
  const response = await fetch(`${runtime.daemonUrl}/health`);
  const body = await response.json().catch(() => null);
  assert.equal(response.status, 200);
  const engine = body?.engines?.find((candidate) => candidate?.workspaceId === runtime.workspaceId);
  assert.equal(typeof engine?.engineOwnerId, "string");
  assert.equal(typeof engine?.pid, "number");
  assert.equal(typeof engine?.spawnedAt, "number");
  assert.equal(typeof engine?.baseUrl, "string");
  return engine;
}

async function waitForDeliverySnapshot(runtime, path, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await requestJson(runtime, path, {
      headers: { Authorization: `Bearer ${runtime.token}` },
    });
    if (result.response.status === 200 && predicate(result.body?.snapshot)) return result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for delivery snapshot ${path}`);
}

async function readFakeRequests(runtime) {
  const text = await readFile(runtime.logs.fakeLog, "utf8");
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForFakeRequest(runtime, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const requests = await readFakeRequests(runtime).catch(() => []);
    if (requests.some((entry) => predicate(entry, requests))) return requests;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Timed out waiting for the expected fake OpenCode request");
}

async function startFakeAiGateway(profile) {
  const callerToken = crypto.randomUUID();
  const runtimeToken = crypto.randomUUID();
  const logPath = join(profile.root, "diagnostics", "fake-ai-gateway.ndjson");
  const requests = [];
  let providerFailuresRemaining = 0;
  const writeEntry = async (entry) => {
    requests.push(entry);
    await mkdir(join(profile.root, "diagnostics"), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      // The assertion below records only the parse outcome, never raw body content.
    }
    const authorization = request.headers.authorization ?? "";
    const entry = {
      method: request.method ?? "GET",
      path: request.url ?? "/",
      authorizationSource: authorization === `Bearer ${callerToken}`
        ? "caller"
        : authorization === `Bearer ${runtimeToken}`
          ? "runtime"
          : "unexpected",
      sessionId: request.headers["x-veslo-session-id"] ?? null,
      hasGatewayToken: Boolean(request.headers["x-veslo-gateway-token"]),
      hasGatewayAuthorization: Boolean(request.headers["x-veslo-gateway-authorization"]),
      hasWorkspaceId: Boolean(request.headers["x-veslo-workspace-id"]),
      hasSendTraceId: Boolean(request.headers["x-veslo-send-trace-id"]),
      hasSessionAffinity: Boolean(request.headers["x-session-affinity"]),
      hasOpenCodeSessionId: Boolean(request.headers["x-session-id"]),
      bodyKeys: body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort() : [],
      messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
      bodyParse: bodyText && !body ? "failed" : "ok",
    };
    await writeEntry(entry);
    response.setHeader("content-type", "application/json");
    if (entry.path === "/api/me/ai-access" && entry.authorizationSource === "caller") {
      response.end(JSON.stringify({
        accessToken: runtimeToken,
        aiAccess: { enabled: true, provider: "codex_oauth", defaultModel: "test-model" },
      }));
      return;
    }
    if (entry.path === "/providers/codex_oauth/v1/chat/completions" && entry.authorizationSource === "runtime") {
      if (providerFailuresRemaining > 0) {
        providerFailuresRemaining -= 1;
        response.statusCode = 503;
        response.statusMessage = "Fake Gateway Unavailable";
        response.end(JSON.stringify({ error: `fake upstream rejected ${runtimeToken}` }));
        return;
      }
      response.end(JSON.stringify({ id: "gateway-test-completion", object: "chat.completion", model: "test-model" }));
      return;
    }
    response.statusCode = 401;
    response.end(JSON.stringify({ error: "unexpected fake gateway request" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    callerToken,
    runtimeToken,
    logPath,
    requests,
    failNextProvider() {
      providerFailuresRemaining += 1;
    },
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

async function primeManagedAi(runtime, workspace, gateway) {
  const access = await requestJson(runtime, `/workspace/${encodeURIComponent(workspace.id)}/ai-gateway/me/ai-access`, {
    headers: {
      Authorization: `Bearer ${runtime.token}`,
      "x-veslo-gateway-authorization": `Bearer ${gateway.callerToken}`,
    },
  });
  assert.equal(access.response.status, 200);
  assert.equal(access.body?.aiAccess?.enabled, true);
}

async function submitManagedAi(runtime, workspace, clientMessageId, pendingClientSessionId = clientMessageId) {
  const body = submitBody(runtime, clientMessageId);
  body.target.pendingClientSessionId = pendingClientSessionId;
  body.options = { expectAiGatewayStart: true };
  const submitted = await submitFirstMessage(runtime, workspace, clientMessageId, body);
  assert.equal(submitted.response.status, 200);
  assert.equal(submitted.body?.status, "submitted");
  assert.equal(typeof submitted.body?.opencodeSessionId, "string");
  return submitted;
}

async function providerRequest(runtime, workspace, options = {}) {
  const {
    sessionId = "${OPENCODE_SESSION_ID}",
    openCodeSessionId,
    gatewayToken = "Bearer stale-test-token",
    gatewayAuthorization = "Bearer injected-test-token",
    traceId = "service-gate-provider-request",
    message = "gateway diagnostic content",
  } = options;
  return await requestJson(runtime, "/ai-gateway/providers/codex_oauth/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runtime.token}`,
      "Content-Type": "application/json",
      "x-veslo-session-id": sessionId,
      "x-veslo-workspace-id": workspace.id,
      "x-veslo-gateway-token": gatewayToken,
      "x-veslo-gateway-authorization": gatewayAuthorization,
      "x-veslo-send-trace-id": traceId,
      "x-session-affinity": "test-only-affinity",
      ...(openCodeSessionId ? { "x-session-id": openCodeSessionId } : {}),
    },
    body: JSON.stringify({
      model: "test-model",
      stream: false,
      messages: [{ role: "user", content: message }],
    }),
  });
}

function gatewayProviderRequests(gateway) {
  return gateway.requests.filter((entry) => entry.path === "/providers/codex_oauth/v1/chat/completions");
}

function assertCleanGatewayProviderRequest(request, expectedSessionId) {
  assert.equal(request?.authorizationSource, "runtime");
  assert.equal(request?.sessionId, expectedSessionId);
  assert.equal(request?.hasGatewayToken, false);
  assert.equal(request?.hasGatewayAuthorization, false);
  assert.equal(request?.hasWorkspaceId, false);
  assert.equal(request?.hasSendTraceId, false);
  assert.equal(request?.hasSessionAffinity, false);
  assert.equal(request?.hasOpenCodeSessionId, false);
  assert.deepEqual(request?.bodyKeys, ["messages", "model", "stream"]);
  assert.equal(request?.messageCount, 1);
}

function assertAuthenticatedFakeRequests(requests) {
  assert.ok(requests.length > 0, "the fake OpenCode engine should receive requests");
  assert.ok(
    requests.every((request) => request.authenticated === true),
    "every fake OpenCode request should carry the generated start-mode Basic auth header",
  );
}

function preservedRuntimeError(runtime, error) {
  return new Error(
    `Headless services test failed; preserved runtime diagnostics at ${runtime.root} ` +
      `(logs: ${runtime.logs.orchestratorLog}, traces: ${runtime.logs.serverTrace}, ${runtime.logs.orchestratorTrace})`,
    { cause: error },
  );
}

test("headless services submit the first message once through the real dev topology", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessServices();
  let preserve = true;
  try {
    const { response: health } = await requestJson(runtime, "/health");
    assert.equal(health.status, 200);

    const { response: rejected } = await requestJson(runtime, "/workspaces", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.ok([401, 403].includes(rejected.status));

    const { response: hostRejected } = await requestJson(runtime, "/approvals", {
      headers: { "X-Veslo-Host-Token": "wrong-token" },
    });
    assert.ok([401, 403].includes(hostRejected.status));

    const { response: hostAccepted } = await requestJson(runtime, "/approvals", {
      headers: { "X-Veslo-Host-Token": runtime.hostToken },
    });
    assert.equal(hostAccepted.status, 200);

    const workspace = await activeWorkspace(runtime);
    const status = await requestJson(runtime, "/status", {
      headers: { Authorization: `Bearer ${runtime.token}` },
    });
    assert.equal(status.response.status, 200);
    assert.equal(status.body?.runtimeChain?.status, "server_running");
    assert.equal(status.body?.runtimeChain?.orchestrator?.configured, false);

    const rejectedSubmit = await submitFirstMessage(
      runtime,
      workspace,
      "service-gate-rejected",
      submitBody(runtime, "service-gate-rejected"),
      "wrong-token",
    );
    assert.ok([401, 403].includes(rejectedSubmit.response.status));

    const first = await submitFirstMessage(runtime, workspace, "service-gate-message-1");
    assert.equal(first.response.status, 200);
    assert.equal(first.body?.status, "submitted");
    assert.equal(typeof first.body?.conversationId, "string");
    assert.equal(typeof first.body?.opencodeSessionId, "string");
    assert.ok(first.body?.debugTrace?.some((entry) =>
      entry?.event === "server:conversation-run:opencode-submit" &&
      entry?.traceId === "service-gate-first-submit"));

    const replay = await submitFirstMessage(runtime, workspace, "service-gate-message-1");
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.body, first.body);

    const conflictingBody = submitBody(runtime, "service-gate-message-1");
    conflictingBody.draft.text = "different service gate";
    conflictingBody.draft.parts[0].text = "different service gate";
    const conflict = await submitFirstMessage(runtime, workspace, "service-gate-message-1", conflictingBody);
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body?.code, "idempotency_conflict");

    const proxyHealth = await requestJson(runtime, `/workspace/${encodeURIComponent(workspace.id)}/opencode/global/health`, {
      headers: { Authorization: `Bearer ${runtime.token}` },
    });
    assert.equal(proxyHealth.response.status, 200);

    const requests = await readFakeRequests(runtime);
    const sessions = requests.filter((entry) => entry.method === "POST" && entry.path === "/session");
    const prompts = requests.filter((entry) => entry.method === "POST" && entry.path === `/session/${first.body.opencodeSessionId}/prompt_async`);
    assert.equal(sessions.length, 1);
    assert.equal(prompts.length, 1);
    assert.equal(sessions[0]?.sessionId, first.body.opencodeSessionId);
    assert.equal(sessions[0]?.directory, runtime.workspace);
    assert.equal(prompts[0]?.directory, runtime.workspace);
    assert.equal(prompts[0]?.traceId, "service-gate-first-submit");
    assert.deepEqual(prompts[0]?.bodyKeys, ["messageID", "parts"]);
    assert.match(prompts[0]?.messageID ?? "", /^msg_[0-9a-f]{26}$/);
    assert.equal(prompts[0]?.partCount, 1);
    assert.deepEqual(prompts[0]?.partTypes, ["text"]);
    assertAuthenticatedFakeRequests(requests);

    const [serverTrace, orchestratorTrace] = await Promise.all([
      readFile(runtime.logs.serverTrace, "utf8"),
      readFile(runtime.logs.orchestratorTrace, "utf8"),
    ]);
    assert.match(serverTrace, /"traceId":"service-gate-first-submit"/);
    assert.match(serverTrace, /server:opencode-json:done/);
    assert.match(orchestratorTrace, /orchestrator:engine-spawned/);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services exercise server, orchestrator daemon, and engine proxy as one lifecycle-owned topology", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessDaemonServices();
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    assert.equal(workspace.id, runtime.workspaceId);

    const statusBefore = await requestJson(runtime, "/status", {
      headers: { Authorization: `Bearer ${runtime.token}` },
    });
    assert.equal(statusBefore.response.status, 200);
    assert.equal(statusBefore.body?.runtimeChain?.orchestrator?.configured, true);
    assert.equal(statusBefore.body?.runtimeChain?.orchestrator?.ok, true);
    assert.equal(statusBefore.body?.runtimeChain?.status, "runtime_chain_ready");

    const submitted = await submitFirstMessage(runtime, workspace, "service-gate-daemon-lifecycle");
    assert.equal(submitted.response.status, 200);
    assert.equal(submitted.body?.status, "submitted");
    assert.equal(typeof submitted.body?.runId, "string");
    assert.equal(typeof submitted.body?.conversationId, "string");
    assert.equal(typeof submitted.body?.opencodeSessionId, "string");

    const [requests, serverTrace, orchestratorTrace] = await Promise.all([
      readFakeRequests(runtime),
      readFile(runtime.logs.serverTrace, "utf8"),
      readFile(runtime.logs.orchestratorTrace, "utf8"),
    ]);
    const sessions = requests.filter((entry) => entry.method === "POST" && entry.path === "/session");
    const prompts = requests.filter((entry) =>
      entry.method === "POST" && entry.path === `/session/${submitted.body.opencodeSessionId}/prompt_async`);
    assert.equal(sessions.length, 1);
    assert.equal(prompts.length, 1);
    assertAuthenticatedFakeRequests(requests);
    assert.match(serverTrace, /server:orchestrator-workspace-register:done/);
    assert.match(serverTrace, /server:conversation-run:lifecycle-register/);
    assert.match(serverTrace, new RegExp(`"runId":"${submitted.body.runId}"`));
    assert.match(orchestratorTrace, /orchestrator:workspace-resolve:done/);
    assert.match(orchestratorTrace, /orchestrator:engine-spawned/);
    assert.match(orchestratorTrace, /orchestrator:proxy-upstream:done/);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services join one early session event to its exact run delivery snapshot", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessDaemonServices({ fakeMode: "event-sequence" });
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const clientMessageId = "service-gate-delivery-snapshot";
    const submittedPromise = submitFirstMessage(runtime, workspace, clientMessageId);
    await waitForFakeRequest(runtime, (entry) =>
      entry.method === "POST" && /\/prompt_async$/.test(entry.path) && entry.traceId === "service-gate-first-submit");

    const stream = await fetch(
      `${runtime.baseUrl}/workspace/${encodeURIComponent(workspace.id)}/opencode/event?directory=${encodeURIComponent(runtime.workspace)}`,
      { headers: { Authorization: `Bearer ${runtime.token}` } },
    );
    assert.equal(stream.status, 200);
    const streamText = await stream.text();
    const submitted = await submittedPromise;
    assert.equal(submitted.response.status, 200);
    assert.equal(submitted.body?.status, "submitted");
    assert.match(streamText, /vesloBinding/);
    assert.match(streamText, new RegExp(submitted.body.opencodeSessionId));

    const deliveryPath = `/workspace/${encodeURIComponent(workspace.id)}/conversations/${encodeURIComponent(submitted.body.conversationId)}/runs/${encodeURIComponent(submitted.body.runId)}/delivery`;
    const routerObservationPath = "/internal/orchestrator/run-delivery-snapshot/router-observed";
    const unauthorizedRouterObservation = await requestJson(runtime, routerObservationPath, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Veslo-Orchestrator-Token": "wrong-token" },
      body: JSON.stringify({ schema: "veslo-run-delivery-snapshot/v1" }),
    });
    assert.equal(unauthorizedRouterObservation.response.status, 401);
    const malformedRouterObservation = await requestJson(runtime, routerObservationPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Veslo-Orchestrator-Token": runtime.lifecycleToken,
      },
      body: JSON.stringify({ schema: "veslo-run-delivery-snapshot/v1", eventCount: 0 }),
    });
    assert.equal(malformedRouterObservation.response.status, 400);
    const beforeApp = await requestJson(runtime, deliveryPath, {
      headers: { Authorization: `Bearer ${runtime.token}` },
    });
    assert.equal(beforeApp.response.status, 200);
    assert.equal(beforeApp.body?.status, "recorded");
    assert.equal(beforeApp.body?.snapshot?.opencodeSessionId, submitted.body.opencodeSessionId);
    assert.equal(beforeApp.body?.snapshot?.router?.sessionBoundEventCount, 1);
    assert.equal(typeof beforeApp.body?.snapshot?.engineOwnerId, "string");

    const appReportPath = `${deliveryPath}/app-report`;
    const aggregate = await requestJson(runtime, appReportPath, {
      method: "POST",
      headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "aggregate",
        acceptedEventCount: 1,
        storeCommitCount: 1,
        rejectedByReason: { duplicate_event: 1 },
        firstObservedAt: "2026-07-30T10:00:00.000Z",
        lastObservedAt: "2026-07-30T10:00:01.000Z",
      }),
    });
    assert.equal(aggregate.response.status, 202);
    const terminal = await requestJson(runtime, appReportPath, {
      method: "POST",
      headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "terminal", hydration: "adopted", presentation: "visible_output" }),
    });
    assert.equal(terminal.response.status, 202);
    const forgedServerTerminal = await requestJson(runtime, appReportPath, {
      method: "POST",
      headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "terminal",
        lifecycle: "completed",
        canonicalRecovery: "recovered",
        hydration: "adopted",
      }),
    });
    assert.equal(forgedServerTerminal.response.status, 400);

    const delivery = await requestJson(runtime, deliveryPath, {
      headers: { Authorization: `Bearer ${runtime.token}` },
    });
    assert.equal(delivery.response.status, 200);
    assert.deepEqual(delivery.body?.snapshot?.app, {
      acceptedEventCount: 1,
      rejectedEventCount: 1,
      rejectedByReason: { duplicate_event: 1 },
      storeCommitCount: 1,
      firstObservedAt: "2026-07-30T10:00:00.000Z",
      lastObservedAt: "2026-07-30T10:00:01.000Z",
      reportedAt: delivery.body?.snapshot?.app?.reportedAt,
    });
    assert.equal(delivery.body?.snapshot?.terminal?.hydration, "adopted");
    assert.equal(delivery.body?.snapshot?.terminal?.presentation, "visible_output");
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services flush terminal router evidence before a long-lived SSE stream closes", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessDaemonServices({ fakeMode: "event-terminal-hold" });
  let preserve = true;
  const streamAbort = new AbortController();
  try {
    const workspace = await activeWorkspace(runtime);
    const submittedPromise = submitFirstMessage(runtime, workspace, "service-gate-delivery-terminal-flush");
    await waitForFakeRequest(runtime, (entry) =>
      entry.method === "POST" && /\/prompt_async$/.test(entry.path) && entry.traceId === "service-gate-first-submit");

    const stream = await fetch(
      `${runtime.baseUrl}/workspace/${encodeURIComponent(workspace.id)}/opencode/event?directory=${encodeURIComponent(runtime.workspace)}`,
      { headers: { Authorization: `Bearer ${runtime.token}` }, signal: streamAbort.signal },
    );
    assert.equal(stream.status, 200);
    const reader = stream.body?.getReader();
    assert.ok(reader);
    const firstEvent = await reader.read();
    assert.equal(firstEvent.done, false);

    const submitted = await submittedPromise;
    assert.equal(submitted.response.status, 200);
    const deliveryPath = `/workspace/${encodeURIComponent(workspace.id)}/conversations/${encodeURIComponent(submitted.body.conversationId)}/runs/${encodeURIComponent(submitted.body.runId)}/delivery`;
    const delivery = await waitForDeliverySnapshot(
      runtime,
      deliveryPath,
      (snapshot) => snapshot?.router?.sessionBoundEventCount === 1,
    );
    assert.equal(delivery.body?.snapshot?.router?.sessionBoundEventCount, 1);
    assert.equal(firstEvent.done, false, "the fixture keeps the SSE response open until the client aborts it");
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    streamAbort.abort();
    await runtime.close({ preserve });
  }
});

test("headless services flush each run on one long-lived workspace event stream", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessDaemonServices({ fakeMode: "event-terminal-hold" });
  let preserve = true;
  const streamAbort = new AbortController();
  try {
    const workspace = await activeWorkspace(runtime);
    const firstId = "service-gate-delivery-stream-run-a";
    const firstBody = submitBody(runtime, firstId);
    firstBody.target.pendingClientSessionId = firstId;
    const firstPromise = submitFirstMessage(runtime, workspace, firstId, firstBody);
    await waitForFakeRequest(runtime, (entry, entries) =>
      entries.filter((candidate) => candidate.method === "POST" && /\/prompt_async$/.test(candidate.path)).length >= 1);

    // Event streams are non-starting. Open the one shared stream only after
    // the first submit has cold-started the workspace engine.
    const stream = await fetch(
      `${runtime.baseUrl}/workspace/${encodeURIComponent(workspace.id)}/opencode/event?directory=${encodeURIComponent(runtime.workspace)}`,
      { headers: { Authorization: `Bearer ${runtime.token}` }, signal: streamAbort.signal },
    );
    assert.equal(stream.status, 200);
    const reader = stream.body?.getReader();
    assert.ok(reader);

    const secondId = "service-gate-delivery-stream-run-b";
    const secondBody = submitBody(runtime, secondId);
    secondBody.target.pendingClientSessionId = secondId;
    const secondPromise = submitFirstMessage(runtime, workspace, secondId, secondBody);
    await waitForFakeRequest(runtime, (entry, entries) =>
      entries.filter((candidate) => candidate.method === "POST" && /\/prompt_async$/.test(candidate.path)).length >= 2);

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 200);
    assert.notEqual(first.body?.runId, second.body?.runId);
    await reader.read();

    const deliveryPath = (submitted) =>
      `/workspace/${encodeURIComponent(workspace.id)}/conversations/${encodeURIComponent(submitted.body.conversationId)}/runs/${encodeURIComponent(submitted.body.runId)}/delivery`;
    const [firstDelivery, secondDelivery] = await Promise.all([
      waitForDeliverySnapshot(runtime, deliveryPath(first), (snapshot) => snapshot?.router?.sessionBoundEventCount === 1),
      waitForDeliverySnapshot(runtime, deliveryPath(second), (snapshot) => snapshot?.router?.sessionBoundEventCount === 1),
    ]);
    assert.equal(firstDelivery.body?.snapshot?.router?.sessionBoundEventCount, 1);
    assert.equal(secondDelivery.body?.snapshot?.router?.sessionBoundEventCount, 1);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    streamAbort.abort();
    await runtime.close({ preserve });
  }
});

test("headless services fence an old delivery snapshot after its engine is replaced", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessDaemonServices({ fakeMode: "event-sequence", faultInjection: true });
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const firstPromise = submitFirstMessage(runtime, workspace, "service-gate-delivery-generation-old");
    await waitForFakeRequest(runtime, (entry) =>
      entry.method === "POST" && /\/prompt_async$/.test(entry.path) && entry.traceId === "service-gate-first-submit");
    const stream = await fetch(
      `${runtime.baseUrl}/workspace/${encodeURIComponent(workspace.id)}/opencode/event?directory=${encodeURIComponent(runtime.workspace)}`,
      { headers: { Authorization: `Bearer ${runtime.token}` } },
    );
    assert.equal(stream.status, 200);
    await stream.text();
    const first = await firstPromise;
    assert.equal(first.response.status, 200);
    const oldEngine = await daemonWorkspaceEngine(runtime);
    const oldDeliveryPath = `/workspace/${encodeURIComponent(workspace.id)}/conversations/${encodeURIComponent(first.body.conversationId)}/runs/${encodeURIComponent(first.body.runId)}/delivery`;
    const beforeLoss = await requestJson(runtime, oldDeliveryPath, { headers: { Authorization: `Bearer ${runtime.token}` } });
    assert.equal(beforeLoss.body?.snapshot?.router?.sessionBoundEventCount, 1);

    const killed = await fetch(`${runtime.daemonUrl}/e2e/workspace/${encodeURIComponent(runtime.workspaceId)}/kill-child`, {
      method: "POST",
    });
    assert.equal(killed.status, 202);
    const terminal = await waitForRunStatus(runtime, workspace, first.body.conversationId, first.body.runId, "failed");
    assert.equal(terminal.body?.status, "failed");
    const terminalDelivery = await waitForDeliverySnapshot(
      runtime,
      oldDeliveryPath,
      (snapshot) => snapshot?.terminal?.lifecycle === "failed",
      20_000,
    );
    assert.equal(terminalDelivery.body?.snapshot?.terminal?.canonicalRecovery, "unavailable");

    const second = await submitFirstMessage(runtime, workspace, "service-gate-delivery-generation-new");
    assert.equal(second.response.status, 200);
    const replacementEngine = await daemonWorkspaceEngine(runtime);
    assert.notEqual(replacementEngine.pid, oldEngine.pid);
    assert.notEqual(replacementEngine.spawnedAt, oldEngine.spawnedAt);

    const staleReport = await requestJson(runtime, "/internal/orchestrator/run-delivery-snapshot/router-observed", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Veslo-Orchestrator-Token": runtime.lifecycleToken,
      },
      body: JSON.stringify({
        schema: "veslo-run-delivery-snapshot/v1",
        workspaceId: workspace.id,
        conversationId: first.body.conversationId,
        runId: first.body.runId,
        opencodeSessionId: first.body.opencodeSessionId,
        engineOwnerId: replacementEngine.engineOwnerId,
        enginePid: replacementEngine.pid,
        engineStartedAt: replacementEngine.spawnedAt,
        engineBaseUrl: replacementEngine.baseUrl,
        eventCount: 1,
        firstObservedAt: "2026-07-30T11:00:00.000Z",
        lastObservedAt: "2026-07-30T11:00:00.000Z",
      }),
    });
    assert.equal(staleReport.response.status, 202);

    const afterReplacement = await requestJson(runtime, oldDeliveryPath, { headers: { Authorization: `Bearer ${runtime.token}` } });
    assert.equal(afterReplacement.body?.status, "incomplete");
    assert.equal(afterReplacement.body?.snapshot?.router?.sessionBoundEventCount, 1);
    assert.equal(afterReplacement.body?.snapshot?.engineGenerationId, beforeLoss.body?.snapshot?.engineGenerationId);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services fan out concurrent new chats through one daemon-owned engine pool", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessDaemonServices({ fakeMode: "prompt-delay" });
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const count = 6;
    const submissions = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        submitFirstMessage(runtime, workspace, `service-gate-daemon-fanout-${index}`)),
    );
    for (const submitted of submissions) {
      assert.equal(submitted.response.status, 200);
      assert.equal(submitted.body?.status, "submitted");
    }
    const sessionIds = submissions.map((submitted) => submitted.body.opencodeSessionId);
    const conversationIds = submissions.map((submitted) => submitted.body.conversationId);
    assert.equal(new Set(sessionIds).size, count);
    assert.equal(new Set(conversationIds).size, count);

    const [requests, serverTrace, orchestratorTrace] = await Promise.all([
      readFakeRequests(runtime),
      readFile(runtime.logs.serverTrace, "utf8"),
      readFile(runtime.logs.orchestratorTrace, "utf8"),
    ]);
    assert.equal(requests.filter((entry) => entry.method === "POST" && entry.path === "/session").length, count);
    assert.equal(requests.filter((entry) => entry.method === "POST" && /\/prompt_async$/.test(entry.path)).length, count);
    assertAuthenticatedFakeRequests(requests);
    assert.equal((orchestratorTrace.match(/orchestrator:engine-spawned/g) ?? []).length, 1);
    assert.equal((orchestratorTrace.match(/orchestrator:workspace-resolve:done/g) ?? []).length, 1);
    assert.equal(traceEventCount(serverTrace, "server:conversation-run:lifecycle-register:start"), count);
    assert.equal(traceEventCount(serverTrace, "server:conversation-run:lifecycle-register"), count);
    assert.equal(traceEventCount(serverTrace, "server:orchestrator-workspace-register:done"), count);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services replay an aborted client submit through the daemon without duplicating the engine prompt", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessDaemonServices({ fakeMode: "prompt-response-delay" });
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const clientMessageId = "service-gate-daemon-lost-response";
    const controller = new AbortController();
    const interrupted = submitFirstMessage(
      runtime,
      workspace,
      clientMessageId,
      submitBody(runtime, clientMessageId),
      runtime.token,
      { signal: controller.signal },
    );
    await waitForFakeRequest(runtime, (entry) =>
      entry.method === "POST" && /\/prompt_async$/.test(entry.path) && entry.traceId === "service-gate-first-submit");
    controller.abort();
    await assert.rejects(interrupted, (error) => error?.name === "AbortError");

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
    const replay = await submitFirstMessage(runtime, workspace, clientMessageId);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body?.status, "submitted");

    const [requests, serverTrace, orchestratorTrace] = await Promise.all([
      readFakeRequests(runtime),
      readFile(runtime.logs.serverTrace, "utf8"),
      readFile(runtime.logs.orchestratorTrace, "utf8"),
    ]);
    assert.equal(requests.filter((entry) => entry.method === "POST" && entry.path === "/session").length, 1);
    assert.equal(requests.filter((entry) => entry.method === "POST" && /\/prompt_async$/.test(entry.path)).length, 1);
    assertAuthenticatedFakeRequests(requests);
    assert.equal(traceEventCount(serverTrace, "server:conversation-run:lifecycle-register"), 1);
    assert.equal((orchestratorTrace.match(/orchestrator:engine-spawned/g) ?? []).length, 1);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services expose daemon run state only to the real lifecycle token", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessDaemonServices();
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const submitted = await submitFirstMessage(runtime, workspace, "service-gate-daemon-lifecycle-auth");
    assert.equal(submitted.response.status, 200);
    const path = `/workspace/${encodeURIComponent(runtime.workspaceId)}/conversations/${encodeURIComponent(submitted.body.conversationId)}/runs/${encodeURIComponent(submitted.body.runId)}`;

    const missingToken = await fetch(`${runtime.daemonUrl}${path}`);
    assert.equal(missingToken.status, 401);
    assert.deepEqual(await missingToken.json(), { error: "unauthorized" });

    const legacyHeaders = await fetch(`${runtime.daemonUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        "X-Veslo-Host-Token": runtime.hostToken,
      },
    });
    assert.equal(legacyHeaders.status, 401);
    assert.deepEqual(await legacyHeaders.json(), { error: "unauthorized" });

    const authorized = await fetch(`${runtime.daemonUrl}${path}`, {
      headers: { "X-Veslo-Orchestrator-Token": runtime.lifecycleToken },
    });
    assert.equal(authorized.status, 200);
    const run = await authorized.json();
    assert.equal(run?.runId, submitted.body.runId);
    assert.equal(run?.conversationId, submitted.body.conversationId);
    assert.equal(run?.engineSessionId, submitted.body.opencodeSessionId);
    assert.equal(run?.status, "running");
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services recover a server submit after the daemon suspends its owned engine", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessDaemonServices();
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const first = await submitFirstMessage(runtime, workspace, "service-gate-daemon-suspend-first");
    assert.equal(first.response.status, 200);
    assert.equal(first.body?.status, "submitted");

    const disposed = await fetch(`${runtime.daemonUrl}/instances/${encodeURIComponent(runtime.workspaceId)}/dispose`, {
      method: "POST",
    });
    const disposedBody = await disposed.json().catch(() => null);
    assert.equal(disposed.status, 200);
    assert.equal(disposedBody?.disposed, true);

    const second = await submitFirstMessage(runtime, workspace, "service-gate-daemon-suspend-second");
    assert.equal(second.response.status, 200);
    assert.equal(second.body?.status, "submitted");
    assert.notEqual(second.body?.opencodeSessionId, first.body?.opencodeSessionId);

    const [requests, orchestratorTrace] = await Promise.all([
      readFakeRequests(runtime),
      readFile(runtime.logs.orchestratorTrace, "utf8"),
    ]);
    assert.equal(requests.filter((entry) => entry.method === "POST" && entry.path === "/session").length, 2);
    assert.equal(requests.filter((entry) => entry.method === "POST" && /\/prompt_async$/.test(entry.path)).length, 2);
    assertAuthenticatedFakeRequests(requests);
    assert.equal((orchestratorTrace.match(/orchestrator:engine-spawned/g) ?? []).length, 2);
    assert.match(orchestratorTrace, /orchestrator:proxy-ensure:done/);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services classify a fake prompt failure without crashing", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessServices({ fakeMode: "prompt-500" });
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const failed = await submitFirstMessage(runtime, workspace, "service-gate-message-failure");
    assert.equal(failed.response.status, 200);
    assert.equal(failed.body?.status, "failed");
    assert.equal(failed.body?.code, "opencode_request_failed");
    assert.equal(failed.body?.draftDisposition, "restore");
    assert.equal(failed.body?.debugTrace?.[0]?.upstreamStatus, 502);
    assert.equal(typeof failed.body?.opencodeSessionId, "string");

    const requests = await readFakeRequests(runtime);
    const sessions = requests.filter((entry) => entry.method === "POST" && entry.path === "/session");
    const prompts = requests.filter((entry) =>
      entry.method === "POST" && entry.path === `/session/${failed.body.opencodeSessionId}/prompt_async`);
    assert.equal(sessions.length, 1);
    assert.equal(prompts.length, 1);
    assertAuthenticatedFakeRequests(requests);

    const { response: health } = await requestJson(runtime, "/health");
    assert.equal(health.status, 200);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services join concurrent retries into one upstream first submit", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessServices({ fakeMode: "prompt-delay" });
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const body = submitBody(runtime, "service-gate-message-concurrent");
    const [first, second] = await Promise.all([
      submitFirstMessage(runtime, workspace, "service-gate-message-concurrent", body),
      submitFirstMessage(runtime, workspace, "service-gate-message-concurrent", body),
    ]);
    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 200);
    assert.deepEqual(second.body, first.body);

    const requests = await readFakeRequests(runtime);
    const sessions = requests.filter((entry) => entry.method === "POST" && entry.path === "/session");
    const prompts = requests.filter((entry) => entry.method === "POST" && /\/prompt_async$/.test(entry.path));
    assert.equal(sessions.length, 1);
    assert.equal(prompts.length, 1);
    assertAuthenticatedFakeRequests(requests);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services reject a conflicting submit while the original first prompt is still in flight", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessServices({ fakeMode: "prompt-response-delay" });
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const clientMessageId = "service-gate-inflight-conflict";
    const originalBody = submitBody(runtime, clientMessageId);
    const original = submitFirstMessage(runtime, workspace, clientMessageId, originalBody);
    await waitForFakeRequest(runtime, (entry) =>
      entry.method === "POST" && /\/prompt_async$/.test(entry.path));

    const conflictBody = submitBody(runtime, clientMessageId);
    conflictBody.draft.text = "conflicting in-flight text";
    conflictBody.draft.parts[0].text = "conflicting in-flight text";
    const conflict = await submitFirstMessage(runtime, workspace, clientMessageId, conflictBody);
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body?.code, "idempotency_conflict");

    const completed = await original;
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body?.status, "submitted");

    const requests = await readFakeRequests(runtime);
    assert.equal(requests.filter((entry) => entry.method === "POST" && entry.path === "/session").length, 1);
    assert.equal(requests.filter((entry) => entry.method === "POST" && /\/prompt_async$/.test(entry.path)).length, 1);
    assertAuthenticatedFakeRequests(requests);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services reject malformed first submits before OpenCode contact", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessServices();
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const invalidBody = submitBody(runtime, "service-gate-message-invalid");
    invalidBody.draft.parts = { unexpected: true };
    const invalid = await submitFirstMessage(runtime, workspace, "service-gate-message-invalid", invalidBody);
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body?.code, "invalid_payload");

    const requests = await readFakeRequests(runtime);
    assert.equal(requests.some((entry) => entry.method === "POST" && entry.path === "/session"), false);
    assert.equal(requests.some((entry) => entry.method === "POST" && /\/prompt_async$/.test(entry.path)), false);

    const { response: health } = await requestJson(runtime, "/health");
    assert.equal(health.status, 200);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services restore a first draft when session materialization fails", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessServices({ fakeMode: "session-500" });
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const failed = await submitFirstMessage(runtime, workspace, "service-gate-message-session-failure");
    assert.equal(failed.response.status, 200);
    assert.equal(failed.body?.status, "failed");
    assert.equal(failed.body?.code, "conversation_create_failed");
    assert.equal(failed.body?.draftDisposition, "restore");
    assert.equal(failed.body?.debugTrace?.[0]?.upstreamCode, "opencode_request_failed");
    assert.equal(failed.body?.debugTrace?.[0]?.upstreamStatus, 502);

    const requests = await readFakeRequests(runtime);
    const sessions = requests.filter((entry) => entry.method === "POST" && entry.path === "/session");
    const prompts = requests.filter((entry) => entry.method === "POST" && /\/prompt_async$/.test(entry.path));
    assert.equal(sessions.length, 1);
    assert.equal(prompts.length, 0);
    assertAuthenticatedFakeRequests(requests);

    const { response: health } = await requestJson(runtime, "/health");
    assert.equal(health.status, 200);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services retry a failed prompt through its materialized first session", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessServices({ fakeMode: "prompt-500-once" });
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const clientMessageId = "service-gate-message-retry";
    const first = await submitFirstMessage(runtime, workspace, clientMessageId);
    assert.equal(first.response.status, 200);
    assert.equal(first.body?.status, "failed");
    assert.equal(first.body?.code, "opencode_request_failed");
    assert.equal(first.body?.draftDisposition, "restore");
    assert.equal(typeof first.body?.conversationId, "string");
    assert.equal(typeof first.body?.opencodeSessionId, "string");

    const retry = await submitFirstMessage(runtime, workspace, clientMessageId);
    assert.equal(retry.response.status, 200);
    assert.equal(retry.body?.status, "submitted");
    assert.equal(retry.body?.draftDisposition, "clear");
    assert.equal(retry.body?.conversationId, first.body.conversationId);
    assert.equal(retry.body?.opencodeSessionId, first.body.opencodeSessionId);

    const requests = await readFakeRequests(runtime);
    const sessions = requests.filter((entry) => entry.method === "POST" && entry.path === "/session");
    const prompts = requests.filter((entry) => entry.method === "POST" && entry.path === `/session/${first.body.opencodeSessionId}/prompt_async`);
    assert.equal(sessions.length, 1);
    assert.equal(prompts.length, 2);
    assertAuthenticatedFakeRequests(requests);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services recover a dropped upstream prompt connection through the materialized session", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessServices({ fakeMode: "prompt-close-once" });
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const clientMessageId = "service-gate-prompt-connection-drop";
    const first = await submitFirstMessage(runtime, workspace, clientMessageId);
    assert.equal(first.response.status, 200);
    assert.equal(first.body?.status, "submitted");
    assert.equal(first.body?.draftDisposition, "clear");
    assert.equal(typeof first.body?.opencodeSessionId, "string");

    const replay = await submitFirstMessage(runtime, workspace, clientMessageId);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body?.status, "submitted");
    assert.equal(replay.body?.conversationId, first.body.conversationId);
    assert.equal(replay.body?.opencodeSessionId, first.body.opencodeSessionId);

    const requests = await readFakeRequests(runtime);
    assert.equal(requests.filter((entry) => entry.method === "POST" && entry.path === "/session").length, 1);
    assert.equal(requests.filter((entry) =>
      entry.method === "POST" && entry.path === `/session/${first.body.opencodeSessionId}/prompt_async`).length, 2);
    assertAuthenticatedFakeRequests(requests);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services resume a failed first prompt after a full topology restart without rematerializing", { timeout: 90_000 }, async () => {
  const profile = await createHeadlessServicesProfile();
  let firstRuntime;
  let secondRuntime;
  let preserve = true;
  try {
    const clientMessageId = "service-gate-restart-failed-prompt";
    firstRuntime = await startHeadlessServices({ profile, fakeMode: "prompt-500" });
    const firstWorkspace = await activeWorkspace(firstRuntime);
    const failed = await submitFirstMessage(firstRuntime, firstWorkspace, clientMessageId);
    assert.equal(failed.response.status, 200);
    assert.equal(failed.body?.status, "failed");
    assert.equal(failed.body?.code, "opencode_request_failed");
    assert.equal(typeof failed.body?.conversationId, "string");
    assert.equal(typeof failed.body?.opencodeSessionId, "string");
    await firstRuntime.close({ preserve: true });

    secondRuntime = await startHeadlessServices({ profile, fakeMode: "success" });
    const secondWorkspace = await activeWorkspace(secondRuntime);
    const retry = await submitFirstMessage(secondRuntime, secondWorkspace, clientMessageId);
    assert.equal(retry.response.status, 200);
    assert.equal(retry.body?.status, "submitted");
    assert.equal(retry.body?.conversationId, failed.body.conversationId);
    assert.equal(retry.body?.opencodeSessionId, failed.body.opencodeSessionId);

    const retryRequests = await readFakeRequests(secondRuntime);
    assert.equal(retryRequests.some((entry) => entry.method === "POST" && entry.path === "/session"), false);
    const retryPrompts = retryRequests.filter((entry) =>
      entry.method === "POST" && entry.path === `/session/${failed.body.opencodeSessionId}/prompt_async`);
    assert.equal(retryPrompts.length, 1);
    assertAuthenticatedFakeRequests(retryRequests);
    preserve = false;
  } catch (error) {
    const runtime = secondRuntime ?? firstRuntime;
    if (runtime) throw preservedRuntimeError(runtime, error);
    throw new Error(`Headless services failed-prompt restart test failed; preserved runtime diagnostics at ${profile.root}`, { cause: error });
  } finally {
    await firstRuntime?.close({ preserve: true });
    await secondRuntime?.close({ preserve: true });
    if (!preserve) await profile.cleanup();
  }
});

test("headless services replay a submit after the client loses its response without a second upstream prompt", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessServices({ fakeMode: "prompt-response-delay" });
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const clientMessageId = "service-gate-lost-response";
    const controller = new AbortController();
    const interrupted = submitFirstMessage(
      runtime,
      workspace,
      clientMessageId,
      submitBody(runtime, clientMessageId),
      runtime.token,
      { signal: controller.signal },
    );
    await waitForFakeRequest(runtime, (entry) =>
      entry.method === "POST" && /\/prompt_async$/.test(entry.path) && entry.traceId === "service-gate-first-submit");
    controller.abort();
    await assert.rejects(interrupted, (error) => error?.name === "AbortError");

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
    const replay = await submitFirstMessage(runtime, workspace, clientMessageId);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body?.status, "submitted");

    const requests = await readFakeRequests(runtime);
    const sessions = requests.filter((entry) => entry.method === "POST" && entry.path === "/session");
    const prompts = requests.filter((entry) => entry.method === "POST" && /\/prompt_async$/.test(entry.path));
    assert.equal(sessions.length, 1);
    assert.equal(prompts.length, 1, "the replay must return the completed result, not send another prompt");
    assertAuthenticatedFakeRequests(requests);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services replay a completed submit after client loss and a full topology restart", { timeout: 90_000 }, async () => {
  const profile = await createHeadlessServicesProfile();
  let firstRuntime;
  let secondRuntime;
  let preserve = true;
  try {
    const clientMessageId = "service-gate-lost-response-restart";
    firstRuntime = await startHeadlessServices({ profile, fakeMode: "prompt-response-delay" });
    const firstWorkspace = await activeWorkspace(firstRuntime);
    const controller = new AbortController();
    const interrupted = submitFirstMessage(
      firstRuntime,
      firstWorkspace,
      clientMessageId,
      submitBody(firstRuntime, clientMessageId),
      firstRuntime.token,
      { signal: controller.signal },
    );
    await waitForFakeRequest(firstRuntime, (entry) =>
      entry.method === "POST" && /\/prompt_async$/.test(entry.path));
    controller.abort();
    await assert.rejects(interrupted, (error) => error?.name === "AbortError");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
    await firstRuntime.close({ preserve: true });

    secondRuntime = await startHeadlessServices({ profile, fakeMode: "success" });
    const secondWorkspace = await activeWorkspace(secondRuntime);
    const replay = await submitFirstMessage(secondRuntime, secondWorkspace, clientMessageId);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body?.status, "submitted");

    const replayRequests = await readFakeRequests(secondRuntime);
    assert.equal(replayRequests.some((entry) => entry.method === "POST" && entry.path === "/session"), false);
    assert.equal(replayRequests.some((entry) => entry.method === "POST" && /\/prompt_async$/.test(entry.path)), false);
    preserve = false;
  } catch (error) {
    const runtime = secondRuntime ?? firstRuntime;
    if (runtime) throw preservedRuntimeError(runtime, error);
    throw new Error(`Headless services lost-response restart test failed; preserved runtime diagnostics at ${profile.root}`, { cause: error });
  } finally {
    await firstRuntime?.close({ preserve: true });
    await secondRuntime?.close({ preserve: true });
    if (!preserve) await profile.cleanup();
  }
});

test("headless services resolve an existing conversation to its canonical OpenCode session", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessServices();
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const first = await submitFirstMessage(runtime, workspace, "service-gate-canonical-target-first");
    assert.equal(first.response.status, 200);
    assert.equal(first.body?.status, "submitted");
    assert.equal(typeof first.body?.conversationId, "string");
    assert.equal(typeof first.body?.opencodeSessionId, "string");

    const followUpId = "service-gate-canonical-target-follow-up";
    const followUp = submitBody(runtime, followUpId);
    followUp.target = {
      directory: runtime.workspace,
      conversationId: first.body.conversationId,
      opencodeSessionId: "ses_client_tampered_target",
    };
    const submitted = await submitFirstMessage(runtime, workspace, followUpId, followUp);
    assert.equal(submitted.response.status, 200);
    assert.equal(submitted.body?.status, "submitted");
    assert.equal(submitted.body?.conversationId, first.body.conversationId);
    assert.equal(submitted.body?.opencodeSessionId, first.body.opencodeSessionId);

    const requests = await readFakeRequests(runtime);
    assert.equal(requests.filter((entry) => entry.method === "POST" && entry.path === "/session").length, 1);
    assert.equal(requests.filter((entry) =>
      entry.method === "POST" && entry.path === `/session/${first.body.opencodeSessionId}/prompt_async`).length, 2);
    assert.equal(requests.some((entry) => entry.path.includes("ses_client_tampered_target")), false);
    assertAuthenticatedFakeRequests(requests);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services reject a standalone queue-only intent before it can persist", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessServices();
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const first = await submitFirstMessage(runtime, workspace, "service-gate-queue-first");
    assert.equal(first.response.status, 200);
    assert.equal(first.body?.status, "submitted");

    const clientMessageId = "service-gate-queue-idempotent";
    const queuedBody = submitBody(runtime, clientMessageId);
    queuedBody.target = {
      directory: runtime.workspace,
      conversationId: first.body.conversationId,
      opencodeSessionId: first.body.opencodeSessionId,
    };
    queuedBody.options = { submitQueuePolicy: "server-queue-only" };
    const queued = await submitFirstMessage(runtime, workspace, clientMessageId, queuedBody);
    assert.equal(queued.response.status, 200);
    assert.equal(queued.body?.status, "failed");
    assert.equal(queued.body?.code, "lifecycle_unavailable");
    assert.equal(queued.body?.draftDisposition, "restore");

    const replay = await submitFirstMessage(runtime, workspace, clientMessageId, queuedBody);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body?.status, "failed");
    assert.equal(replay.body?.code, "lifecycle_unavailable");

    const requests = await readFakeRequests(runtime);
    assert.equal(requests.filter((entry) => entry.method === "POST" && entry.path === "/session").length, 1);
    assert.equal(requests.filter((entry) =>
      entry.method === "POST" && entry.path === `/session/${first.body.opencodeSessionId}/prompt_async`).length, 1);
    assertAuthenticatedFakeRequests(requests);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services do not replay a rejected standalone queue-only intent after a full topology restart", { timeout: 90_000 }, async () => {
  const profile = await createHeadlessServicesProfile();
  let firstRuntime;
  let secondRuntime;
  let preserve = true;
  try {
    firstRuntime = await startHeadlessServices({ profile, queueDrainPollMs: 10_000 });
    const firstWorkspace = await activeWorkspace(firstRuntime);
    const first = await submitFirstMessage(firstRuntime, firstWorkspace, "service-gate-queue-restart-first");
    assert.equal(first.response.status, 200);
    assert.equal(first.body?.status, "submitted");

    const clientMessageId = "service-gate-queue-restart-follow-up";
    const queuedBody = submitBody(firstRuntime, clientMessageId);
    queuedBody.target = {
      directory: firstRuntime.workspace,
      conversationId: first.body.conversationId,
      opencodeSessionId: first.body.opencodeSessionId,
    };
    queuedBody.options = { submitQueuePolicy: "server-queue-only" };
    const queued = await submitFirstMessage(firstRuntime, firstWorkspace, clientMessageId, queuedBody);
    assert.equal(queued.response.status, 200);
    assert.equal(queued.body?.status, "failed");
    assert.equal(queued.body?.code, "lifecycle_unavailable");
    await firstRuntime.close({ preserve: true });

    secondRuntime = await startHeadlessServices({ profile });
    const secondWorkspace = await activeWorkspace(secondRuntime);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));

    const requests = await readFakeRequests(secondRuntime);
    assert.equal(requests.some((entry) => entry.method === "POST" && entry.path === "/session"), false);
    assert.equal(requests.filter((entry) =>
      entry.method === "POST" && entry.path === `/session/${first.body.opencodeSessionId}/prompt_async`).length, 0);
    assertAuthenticatedFakeRequests(requests);
    preserve = false;
  } catch (error) {
    const runtime = secondRuntime ?? firstRuntime;
    if (runtime) throw preservedRuntimeError(runtime, error);
    throw new Error(`Headless services queued-restart test failed; preserved runtime diagnostics at ${profile.root}`, { cause: error });
  } finally {
    await firstRuntime?.close({ preserve: true });
    await secondRuntime?.close({ preserve: true });
    if (!preserve) await profile.cleanup();
  }
});

test("headless daemon services drain fast queued follow-ups for one conversation in FIFO run order", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessDaemonServices({ fakeMode: "queue-lifecycle-delay" });
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const first = await submitFirstMessage(runtime, workspace, "service-gate-queue-fifo-first");
    assert.equal(first.response.status, 200);
    assert.equal(first.body?.status, "submitted");

    const queueFollowUp = async (clientMessageId) => {
      const body = submitBody(runtime, clientMessageId);
      body.target = {
        directory: runtime.workspace,
        conversationId: first.body.conversationId,
        opencodeSessionId: first.body.opencodeSessionId,
      };
      body.options = { submitQueuePolicy: "server-queue-only" };
      const submitted = await submitFirstMessage(runtime, workspace, clientMessageId, body);
      assert.equal(submitted.response.status, 202);
      assert.equal(submitted.body?.status, "queued");
      return submitted;
    };
    const queuedFirst = await queueFollowUp("service-gate-queue-fifo-a");
    const queuedSecond = await queueFollowUp("service-gate-queue-fifo-b");
    assert.notEqual(queuedFirst.body?.queueItemId, queuedSecond.body?.queueItemId);
    assert.notEqual(queuedFirst.body?.reservedRunId, queuedSecond.body?.reservedRunId);
    assert.equal(queuedFirst.body?.queuePosition, 1);
    assert.equal(queuedSecond.body?.queuePosition, 2);

    await waitForFakeRequest(runtime, (_entry, requests) =>
      requests.filter((entry) =>
        entry.method === "POST" && entry.path === `/session/${first.body.opencodeSessionId}/prompt_async`).length === 3,
      15_000,
    );
    const [firstQueueStatus, secondQueueStatus] = await Promise.all([
      waitForQueuedRunStatus(runtime, workspace, first.body.conversationId, queuedFirst.body.queueItemId, "submitted"),
      waitForQueuedRunStatus(runtime, workspace, first.body.conversationId, queuedSecond.body.queueItemId, "submitted"),
    ]);
    assert.equal(firstQueueStatus.body?.clientMessageId, "service-gate-queue-fifo-a");
    assert.equal(secondQueueStatus.body?.clientMessageId, "service-gate-queue-fifo-b");

    const prompts = (await readFakeRequests(runtime)).filter((entry) =>
      entry.method === "POST" && entry.path === `/session/${first.body.opencodeSessionId}/prompt_async`);
    assert.equal(prompts.length, 3);
    const serverTrace = (await readFile(runtime.logs.serverTrace, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      serverTrace
        .filter((entry) =>
          entry.event === "server:conversation-run:opencode-submit-body" &&
          ["service-gate-queue-fifo-a", "service-gate-queue-fifo-b"].includes(entry.clientMessageId))
        .map((entry) => entry.runId),
      [queuedFirst.body.reservedRunId, queuedSecond.body.reservedRunId],
    );
    assertAuthenticatedFakeRequests(prompts);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless daemon services fence a recovery message behind an unresolved terminal handoff", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessDaemonServices({ fakeMode: "queue-lifecycle-fail-second" });
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const first = await submitFirstMessage(runtime, workspace, "service-gate-queue-failure-first");
    assert.equal(first.response.status, 200);
    assert.equal(first.body?.status, "submitted");

    const failedMessageId = "service-gate-queue-failure";
    const failedBody = submitBody(runtime, failedMessageId);
    failedBody.target = {
      directory: runtime.workspace,
      conversationId: first.body.conversationId,
      opencodeSessionId: first.body.opencodeSessionId,
    };
    failedBody.options = { submitQueuePolicy: "server-queue-only" };
    const queued = await submitFirstMessage(runtime, workspace, failedMessageId, failedBody);
    assert.equal(queued.response.status, 202);
    assert.equal(queued.body?.status, "queued");
    const failedQueueStatus = await waitForQueuedRunStatus(
      runtime,
      workspace,
      first.body.conversationId,
      queued.body.queueItemId,
      "failed",
    );
    assert.equal(failedQueueStatus.body?.clientMessageId, failedMessageId);

    const replay = await submitFirstMessage(runtime, workspace, failedMessageId, failedBody);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body?.status, "failed");
    assert.equal(replay.body?.code, "queued_run_failed");
    assert.equal(replay.body?.draftDisposition, "restore");

    const recoveryMessageId = "service-gate-queue-failure-recovery";
    const recoveryBody = submitBody(runtime, recoveryMessageId);
    recoveryBody.target = failedBody.target;
    recoveryBody.options = { submitQueuePolicy: "server-queue-only" };
    const recovery = await submitFirstMessage(runtime, workspace, recoveryMessageId, recoveryBody);
    assert.equal(recovery.response.status, 202);
    assert.equal(recovery.body?.status, "queued");
    const pendingQueueStatus = await waitForQueuedRunStatus(
      runtime,
      workspace,
      first.body.conversationId,
      recovery.body.queueItemId,
      "pending",
    );
    assert.equal(pendingQueueStatus.body?.clientMessageId, recoveryMessageId);

    const requests = await readFakeRequests(runtime);
    assert.equal(requests.filter((entry) => entry.method === "POST" && entry.path === "/session").length, 1);
    assert.equal(requests.filter((entry) =>
      entry.method === "POST" && entry.path === `/session/${first.body.opencodeSessionId}/prompt_async`).length, 2);
    assertAuthenticatedFakeRequests(requests);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services reject an unknown existing target without creating or prompting a session", { timeout: 90_000 }, async () => {
  const runtime = await startHeadlessServices();
  let preserve = true;
  try {
    const workspace = await activeWorkspace(runtime);
    const clientMessageId = "service-gate-unknown-existing-target";
    const body = submitBody(runtime, clientMessageId);
    body.target = {
      directory: runtime.workspace,
      conversationId: "conv-00000000000000000000",
      opencodeSessionId: "ses_unknown_existing_target",
    };
    const rejected = await submitFirstMessage(runtime, workspace, clientMessageId, body);
    assert.equal(rejected.response.status, 200);
    assert.equal(rejected.body?.status, "failed");
    assert.equal(rejected.body?.code, "conversation_not_found");
    assert.equal(rejected.body?.draftDisposition, "restore");

    const requests = await readFakeRequests(runtime);
    assert.equal(requests.some((entry) => entry.method === "POST" && entry.path === "/session"), false);
    assert.equal(requests.some((entry) => entry.method === "POST" && /\/prompt_async$/.test(entry.path)), false);
    assert.equal(requests.some((entry) => entry.path.includes("ses_unknown_existing_target")), false);
    assertAuthenticatedFakeRequests(requests);
    preserve = false;
  } catch (error) {
    throw preservedRuntimeError(runtime, error);
  } finally {
    await runtime.close({ preserve });
  }
});

test("headless services replay a completed first submit after a full topology restart", { timeout: 90_000 }, async () => {
  const profile = await createHeadlessServicesProfile();
  let firstRuntime;
  let secondRuntime;
  let preserve = true;
  try {
    const clientMessageId = "service-gate-message-restart";
    firstRuntime = await startHeadlessServices({ profile });
    const firstWorkspace = await activeWorkspace(firstRuntime);
    const first = await submitFirstMessage(firstRuntime, firstWorkspace, clientMessageId);
    assert.equal(first.response.status, 200);
    assert.equal(first.body?.status, "submitted");
    await firstRuntime.close({ preserve: true });

    secondRuntime = await startHeadlessServices({ profile });
    const secondWorkspace = await activeWorkspace(secondRuntime);
    const replay = await submitFirstMessage(secondRuntime, secondWorkspace, clientMessageId);
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.body, first.body);

    const replayRequests = await readFakeRequests(secondRuntime);
    assert.equal(replayRequests.some((entry) => entry.method === "POST" && entry.path === "/session"), false);
    assert.equal(replayRequests.some((entry) => entry.method === "POST" && /\/prompt_async$/.test(entry.path)), false);
    preserve = false;
  } catch (error) {
    const runtime = secondRuntime ?? firstRuntime;
    if (runtime) throw preservedRuntimeError(runtime, error);
    throw new Error(`Headless services restart test failed; preserved runtime diagnostics at ${profile.root}`, { cause: error });
  } finally {
    await firstRuntime?.close({ preserve: true });
    await secondRuntime?.close({ preserve: true });
    if (!preserve) await profile.cleanup();
  }
});

test("headless services retain managed-AI run correlation until the gateway provider request", { timeout: 90_000 }, async () => {
  const profile = await createHeadlessServicesProfile();
  const gateway = await startFakeAiGateway(profile);
  let runtime;
  let preserve = true;
  try {
    runtime = await startHeadlessServices({ profile, aiGatewayBaseUrl: gateway.baseUrl });
    const workspace = await activeWorkspace(runtime);
    const access = await requestJson(runtime, `/workspace/${encodeURIComponent(workspace.id)}/ai-gateway/me/ai-access`, {
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        "x-veslo-gateway-authorization": `Bearer ${gateway.callerToken}`,
      },
    });
    assert.equal(access.response.status, 200);
    assert.equal(access.body?.aiAccess?.enabled, true);

    const clientMessageId = "service-gate-managed-ai";
    const body = submitBody(runtime, clientMessageId);
    body.options = { expectAiGatewayStart: true };
    const submitted = await submitFirstMessage(runtime, workspace, clientMessageId, body);
    assert.equal(submitted.response.status, 200);
    assert.equal(submitted.body?.status, "submitted");

    const provider = await requestJson(runtime, "/ai-gateway/providers/codex_oauth/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        "Content-Type": "application/json",
        "x-veslo-session-id": "${OPENCODE_SESSION_ID}",
        "x-veslo-workspace-id": workspace.id,
        "x-veslo-gateway-token": "Bearer stale-test-token",
        "x-veslo-gateway-authorization": "Bearer injected-test-token",
        "x-veslo-send-trace-id": "service-gate-provider-request",
        "x-session-affinity": "test-only-affinity",
      },
      body: JSON.stringify({
        model: "test-model",
        stream: false,
        messages: [{ role: "user", content: "gateway diagnostic content" }],
      }),
    });
    assert.equal(provider.response.status, 200);
    assert.equal(provider.body?.id, "gateway-test-completion");

    const [accessRequest, providerRequest] = gateway.requests;
    assert.equal(accessRequest?.authorizationSource, "caller");
    assert.equal(providerRequest?.authorizationSource, "runtime");
    assert.equal(providerRequest?.sessionId, submitted.body?.opencodeSessionId);
    assert.equal(providerRequest?.hasGatewayToken, false);
    assert.equal(providerRequest?.hasGatewayAuthorization, false);
    assert.equal(providerRequest?.hasWorkspaceId, false);
    assert.equal(providerRequest?.hasSendTraceId, false);
    assert.equal(providerRequest?.hasSessionAffinity, false);
    assert.deepEqual(providerRequest?.bodyKeys, ["messages", "model", "stream"]);
    assert.equal(providerRequest?.messageCount, 1);

    const [serverTrace, gatewayLog] = await Promise.all([
      readFile(runtime.logs.serverTrace, "utf8"),
      readFile(gateway.logPath, "utf8"),
    ]);
    assert.match(serverTrace, /server:ai-gateway-active-run:register/);
    assert.match(serverTrace, /server:ai-gateway:provider-hit/);
    assert.match(serverTrace, /"sessionResolutionSource":"workspace-active-run-context"/);
    assert.match(serverTrace, /"gatewayAuthorizationSource":"ai-access-token"/);
    assert.match(serverTrace, /server:ai-gateway:proxy:timing/);
    assert.doesNotMatch(gatewayLog, /gateway diagnostic content|stale-test-token|injected-test-token/);
    preserve = false;
  } catch (error) {
    if (runtime) throw preservedRuntimeError(runtime, error);
    throw new Error(`Headless services managed-AI test failed; preserved diagnostics at ${profile.root}`, { cause: error });
  } finally {
    await runtime?.close({ preserve: true });
    await gateway.close();
    if (!preserve) await profile.cleanup();
  }
});

test("headless services reject a cold-start legacy placeholder, then accept it after managed run admission", { timeout: 90_000 }, async () => {
  const profile = await createHeadlessServicesProfile();
  const gateway = await startFakeAiGateway(profile);
  let runtime;
  let preserve = true;
  try {
    runtime = await startHeadlessServices({ profile, aiGatewayBaseUrl: gateway.baseUrl });
    const workspace = await activeWorkspace(runtime);
    await primeManagedAi(runtime, workspace, gateway);

    const coldStart = await providerRequest(runtime, workspace, { traceId: "service-gate-cold-placeholder" });
    assert.equal(coldStart.response.status, 400);
    assert.equal(coldStart.body?.code, "gateway_session_unresolved");
    assert.equal(gatewayProviderRequests(gateway).length, 0);

    const submitted = await submitManagedAi(runtime, workspace, "service-gate-cold-then-admit");
    const admitted = await providerRequest(runtime, workspace, { traceId: "service-gate-admitted-placeholder" });
    assert.equal(admitted.response.status, 200);
    assert.equal(admitted.body?.id, "gateway-test-completion");
    assertCleanGatewayProviderRequest(gatewayProviderRequests(gateway)[0], submitted.body.opencodeSessionId);

    const serverTrace = await readFile(runtime.logs.serverTrace, "utf8");
    assert.match(serverTrace, /server:ai-gateway:session-unresolved/);
    assert.match(serverTrace, /"traceId":"service-gate-first-submit"/);
    assert.match(serverTrace, /"sessionResolutionSource":"workspace-active-run-context"/);
    preserve = false;
  } catch (error) {
    if (runtime) throw preservedRuntimeError(runtime, error);
    throw new Error(`Headless services cold-start gateway test failed; preserved diagnostics at ${profile.root}`, { cause: error });
  } finally {
    await runtime?.close({ preserve: true });
    await gateway.close();
    if (!preserve) await profile.cleanup();
  }
});

test("headless services fail closed for ambiguous placeholder correlation but honor legacy OpenCode session headers", { timeout: 90_000 }, async () => {
  const profile = await createHeadlessServicesProfile();
  const gateway = await startFakeAiGateway(profile);
  let runtime;
  let preserve = true;
  try {
    runtime = await startHeadlessServices({ profile, aiGatewayBaseUrl: gateway.baseUrl });
    const workspace = await activeWorkspace(runtime);
    await primeManagedAi(runtime, workspace, gateway);
    const first = await submitManagedAi(runtime, workspace, "service-gate-ambiguous-first", "pending-ambiguous-first");
    const second = await submitManagedAi(runtime, workspace, "service-gate-ambiguous-second", "pending-ambiguous-second");
    assert.notEqual(second.body?.opencodeSessionId, first.body?.opencodeSessionId);

    const ambiguous = await providerRequest(runtime, workspace, { traceId: "service-gate-ambiguous-placeholder" });
    assert.equal(ambiguous.response.status, 400);
    assert.equal(ambiguous.body?.code, "gateway_session_unresolved");
    assert.equal(gatewayProviderRequests(gateway).length, 0);

    const legacySessionHeader = await providerRequest(runtime, workspace, {
      openCodeSessionId: second.body.opencodeSessionId,
      traceId: "service-gate-legacy-opencode-session",
    });
    assert.equal(legacySessionHeader.response.status, 200);
    assertCleanGatewayProviderRequest(gatewayProviderRequests(gateway)[0], second.body.opencodeSessionId);

    const serverTrace = await readFile(runtime.logs.serverTrace, "utf8");
    assert.match(serverTrace, /"workspaceFallbackSuppressedReason":"ambiguous-active-run-context"/);
    assert.match(serverTrace, /"sessionResolutionSource":"opencode-session-header"/);
    preserve = false;
  } catch (error) {
    if (runtime) throw preservedRuntimeError(runtime, error);
    throw new Error(`Headless services ambiguous gateway test failed; preserved diagnostics at ${profile.root}`, { cause: error });
  } finally {
    await runtime?.close({ preserve: true });
    await gateway.close();
    if (!preserve) await profile.cleanup();
  }
});

test("headless services keep OpenCode session identities distinct for many chats in one workspace", { timeout: 90_000 }, async () => {
  const profile = await createHeadlessServicesProfile();
  const gateway = await startFakeAiGateway(profile);
  let runtime;
  let preserve = true;
  try {
    runtime = await startHeadlessServices({ profile, aiGatewayBaseUrl: gateway.baseUrl });
    const workspace = await activeWorkspace(runtime);
    await primeManagedAi(runtime, workspace, gateway);

    const submissions = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        submitManagedAi(runtime, workspace, `service-gate-session-fanout-${index}`, `pending-session-fanout-${index}`)),
    );
    const sessionIds = submissions.map((submission) => submission.body.opencodeSessionId);
    const conversationIds = submissions.map((submission) => submission.body.conversationId);
    assert.equal(new Set(sessionIds).size, submissions.length, "each chat must receive its own OpenCode session id");
    assert.equal(new Set(conversationIds).size, submissions.length, "each chat must receive its own Veslo conversation id");

    for (const [index, sessionId] of sessionIds.entries()) {
      const provider = await providerRequest(runtime, workspace, {
        openCodeSessionId: sessionId,
        traceId: `service-gate-session-fanout-provider-${index}`,
      });
      assert.equal(provider.response.status, 200);
    }
    const forwarded = gatewayProviderRequests(gateway);
    assert.equal(forwarded.length, sessionIds.length);
    assert.deepEqual(
      new Set(forwarded.map((request) => request.sessionId)),
      new Set(sessionIds),
      "every provider request must preserve the chat-specific OpenCode session id",
    );
    preserve = false;
  } catch (error) {
    if (runtime) throw preservedRuntimeError(runtime, error);
    throw new Error(`Headless services session identity fanout test failed; preserved diagnostics at ${profile.root}`, { cause: error });
  } finally {
    await runtime?.close({ preserve });
    await gateway.close();
  }
});

test("headless services reject cleared runtime authorization despite legacy gateway tokens, then recover after a fresh prime", { timeout: 90_000 }, async () => {
  const profile = await createHeadlessServicesProfile();
  const gateway = await startFakeAiGateway(profile);
  let runtime;
  let preserve = true;
  try {
    runtime = await startHeadlessServices({ profile, aiGatewayBaseUrl: gateway.baseUrl });
    const workspace = await activeWorkspace(runtime);
    await primeManagedAi(runtime, workspace, gateway);
    const submitted = await submitManagedAi(runtime, workspace, "service-gate-auth-clear");

    const cleared = await requestJson(runtime, "/ai-gateway/me/runtime-authorization/clear", {
      method: "POST",
      headers: { Authorization: `Bearer ${runtime.token}` },
    });
    assert.equal(cleared.response.status, 200);

    const redactedLegacy = await providerRequest(runtime, workspace, {
      sessionId: submitted.body.opencodeSessionId,
      gatewayToken: "[REDACTED]",
      traceId: "service-gate-redacted-legacy-token",
    });
    assert.equal(redactedLegacy.response.status, 401);
    assert.equal(redactedLegacy.body?.code, "gateway_legacy_token_unavailable");

    const staleLegacy = await providerRequest(runtime, workspace, {
      sessionId: submitted.body.opencodeSessionId,
      gatewayToken: "Bearer stale-after-clear-token",
      traceId: "service-gate-stale-legacy-token",
    });
    assert.equal(staleLegacy.response.status, 401);
    assert.equal(staleLegacy.body?.code, "gateway_runtime_authorization_required");
    assert.equal(gatewayProviderRequests(gateway).length, 0);

    await primeManagedAi(runtime, workspace, gateway);
    const recovered = await providerRequest(runtime, workspace, {
      sessionId: submitted.body.opencodeSessionId,
      traceId: "service-gate-runtime-auth-recovered",
    });
    assert.equal(recovered.response.status, 200);
    assertCleanGatewayProviderRequest(gatewayProviderRequests(gateway)[0], submitted.body.opencodeSessionId);

    const serverTrace = await readFile(runtime.logs.serverTrace, "utf8");
    assert.match(serverTrace, /server:ai-gateway-legacy-token:ignored/);
    assert.doesNotMatch(serverTrace, /stale-after-clear-token/);
    preserve = false;
  } catch (error) {
    if (runtime) throw preservedRuntimeError(runtime, error);
    throw new Error(`Headless services runtime authorization recovery test failed; preserved diagnostics at ${profile.root}`, { cause: error });
  } finally {
    await runtime?.close({ preserve: true });
    await gateway.close();
    if (!preserve) await profile.cleanup();
  }
});

test("headless services redact an AI gateway upstream failure and retry the same managed session", { timeout: 90_000 }, async () => {
  const profile = await createHeadlessServicesProfile();
  const gateway = await startFakeAiGateway(profile);
  let runtime;
  let preserve = true;
  try {
    runtime = await startHeadlessServices({ profile, aiGatewayBaseUrl: gateway.baseUrl });
    const workspace = await activeWorkspace(runtime);
    await primeManagedAi(runtime, workspace, gateway);
    const submitted = await submitManagedAi(runtime, workspace, "service-gate-upstream-retry");
    gateway.failNextProvider();

    const failed = await providerRequest(runtime, workspace, {
      sessionId: submitted.body.opencodeSessionId,
      traceId: "service-gate-upstream-failure",
    });
    assert.equal(failed.response.status, 502);
    assert.equal(failed.body?.code, "ai_gateway_upstream_failed");
    assert.equal(failed.body?.details?.upstreamStatus, 503);
    assert.match(failed.body?.details?.upstreamResponse ?? "", /\[REDACTED\]/);
    assert.doesNotMatch(failed.body?.details?.upstreamResponse ?? "", new RegExp(gateway.runtimeToken));

    const retry = await providerRequest(runtime, workspace, {
      sessionId: submitted.body.opencodeSessionId,
      traceId: "service-gate-upstream-retry",
    });
    assert.equal(retry.response.status, 200);
    const providerRequests = gatewayProviderRequests(gateway);
    assert.equal(providerRequests.length, 2);
    assertCleanGatewayProviderRequest(providerRequests[0], submitted.body.opencodeSessionId);
    assertCleanGatewayProviderRequest(providerRequests[1], submitted.body.opencodeSessionId);

    const [serverTrace, gatewayLog] = await Promise.all([
      readFile(runtime.logs.serverTrace, "utf8"),
      readFile(gateway.logPath, "utf8"),
    ]);
    assert.match(serverTrace, /"upstreamStatus":503/);
    assert.match(serverTrace, /server:ai-gateway:proxy:timing/);
    assert.doesNotMatch(gatewayLog, new RegExp(gateway.runtimeToken));
    preserve = false;
  } catch (error) {
    if (runtime) throw preservedRuntimeError(runtime, error);
    throw new Error(`Headless services gateway upstream retry test failed; preserved diagnostics at ${profile.root}`, { cause: error });
  } finally {
    await runtime?.close({ preserve: true });
    await gateway.close();
    if (!preserve) await profile.cleanup();
  }
});
