import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";

import { createHeadlessServicesProfile, startHeadlessServices } from "./headless-services.mjs";

async function requestJson(runtime, path, options = {}) {
  const response = await fetch(`${runtime.baseUrl}${path}`, options);
  const body = await response.json().catch(() => null);
  return { response, body };
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
) {
  return await requestJson(runtime, `/workspace/${encodeURIComponent(workspace.id)}/conversations/submit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-veslo-send-trace-id": "service-gate-first-submit",
    },
    body: JSON.stringify(body),
  });
}

async function readFakeRequests(runtime) {
  const text = await readFile(runtime.logs.fakeLog, "utf8");
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
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
    assert.deepEqual(prompts[0]?.bodyKeys, ["parts"]);
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
