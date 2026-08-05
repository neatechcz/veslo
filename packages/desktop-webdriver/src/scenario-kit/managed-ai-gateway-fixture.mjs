import { createServer } from "node:http";
import { once } from "node:events";

export const FIXTURE_ORG_ID = "org_webdriver_managed_ai";
export const FIXTURE_USER_ID = "user_webdriver_managed_ai";
export const FIXTURE_TOKEN = "webdriver-managed-ai-token";
export const FIXTURE_GATEWAY_TOKEN = "webdriver-managed-ai-gateway-token";
export const FIXTURE_MODEL = "gpt-5.4";

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.once("error", reject);
    request.once("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function userFromAuthorization(header) {
  const token = String(header ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  return token === FIXTURE_TOKEN || token === FIXTURE_GATEWAY_TOKEN
    ? { id: FIXTURE_USER_ID, email: "webdriver-managed-ai@example.test" }
    : null;
}

function completionStream(model, content) {
  const id = `chatcmpl_webdriver_${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const events = [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

function fixtureSoul(scope, ownerId) {
  return {
    id: `${scope}_${ownerId}`,
    scope,
    ownerId,
    currentVersionId: `${scope}_webdriver_v1`,
    heartbeatEnabled: true,
    versions: [{
      id: `${scope}_webdriver_v1`,
      content: "",
      changeSummary: "Fixture baseline",
      createdAt: "2026-08-05T00:00:00.000Z",
      createdBy: FIXTURE_USER_ID,
      source: "api",
      baseVersionId: null,
      restoreSourceVersionId: null,
    }],
  };
}

function textFromValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromValue).join(" ").trim();
  if (!value || typeof value !== "object") return "";
  return textFromValue(value.text) || textFromValue(value.content) || textFromValue(value.input);
}

function promptFromBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of [...messages].reverse()) {
    if (message?.role === "user") {
      const text = textFromValue(message.content);
      if (text) return text;
    }
  }
  return textFromValue(body?.input) || textFromValue(body?.prompt) || "managed-ai-fixture";
}

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * A narrow loopback provider used only by native WebDriver scenarios. It is
 * intentionally independent of the Pilot harness and exposes its evidence in
 * process, so a test can hold and release the exact upstream response it
 * caused without inspecting a browser-only mock.
 */
export async function startControlledManagedAiGatewayFixture({ holdResponses = false } = {}) {
  const attempts = [];
  const requests = [];
  const heldResponses = new Set();
  let denyAccessReads = false;
  let shouldHoldResponses = holdResponses;

  const releaseHeldResponses = () => {
    for (const deferred of heldResponses) deferred.resolve();
    heldResponses.clear();
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const user = userFromAuthorization(request.headers.authorization);
    requests.push({
      at: new Date().toISOString(),
      method: request.method ?? "GET",
      pathname: url.pathname,
      authorized: Boolean(user),
    });
    if (request.method === "GET" && url.pathname === "/readiness") {
      sendJson(response, 200, { ready: true });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/v1/me" || url.pathname === "/api/me")) {
      if (!user) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      sendJson(response, 200, { user, org: { id: FIXTURE_ORG_ID, slug: "webdriver-managed-ai" } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/me/ai-access") {
      if (!user || denyAccessReads) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      sendJson(response, 200, {
        aiAccess: {
          id: "ai_access_webdriver",
          userId: FIXTURE_USER_ID,
          enabled: true,
          provider: "codex_oauth",
          credentialId: "credential_webdriver",
          defaultModel: FIXTURE_MODEL,
          allowedModels: [{ provider: "codex_oauth", model: FIXTURE_MODEL }],
          selectableModels: [{ provider: "codex_oauth", model: FIXTURE_MODEL }],
          effectiveModel: { provider: "codex_oauth", model: FIXTURE_MODEL },
          updatedAt: "2026-08-05T00:00:00.000Z",
        },
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/soul/organization") {
      if (!user) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      sendJson(response, 200, fixtureSoul("organization", FIXTURE_ORG_ID));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/soul/user") {
      if (!user) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      sendJson(response, 200, fixtureSoul("user", FIXTURE_USER_ID));
      return;
    }
    if (
      request.method === "GET"
      && url.pathname === `/v1/orgs/${FIXTURE_ORG_ID}/mcp/catalog`
    ) {
      if (!user) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      sendJson(response, 200, { items: [] });
      return;
    }
    if (request.method === "POST" && url.pathname === "/providers/codex_oauth/v1/chat/completions") {
      if (!user) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      let body;
      try {
        body = await readJson(request);
      } catch {
        sendJson(response, 400, { error: "invalid_json" });
        return;
      }
      const attempt = {
        at: new Date().toISOString(),
        model: typeof body?.model === "string" && body.model.trim() ? body.model.trim() : FIXTURE_MODEL,
        prompt: promptFromBody(body),
        sessionId: String(request.headers["x-veslo-session-id"] ?? "").trim(),
        authorizationPresent: Boolean(user),
      };
      attempts.push(attempt);
      if (shouldHoldResponses) {
        const deferred = createDeferred();
        heldResponses.add(deferred);
        await deferred.promise;
        heldResponses.delete(deferred);
      }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.end(completionStream(attempt.model, `WebDriver managed-AI fixture response for ${attempt.prompt}.`));
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Controlled managed-AI gateway fixture did not bind a loopback port.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    attempts,
    requests,
    setHoldResponses(value) {
      shouldHoldResponses = Boolean(value);
      if (!shouldHoldResponses) releaseHeldResponses();
    },
    setDenyAccessReads(value) {
      denyAccessReads = Boolean(value);
    },
    releaseHeldResponses,
    async waitForAttempts(expectedCount, { timeoutMs = 30_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (attempts.length >= expectedCount) return attempts.slice();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const observedRoutes = requests.map((request) => `${request.method} ${request.pathname}`).join(", ") || "none";
      throw new Error(
        `Timed out waiting for ${expectedCount} provider request(s); observed ${attempts.length}. `
        + `Fixture routes: ${observedRoutes}.`,
      );
    },
    async close() {
      releaseHeldResponses();
      server.close();
      await once(server, "close");
    },
  };
}
