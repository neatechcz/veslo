const { appendFile, mkdir } = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const version = process.env.VESLO_SERVICE_TEST_OPENCODE_VERSION ?? "1.17.13";

if (args.includes("--version")) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

if (args[0] !== "serve") {
  process.stderr.write("fake-opencode expects: serve --hostname <host> --port <port>\n");
  process.exit(2);
}

function readArg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const hostname = readArg("--hostname") ?? "127.0.0.1";
const port = Number(readArg("--port"));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write("fake-opencode requires a valid --port\n");
  process.exit(2);
}

const mode = process.env.VESLO_SERVICE_TEST_FAKE_MODE ?? "success";
const lifecycleQueueFixture = mode.startsWith("queue-lifecycle");
const logPath = process.env.VESLO_SERVICE_TEST_FAKE_LOG ?? "";
const username = process.env.OPENCODE_SERVER_USERNAME ?? "";
const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
if (!username || !password) {
  process.stderr.write("fake-opencode requires start-mode OpenCode Basic auth credentials\n");
  process.exit(2);
}
const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
let nextSession = 1;
let promptFailureServed = false;
let promptConnectionDropServed = false;
let promptCount = 0;
let terminalHoldEventCount = 0;
const eventSubscribers = new Set();
const sessionMessages = new Map();

async function writeLog(entry) {
  if (!logPath) return;
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 128 * 1024) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function summarizeBody(body) {
  const parts = Array.isArray(body?.parts) ? body.parts : [];
  return {
    bodyKeys: Object.keys(body ?? {}).sort(),
    messageID: typeof body?.messageID === "string" ? body.messageID : null,
    partCount: parts.length,
    partTypes: parts.map((part) => typeof part?.type === "string" ? part.type : "unknown"),
  };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${hostname}:${port}`);
  const requestSummary = {
    method: request.method ?? "GET",
    path: url.pathname,
    directory: request.headers["x-opencode-directory"] ?? null,
    workspaceId: request.headers["x-veslo-workspace-id"] ?? null,
    traceId: request.headers["x-veslo-send-trace-id"] ?? null,
  };

  try {
    if (request.headers.authorization !== expectedAuthorization) {
      await writeLog({ ...requestSummary, authenticated: false });
      sendJson(response, 401, { error: "unauthorized fake OpenCode request" });
      return;
    }
    requestSummary.authenticated = true;

    if (request.method === "GET" && url.pathname === "/global/health") {
      await writeLog(requestSummary);
      sendJson(response, 200, { ok: true, healthy: true, version });
      return;
    }

    if (request.method === "GET" && url.pathname === "/event") {
      await writeLog({ ...requestSummary, eventStream: true });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      eventSubscribers.add(response);
      request.on("close", () => eventSubscribers.delete(response));
      return;
    }

    if (request.method === "POST" && url.pathname === "/session") {
      const body = await readJson(request);
      const sessionId = typeof body?.id === "string" && body.id.trim()
        ? body.id.trim()
        : `ses_fake_${nextSession++}`;
      await writeLog({ ...requestSummary, sessionId, ...summarizeBody(body) });
      if (mode === "session-500") {
        sendJson(response, 500, { error: "fake session failure" });
        return;
      }
      sendJson(response, 200, {
        id: sessionId,
        title: typeof body?.title === "string" ? body.title : "service gate",
        directory: typeof body?.directory === "string" ? body.directory : null,
        parentID: null,
        time: { created: 1, updated: 1 },
      });
      return;
    }

    const messages = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (request.method === "GET" && messages && lifecycleQueueFixture) {
      const sessionId = decodeURIComponent(messages[1]);
      await writeLog({ ...requestSummary, sessionId });
      sendJson(response, 200, sessionMessages.get(sessionId) ?? []);
      return;
    }

    const prompt = /^\/session\/([^/]+)\/prompt_async$/.exec(url.pathname);
    if (request.method === "POST" && prompt) {
      const body = await readJson(request);
      promptCount += 1;
      await writeLog({
        ...requestSummary,
        sessionId: decodeURIComponent(prompt[1]),
        ...summarizeBody(body),
      });
      if (
        mode === "prompt-500" ||
        (mode === "prompt-500-once" && !promptFailureServed) ||
        (mode === "queue-lifecycle-fail-second" && promptCount === 2)
      ) {
        promptFailureServed = true;
        sendJson(response, 500, { error: "fake prompt failure" });
        return;
      }
      if (mode === "prompt-close-once" && !promptConnectionDropServed) {
        promptConnectionDropServed = true;
        response.destroy();
        return;
      }
      const sessionId = decodeURIComponent(prompt[1]);
      const messageId = typeof body?.messageID === "string" && body.messageID.trim()
        ? body.messageID.trim()
        : `msg_fake_user_${nextSession++}`;
      const sessionEntries = lifecycleQueueFixture ? (sessionMessages.get(sessionId) ?? []) : null;
      if (sessionEntries) {
        sessionEntries.push({ info: { id: messageId, role: "user" }, parts: Array.isArray(body?.parts) ? body.parts : [] });
        sessionMessages.set(sessionId, sessionEntries);
      }
      if (mode === "prompt-delay") await delay(100);
      if (mode === "prompt-response-delay" || mode === "queue-lifecycle-delay") await delay(750);
      if (mode === "event-sequence" || mode === "event-terminal-hold") {
        setTimeout(() => {
          const payload = JSON.stringify(
            mode === "event-terminal-hold"
              ? {
                  type: "session.idle",
                  properties: { sessionID: sessionId },
                }
              : {
                  type: "message.part.updated",
                  properties: {
                    part: {
                      id: "part_fake_delivery",
                      messageID: "msg_fake_delivery",
                      sessionID: sessionId,
                      type: "text",
                      text: "delivery fixture",
                    },
                  },
                },
          );
          for (const subscriber of eventSubscribers) {
            subscriber.write(`data: ${payload}\n\n`);
            if (mode !== "event-terminal-hold") {
              subscriber.end();
              eventSubscribers.delete(subscriber);
            }
          }
        }, mode === "event-terminal-hold" ? 250 + terminalHoldEventCount++ * 300 : 250).unref();
        await delay(600);
      }
      if (sessionEntries) {
        sessionEntries.push({
          info: { id: `msg_fake_assistant_${nextSession++}`, role: "assistant", parentID: messageId, finish: "stop" },
          parts: [{ type: "text", text: "fake response" }],
        });
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    await writeLog(requestSummary);
    sendJson(response, 404, { error: "unexpected fake OpenCode route", path: url.pathname });
  } catch (error) {
    await writeLog({ ...requestSummary, error: error instanceof Error ? error.message : String(error) });
    sendJson(response, 400, { error: "invalid fake OpenCode request" });
  }
});

const stop = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
};

process.once("SIGTERM", stop);
process.once("SIGINT", stop);

server.listen(port, hostname, () => {
  process.stdout.write(`fake-opencode listening on ${hostname}:${port}\n`);
});
