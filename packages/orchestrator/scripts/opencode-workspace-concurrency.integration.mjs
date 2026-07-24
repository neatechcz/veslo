import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..", "..");
const opencodeBinary = process.env.VESLO_OPENCODE_BINARY?.trim() ||
  join(repoRoot, "packages", "desktop", "src-tauri", "sidecars", process.platform === "win32" ? "opencode.exe" : "opencode");
const artifactDir = resolve(
  process.env.VESLO_OPENCODE_COMPAT_ARTIFACT_DIR?.trim() ||
    join(repoRoot, ".tmp", "runtime-oracle", `bundled-opencode-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`),
);

const tail = (value, max = 6_000) => value.length > max ? value.slice(-max) : value;

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

async function waitFor(check, label, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${label} timed out: ${lastError instanceof Error ? lastError.message : String(lastError ?? "no result")}`);
}

async function requestJson(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(15_000),
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

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function startOpenCode({ workspace, configDir, dataDir, port, providerPort }) {
  const logs = { stdout: "", stderr: "" };
  const child = spawn(opencodeBinary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspace,
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: dataDir,
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: "deterministic/oracle",
        provider: {
          deterministic: {
            npm: "@ai-sdk/openai-compatible",
            name: "Veslo deterministic compatibility provider",
            options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "oracle" },
            models: { oracle: { name: "Veslo deterministic compatibility model" } },
          },
        },
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { logs.stdout += chunk; });
  child.stderr.on("data", (chunk) => { logs.stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await waitFor(async () => {
    const result = await requestJson(baseUrl, "/global/health", { signal: AbortSignal.timeout(1_000) });
    return result.response.ok ? result.body : null;
  }, "OpenCode health");
  return { child, baseUrl, logs, health };
}

const root = await mkdtemp(join(tmpdir(), "veslo-opencode-concurrency-"));
const workspace = join(root, "workspace");
const configDir = join(root, "config");
const dataDir = join(root, "data");
await mkdir(workspace, { recursive: true });
await mkdir(configDir, { recursive: true });
await mkdir(dataDir, { recursive: true });
const providerPort = await freePort();
const opencodePort = await freePort();
const providerRequests = [];
let activeProviderRequests = 0;
let maxProviderConcurrency = 0;
const provider = createServer(async (request, response) => {
  if (request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "oracle", object: "model", owned_by: "veslo" }] }));
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
    const text = body.messages?.at(-1)?.content ?? "oracle";
    const requestId = providerRequests.length + 1;
    providerRequests.push({ text, at: Date.now() });
    response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive", "cache-control": "no-cache" });
    response.write(`data: ${JSON.stringify({ id: `oracle-${requestId}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: `reply:${text}` }, finish_reason: null }] })}\n\n`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    response.write(`data: ${JSON.stringify({ id: `oracle-${requestId}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  } finally {
    activeProviderRequests -= 1;
  }
});
await new Promise((resolveListen, reject) => provider.listen(providerPort, "127.0.0.1", (error) => error ? reject(error) : resolveListen()));

let first;
let second;
let eventReader;
let eventSessionIds = new Set();
try {
  first = await startOpenCode({ workspace, configDir, dataDir, port: opencodePort, providerPort });
  const eventResponse = await fetch(`${first.baseUrl}/event`, {
    headers: { accept: "text/event-stream", "x-opencode-directory": workspace },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get("content-type") ?? "", /^text\/event-stream/i);
  eventReader = eventResponse.body?.getReader();
  assert.ok(eventReader);
  const eventTask = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    while (eventReader) {
      const chunk = await eventReader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const event = JSON.parse(data);
          const id = event?.properties?.info?.id;
          if (event?.type === "session.created" && typeof id === "string") eventSessionIds.add(id);
        } catch {}
      }
      if (eventSessionIds.size >= 10) return;
    }
  })();
  const sessions = [];
  for (let index = 0; index < 10; index += 1) {
    const created = await requestJson(first.baseUrl, "/session", {
      method: "POST",
      body: JSON.stringify({ directory: workspace, title: `Veslo concurrency ${index + 1}` }),
    });
    assert.equal(created.response.status, 200, `session ${index + 1} create failed: ${JSON.stringify(created.body)}`);
    assert.ok(created.body?.id);
    sessions.push(created.body.id);
  }

  await Promise.race([eventTask, new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))]);
  assert.deepEqual([...eventSessionIds].sort(), [...sessions].sort());

  const scopedReads = await Promise.all(sessions.map(async (id) => {
    const session = await requestJson(first.baseUrl, `/session/${encodeURIComponent(id)}?directory=${encodeURIComponent(workspace)}`, {
      headers: { "x-opencode-directory": workspace },
    });
    const messages = await requestJson(first.baseUrl, `/session/${encodeURIComponent(id)}/message?directory=${encodeURIComponent(workspace)}&limit=20`, {
      headers: { "x-opencode-directory": workspace },
    });
    assert.equal(session.response.status, 200);
    assert.equal(messages.response.status, 200);
    return { id: session.body?.id, messages: messages.body };
  }));
  assert.deepEqual(scopedReads.map((item) => item.id).sort(), [...sessions].sort());

  const promptMessageIds = sessions.map((_, index) =>
    `msg_veslo_v1_${String(index + 1).padStart(32, "0")}`,
  );
  const prompts = await Promise.all(sessions.map((id, index) => requestJson(first.baseUrl, `/session/${encodeURIComponent(id)}/prompt_async?directory=${encodeURIComponent(workspace)}`, {
    method: "POST",
    body: JSON.stringify({
      messageID: promptMessageIds[index],
      model: { providerID: "deterministic", modelID: "oracle" },
      parts: [{ type: "text", text: `conversation-${index + 1}` }],
    }),
  })));
  assert.ok(prompts.every((item) => item.response.status === 204), `concurrent prompt statuses: ${prompts.map((item) => item.response.status).join(",")}`);
  await waitFor(() => providerRequests.length === 10, "ten provider requests", 30_000);
  assert.equal(new Set(providerRequests.map((item) => item.text)).size, 10);
  assert.ok(maxProviderConcurrency > 1, `provider requests did not overlap: ${maxProviderConcurrency}`);

  const abort = await requestJson(first.baseUrl, `/session/${encodeURIComponent(sessions[0])}/abort?directory=${encodeURIComponent(workspace)}`, {
    method: "POST",
    headers: { "x-opencode-directory": workspace },
  });
  assert.ok([200, 204].includes(abort.response.status), `abort failed: ${abort.response.status}`);
  const unaffected = await requestJson(first.baseUrl, `/session/${encodeURIComponent(sessions[1])}?directory=${encodeURIComponent(workspace)}`, {
    headers: { "x-opencode-directory": workspace },
  });
  assert.equal(unaffected.response.status, 200);
  const transcripts = await waitFor(async () => {
    const results = await Promise.all(sessions.map(async (id) => requestJson(
      first.baseUrl,
      `/session/${encodeURIComponent(id)}/message?directory=${encodeURIComponent(workspace)}&limit=20`,
      { headers: { "x-opencode-directory": workspace } },
    )));
    const exactRunMessagesPresent = results.every((item, index) => {
      if (item.response.status !== 200 || !Array.isArray(item.body)) return false;
      const expectedId = promptMessageIds[index];
      const exactUser = item.body.find((message) => message?.info?.role === "user" && message?.info?.id === expectedId);
      const exactAssistant = item.body.find((message) =>
        message?.info?.role === "assistant" && message?.info?.parentID === expectedId,
      );
      return Boolean(exactUser && exactAssistant);
    });
    return exactRunMessagesPresent ? results : null;
  }, "exact messageID transcript correlation", 30_000);
  assert.ok(transcripts.every((item) => item.response.status === 200));

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  await stop(first.child);
  first = null;
  second = await startOpenCode({ workspace, configDir, dataDir, port: opencodePort, providerPort });
  const afterRestart = await Promise.all(sessions.map(async (id) => {
    const result = await requestJson(second.baseUrl, `/session/${encodeURIComponent(id)}?directory=${encodeURIComponent(workspace)}`, {
      headers: { "x-opencode-directory": workspace },
    });
    return { status: result.response.status, id: result.body?.id };
  }));
  assert.ok(afterRestart.every((item) => item.status === 200));
  assert.deepEqual(afterRestart.map((item) => item.id).sort(), [...sessions].sort());

  const result = {
    ok: true,
    schema: "veslo-opencode-bundled-concurrency/v1",
    opencodeBinary,
    opencodeVersion: first?.health?.version ?? second?.health?.version ?? null,
    sessionCount: sessions.length,
    distinctProviderRequests: new Set(providerRequests.map((item) => item.text)).size,
    eventStream: { status: eventResponse.status, contentType: eventResponse.headers.get("content-type"), sessionCount: eventSessionIds.size },
    maxProviderConcurrency,
    abort: { status: abort.response.status, unaffectedSessionStatus: unaffected.response.status },
    transcriptCount: transcripts.length,
    exactPromptMessageIdsPreserved: true,
    restartPreservedSessionIds: true,
    promptStatuses: prompts.map((item) => item.response.status),
  };
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "opencode-bundled-concurrency.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...result, artifactDir }, null, 2));
} catch (error) {
  const result = { ok: false, schema: "veslo-opencode-bundled-concurrency/v1", error: error instanceof Error ? error.message : String(error), firstLogs: first?.logs, secondLogs: second?.logs, providerRequests };
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "opencode-bundled-concurrency.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.error(JSON.stringify({ ...result, artifactDir }, null, 2));
  process.exitCode = 1;
} finally {
  try { await eventReader?.cancel(); } catch {}
  await stop(first?.child);
  await stop(second?.child);
  await new Promise((resolveClose) => provider.close(() => resolveClose()));
  await rm(root, { recursive: true, force: true });
}
