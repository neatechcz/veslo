import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export const PACKAGED_SMOKE_PROVIDER_ID = "veslo-packaged-smoke";
export const PACKAGED_SMOKE_MODEL_ID = "deterministic-chat";
export const PACKAGED_SMOKE_RESPONSE = "PACKAGED_SMOKE_RESPONSE";

export type PackagedSmokeModelFixture = {
  baseUrl: string;
  modelId: string;
  requestCount: () => number;
  stop: () => Promise<void>;
};

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error(
      "Packaged smoke model fixture did not receive a loopback port.",
    );
  }
  return address.port;
}

function writeChatCompletionStream(
  response: ServerResponse,
  requestCount: number,
  model: string,
): void {
  response.writeHead(200, {
    "access-control-allow-origin": "*",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
  const id = "packaged-smoke-" + requestCount;
  const created = Math.floor(Date.now() / 1_000);
  const writeChunk = (choice: Record<string, unknown>) => {
    response.write(
      "data: " +
        JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [choice],
        }) +
        "\n\n",
    );
  };

  writeChunk({
    index: 0,
    delta: { role: "assistant", content: PACKAGED_SMOKE_RESPONSE },
    finish_reason: null,
  });
  writeChunk({
    index: 0,
    delta: {},
    finish_reason: "stop",
  });
  response.end("data: [DONE]\n\n");
}

export async function startPackagedSmokeModelFixture(): Promise<PackagedSmokeModelFixture> {
  let requests = 0;
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (method === "OPTIONS") {
      sendJson(response, 204, null);
      return;
    }
    if (
      method === "GET" &&
      (url.pathname === "/health" || url.pathname === "/v1/models")
    ) {
      sendJson(
        response,
        200,
        url.pathname === "/health"
          ? { ok: true }
          : {
              object: "list",
              data: [
                {
                  id: PACKAGED_SMOKE_MODEL_ID,
                  object: "model",
                  owned_by: "veslo-e2e",
                },
              ],
            },
      );
      return;
    }
    if (method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readJson(request);
      requests += 1;
      const model =
        typeof body.model === "string" && body.model.trim()
          ? body.model.trim()
          : PACKAGED_SMOKE_MODEL_ID;
      writeChatCompletionStream(response, requests, model);
      return;
    }

    sendJson(response, 404, {
      error: {
        message:
          "Unsupported packaged smoke fixture route: " +
          method +
          " " +
          url.pathname,
      },
    });
  });

  const port = await listen(server);
  return {
    baseUrl: "http://127.0.0.1:" + port + "/v1",
    modelId: PACKAGED_SMOKE_MODEL_ID,
    requestCount: () => requests,
    stop: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}
