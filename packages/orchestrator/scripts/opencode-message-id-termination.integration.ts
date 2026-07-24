import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createConversationRunOpenCodeMessageId } from "../../server/src/conversation-run-message-id.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..", "..");
const opencodeBinary = process.env.VESLO_OPENCODE_BINARY?.trim() || join(
  repoRoot,
  "packages",
  "desktop",
  "src-tauri",
  "sidecars",
  process.platform === "win32" ? "opencode.exe" : "opencode",
);
const chromeMcpMode = process.env.VESLO_OPENCODE_TERMINATION_CHROME_MCP?.trim() === "1";
const chromeMcpBinary = join(
  repoRoot,
  "packages",
  "desktop",
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "chrome-devtools-mcp.exe" : "chrome-devtools-mcp",
);

async function freePort(): Promise<number> {
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

async function waitFor<T>(check: () => Promise<T | null | false>, label: string, timeoutMs = 30_000): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
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

async function requestJson(baseUrl: string, path: string, input: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: input.method ?? "GET",
    headers: input.body === undefined ? undefined : { "content-type": "application/json" },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

async function stopChild(child: ChildProcess | null) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function removeTempRoot(path: string) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  throw lastError;
}

const root = await mkdtemp(join(tmpdir(), "veslo-opencode-termination-"));
const workspace = join(root, "workspace");
const configDir = join(root, "config");
const dataHome = join(root, "data");
const providerPort = await freePort();
const opencodePort = await freePort();
const providerRequests: Array<{ at: number; body: unknown }> = [];
let opencode: ChildProcess | null = null;
let opencodeLogs = "";

const provider = createHttpServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks).toString("utf8");
  try {
    providerRequests.push({ at: Date.now(), body: rawBody ? JSON.parse(rawBody) : null });
  } catch {
    providerRequests.push({ at: Date.now(), body: rawBody });
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const chunk = (choices: unknown, usage?: unknown) => response.write(`data: ${JSON.stringify({
    id: "chatcmpl-veslo-termination",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model: "fixture-model",
    choices,
    ...(usage ? { usage } : {}),
  })}\n\n`);
  chunk([{ index: 0, delta: { role: "assistant", content: "One response only." }, finish_reason: null }]);
  chunk([{ index: 0, delta: {}, finish_reason: "stop" }], {
    prompt_tokens: 1,
    completion_tokens: 3,
    total_tokens: 4,
  });
  response.end("data: [DONE]\n\n");
});

try {
  assert.ok(existsSync(opencodeBinary), `missing bundled OpenCode: ${opencodeBinary}`);
  if (chromeMcpMode) {
    assert.ok(existsSync(chromeMcpBinary), `missing Chrome MCP sidecar: ${chromeMcpBinary}`);
  }
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(dataHome, { recursive: true });

  const orchestratorNodeModules = join(repoRoot, "packages", "orchestrator", "node_modules");
  await symlink(
    orchestratorNodeModules,
    join(configDir, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeFile(join(configDir, "package.json"), JSON.stringify({
    private: true,
    dependencies: { "@ai-sdk/openai-compatible": "3.0.5" },
  }), "utf8");

  const configPath = join(configDir, "opencode.jsonc");
  await writeFile(configPath, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    default_agent: "veslo-termination",
    model: "fixture/fixture-model",
    agent: {
      "veslo-termination": {
        mode: "primary",
        model: "fixture/fixture-model",
        prompt: "Answer the user once and stop.",
        temperature: 0,
      },
    },
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        name: "Termination fixture",
        options: {
          baseURL: `http://127.0.0.1:${providerPort}/v1`,
          apiKey: "fixture-token",
        },
        models: {
          "fixture-model": {
            name: "Termination fixture model",
            tool_call: true,
            reasoning: false,
            attachment: false,
            limit: { context: 16_384, output: 1_024 },
          },
        },
      },
    },
    ...(chromeMcpMode ? {
      mcp: {
        "chrome-devtools": {
          type: "local",
          command: [chromeMcpBinary, "--isolated"],
        },
      },
    } : {}),
  }, null, 2), "utf8");

  await new Promise<void>((resolveListen, reject) => {
    provider.once("error", reject);
    provider.listen(providerPort, "127.0.0.1", () => resolveListen());
  });

  opencode = spawn(opencodeBinary, [
    "serve",
    "--hostname", "127.0.0.1",
    "--port", String(opencodePort),
    "--pure",
    "--print-logs",
    "--log-level", "INFO",
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: dataHome,
      OPENCODE_CONFIG: configPath,
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  opencode.stdout?.setEncoding("utf8");
  opencode.stderr?.setEncoding("utf8");
  opencode.stdout?.on("data", (chunk) => { opencodeLogs += String(chunk); });
  opencode.stderr?.on("data", (chunk) => { opencodeLogs += String(chunk); });

  const baseUrl = `http://127.0.0.1:${opencodePort}`;
  await waitFor(async () => {
    const health = await requestJson(baseUrl, "/global/health");
    return health.response.ok ? true : null;
  }, "OpenCode health");

  const directoryQuery = `?directory=${encodeURIComponent(workspace)}`;
  const created = await requestJson(baseUrl, `/session${directoryQuery}`, {
    method: "POST",
    body: { title: "Termination regression" },
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  const sessionId = (created.body as { id?: unknown } | null)?.id;
  assert.equal(typeof sessionId, "string", JSON.stringify(created.body));

  const messageID = createConversationRunOpenCodeMessageId({
    workspaceId: "ws-termination",
    engineSessionId: sessionId as string,
    clientMessageId: "client-termination",
    runId: "run-termination",
  });
  const promptStartedAt = Date.now();
  const submitted = await requestJson(
    baseUrl,
    `/session/${encodeURIComponent(sessionId as string)}/prompt_async${directoryQuery}`,
    {
      method: "POST",
      body: { messageID, parts: [{ type: "text", text: "Hello termination test" }] },
    },
  );
  assert.equal(submitted.response.status, 204, JSON.stringify(submitted.body));

  const messages = await waitFor(async () => {
    const transcript = await requestJson(
      baseUrl,
      `/session/${encodeURIComponent(sessionId as string)}/message${directoryQuery}`,
    );
    if (!transcript.response.ok || !Array.isArray(transcript.body)) return null;
    const terminalAssistant = transcript.body.find((message) => (
      message &&
      typeof message === "object" &&
      (message as { info?: { role?: unknown; finish?: unknown } }).info?.role === "assistant" &&
      (message as { info?: { finish?: unknown } }).info?.finish === "stop"
    ));
    return terminalAssistant ? transcript.body : null;
  }, "terminal OpenCode transcript");

  const assistants = messages.filter((message) => (
    message && typeof message === "object" && (message as { info?: { role?: unknown } }).info?.role === "assistant"
  ));
  assert.equal(providerRequests.length, 1, `expected one provider request, got ${providerRequests.length}`);
  assert.equal(assistants.length, 1, `expected one assistant message, got ${assistants.length}`);
  assert.equal((assistants[0] as { info?: { finish?: unknown } }).info?.finish, "stop");
  assert.equal(
    (assistants[0] as { info?: { parentID?: unknown } }).info?.parentID,
    messageID,
  );

  const providerBody = providerRequests[0]?.body;
  const providerTools = providerBody && typeof providerBody === "object" && Array.isArray((providerBody as { tools?: unknown }).tools)
    ? (providerBody as { tools: unknown[] }).tools
    : [];

  console.log(JSON.stringify({
    ok: true,
    opencodeVersion: "1.17.13",
    providerRequestCount: providerRequests.length,
    assistantMessageCount: assistants.length,
    finish: "stop",
    chromeMcpMode,
    toolCount: providerTools.length,
    promptToProviderMs: providerRequests[0]?.at ? providerRequests[0].at - promptStartedAt : null,
    promptToTerminalMs: Date.now() - promptStartedAt,
  }));
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  throw new Error(`${message}\nOpenCode logs:\n${opencodeLogs.slice(-12_000)}`);
} finally {
  await stopChild(opencode);
  await new Promise<void>((resolveClose) => provider.close(() => resolveClose()));
  await removeTempRoot(root);
}
