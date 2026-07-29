import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, "./attach-smoke.mjs"), "utf8");

test("live WebDriver client is attach-only and redacts sensitive browser state", () => {
  assert.match(source, /from "webdriverio"/);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /process\.kill\(descriptor\.appPid, 0\)/);
  assert.match(source, /GET \/status|\/status/);
  assert.match(source, /browser\.deleteSession\(\)/);
  assert.match(source, /mutations: false/);
  assert.doesNotMatch(source, /spawn\(/);
  assert.doesNotMatch(source, /screenshot\(/i);
  assert.doesNotMatch(source, /getPageSource\(/i);
  assert.doesNotMatch(source, /getCookies\(/i);
});

test("attach smoke uses one existing W3C endpoint and closes only its session", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString("utf8") });
    response.setHeader("content-type", "application/json");

    if (request.method === "GET" && request.url === "/status") {
      response.end(JSON.stringify({ value: { ready: true } }));
      return;
    }
    if (request.method === "POST" && request.url === "/session") {
      response.end(JSON.stringify({
        value: {
          sessionId: "attached-session",
          capabilities: { browserName: "tauri" },
        },
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/session/attached-session/elements") {
      response.end(JSON.stringify({ value: [{ "element-6066-11e4-a52e-4f735466cecf": "root" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/session/attached-session/element") {
      response.end(JSON.stringify({ value: { "element-6066-11e4-a52e-4f735466cecf": "root" } }));
      return;
    }
    if (request.method === "GET" && request.url === "/session/attached-session/element/root/displayed") {
      response.end(JSON.stringify({ value: true }));
      return;
    }
    if (request.method === "GET" && request.url === "/session/attached-session/element/root/name") {
      response.end(JSON.stringify({ value: "div" }));
      return;
    }
    if (request.method === "POST" && request.url === "/session/attached-session/execute/sync") {
      response.end(JSON.stringify({ value: true }));
      return;
    }
    if (request.method === "GET" && request.url === "/session/attached-session/window") {
      response.end(JSON.stringify({ value: "main" }));
      return;
    }
    if (request.method === "DELETE" && request.url === "/session/attached-session") {
      response.end(JSON.stringify({ value: null }));
      return;
    }
    response.statusCode = 500;
    response.end(JSON.stringify({ value: { error: "unexpected command", message: `${request.method} ${request.url}` } }));
  });

  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const fixtureDir = await mkdtemp(join(tmpdir(), "veslo-live-webdriver-"));
  const runtimeInfoPath = join(fixtureDir, "runtime-info.json");
  const nativeDescriptorPath = join(fixtureDir, "native-webdriver.json");
  await writeFile(runtimeInfoPath, JSON.stringify({
    schema: "veslo-dev-runtime/v1",
    mode: "live-dev-webdriver",
    profile: { kind: "existing-development", isolated: false },
    env: { VESLO_DEN_AUTH_SNAPSHOT_PATH: null },
    webdriver: { endpoint, descriptorPath: nativeDescriptorPath },
  }));
  await writeFile(nativeDescriptorPath, JSON.stringify({
    schema: "veslo-native-webdriver/v1",
    mode: "live-dev-webdriver",
    appPid: process.pid,
    endpoint,
  }));

  try {
    const child = spawn(process.execPath, [resolve(__dirname, "./attach-smoke.mjs"), runtimeInfoPath], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = await new Promise((resolveOutput, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => resolveOutput({ code, stdout, stderr }));
    });

    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /"attached":true/);
    assert.deepEqual(
      requests.map((entry) => `${entry.method} ${entry.url}`),
      [
        "GET /status",
        "POST /session",
        "GET /session/attached-session/window",
        "POST /session/attached-session/element",
        "POST /session/attached-session/elements",
        "GET /session/attached-session/element/root/name",
        "POST /session/attached-session/execute/sync",
        "POST /session/attached-session/execute/sync",
        "GET /session/attached-session/window",
        "DELETE /session/attached-session",
      ],
    );
    assert.match(
      requests.find((entry) => entry.url === "/session/attached-session/element")?.body ?? "",
      /#root/,
    );
  } finally {
    await new Promise((resolveClosed) => server.close(resolveClosed));
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
