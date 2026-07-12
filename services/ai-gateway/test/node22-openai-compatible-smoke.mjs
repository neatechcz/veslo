import assert from "node:assert/strict";
import { createServer } from "node:http";

import { OpenAiCompatibleTransport } from "../dist/providers/openai-compatible-transport.js";

const sockets = new Set();
const server = createServer((request, response) => {
  assert.equal(request.url, "/v1/models");
  response.writeHead(200, {
    "connection": "close",
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ data: [{ id: "smoke/model" }] }));
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert(address && typeof address !== "string");

  const transport = new OpenAiCompatibleTransport({
    allowDevelopmentLoopback: true,
  });
  const result = await transport.listModels({
    apiKey: "smoke-key",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  });

  assert.deepEqual(result, { models: ["smoke/model"] });
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

assert.equal(sockets.size, 0, "model discovery must release its pinned connection");
console.log("Node 22 compiled model discovery smoke passed");
