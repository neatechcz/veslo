import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";
const serverBinaryName = process.platform === "win32" ? "veslo-server.exe" : "veslo-server";

function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate a loopback port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForServer(baseUrl, child, logPath, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      break;
    }
    let requestTimeoutMs = 0;
    try {
      const controller = new AbortController();
      requestTimeoutMs = Math.min(2_000, Math.max(1, deadline - Date.now()));
      const requestTimeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      let response;
      try {
        response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
      } finally {
        clearTimeout(requestTimeout);
      }
      if (response.ok) return await response.json();
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error && error.name === "AbortError"
        ? `health request timed out after ${requestTimeoutMs}ms`
        : error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  const logs = await readFile(logPath, "utf8").catch(() => "");
  throw new Error(
    `Headless services did not reach ${baseUrl}/health within ${timeoutMs}ms: ${lastError}\n` +
      `orchestrator log (${logPath}):\n${logs.slice(-8_000)}`,
  );
}

async function stopChild(child, timeoutMs = 8_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const taskkill = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const exited = await Promise.race([
      once(child, "exit").then(() => true).catch(() => false),
      new Promise((resolveDelay) => setTimeout(() => resolveDelay(false), 2_000)),
    ]);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      throw new Error(
        `Failed to stop owned headless-services process tree (pid ${child.pid}; taskkill status ${taskkill.status ?? "unknown"})`,
      );
    }
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // The fallback below handles a process that has already detached or exited.
  }

  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolveDelay) => setTimeout(() => resolveDelay(false), timeoutMs)),
  ]);
  if (exited) return;

  try {
    child.kill("SIGKILL");
  } catch {
    // Ignore an already-exited child.
  }
  await Promise.race([
    once(child, "exit").catch(() => undefined),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
  ]);
}

async function closeOutput(output) {
  if (output.closed) return;
  output.end();
  await once(output, "close");
}

async function readExpectedOpenCodeVersion() {
  const packageJson = JSON.parse(await readFile(join(repoRoot, "packages/orchestrator/package.json"), "utf8"));
  return typeof packageJson.opencodeVersion === "string" ? packageJson.opencodeVersion : "1.17.13";
}

export async function createHeadlessServicesProfile() {
  const tempRoot = join(repoRoot, ".tmp");
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, "headless-services-"));
  const dataDir = join(root, "data");
  const workspace = join(root, "workspace");
  const token = randomUUID();
  const hostToken = randomUUID();
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(workspace, { recursive: true })]);

  let removed = false;
  return {
    root,
    dataDir,
    workspace,
    token,
    hostToken,
    async cleanup() {
      if (removed) return;
      removed = true;
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function startHeadlessServices({ fakeMode = "success", profile, aiGatewayBaseUrl } = {}) {
  const ownsProfile = !profile;
  const runtimeProfile = profile ?? await createHeadlessServicesProfile();
  const { root, dataDir, workspace, token, hostToken } = runtimeProfile;
  const runDirectory = randomUUID();
  const traceDir = join(root, "trace", runDirectory);
  const logDir = join(root, "logs", runDirectory);
  const orchestratorLog = join(logDir, "orchestrator.log");
  const fakeLog = join(traceDir, "fake-opencode.ndjson");
  const serverTrace = join(traceDir, "server.ndjson");
  const orchestratorTrace = join(traceDir, "orchestrator.ndjson");
  const serverBinary = join(repoRoot, "packages", "server", "dist", "bin", serverBinaryName);
  const fakeOpenCode = join(repoRoot, "scripts", "test-fixtures", "fake-opencode.js");
  const port = await findFreePort();
  const runId = `service-gate-${randomUUID()}`;

  await Promise.all([mkdir(traceDir, { recursive: true }), mkdir(logDir, { recursive: true })]);
  await access(serverBinary);
  await access(fakeOpenCode);

  const output = createWriteStream(orchestratorLog, { flags: "a" });
  const environment = {
    ...process.env,
    NO_COLOR: "1",
    VESLO_DATA_DIR: dataDir,
    VESLO_DISABLE_SANDBOX: "1",
    VESLO_SEND_WORKFLOW_TRACE: "1",
    VESLO_SEND_WORKFLOW_TRACE_SERVER_FILE: serverTrace,
    VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_FILE: orchestratorTrace,
    VESLO_SERVICE_TEST_FAKE_MODE: fakeMode,
    VESLO_SERVICE_TEST_FAKE_LOG: fakeLog,
    VESLO_SERVICE_TEST_OPENCODE_VERSION: await readExpectedOpenCodeVersion(),
    ...(aiGatewayBaseUrl ? { VESLO_AI_GATEWAY_BASE_URL: aiGatewayBaseUrl } : {}),
  };
  const child = spawn(
    bunCommand,
    [
      "src/cli.ts", "start",
      "--workspace", workspace,
      "--approval", "auto",
      "--allow-external",
      "--sidecar-source", "external",
      "--opencode-source", "external",
      "--veslo-server-bin", serverBinary,
      "--opencode-bin", fakeOpenCode,
      "--no-veslo-code-router",
      "--veslo-host", "127.0.0.1",
      "--veslo-port", String(port),
      "--veslo-token", token,
      "--veslo-host-token", hostToken,
      "--run-id", runId,
      "--log-format", "json",
    ],
    { cwd: join(repoRoot, "packages", "orchestrator"), env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl, child, orchestratorLog);
  } catch (error) {
    await stopChild(child);
    await closeOutput(output);
    throw error;
  }

  let closed = false;
  return {
    baseUrl,
    token,
    hostToken,
    workspace,
    root,
    logs: { orchestratorLog, fakeLog, serverTrace, orchestratorTrace },
    async close({ preserve = false } = {}) {
      if (closed) return;
      closed = true;
      await stopChild(child);
      await closeOutput(output);
      if (!preserve && ownsProfile) await runtimeProfile.cleanup();
    },
  };
}

export async function startHeadlessDaemonServices({ fakeMode = "success", profile, aiGatewayBaseUrl } = {}) {
  const ownsProfile = !profile;
  const runtimeProfile = profile ?? await createHeadlessServicesProfile();
  const { root, dataDir, workspace, token, hostToken } = runtimeProfile;
  const runDirectory = randomUUID();
  const traceDir = join(root, "trace", runDirectory);
  const logDir = join(root, "logs", runDirectory);
  const daemonLog = join(logDir, "orchestrator-daemon.log");
  const serverLog = join(logDir, "server.log");
  const fakeLog = join(traceDir, "fake-opencode.ndjson");
  const serverTrace = join(traceDir, "server.ndjson");
  const orchestratorTrace = join(traceDir, "orchestrator.ndjson");
  const serverBinary = join(repoRoot, "packages", "server", "dist", "bin", serverBinaryName);
  const fakeOpenCode = join(repoRoot, "scripts", "test-fixtures", "fake-opencode.js");
  const daemonPort = await findFreePort();
  const serverPort = await findFreePort();
  const workspaceId = `ws-service-${randomUUID()}`;
  const lifecycleToken = randomUUID();
  const opencodeUsername = "veslo-service-test";
  const opencodePassword = randomUUID();
  const runId = `service-gate-daemon-${randomUUID()}`;
  const serverDataDir = join(root, "server-data");

  await Promise.all([
    mkdir(traceDir, { recursive: true }),
    mkdir(logDir, { recursive: true }),
    mkdir(serverDataDir, { recursive: true }),
  ]);
  await access(serverBinary);
  await access(fakeOpenCode);

  const sharedEnvironment = {
    ...process.env,
    NO_COLOR: "1",
    VESLO_DISABLE_SANDBOX: "1",
    VESLO_SEND_WORKFLOW_TRACE: "1",
    VESLO_SEND_WORKFLOW_TRACE_SERVER_FILE: serverTrace,
    VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_FILE: orchestratorTrace,
    VESLO_SERVICE_TEST_FAKE_MODE: fakeMode,
    VESLO_SERVICE_TEST_FAKE_LOG: fakeLog,
    VESLO_SERVICE_TEST_OPENCODE_VERSION: await readExpectedOpenCodeVersion(),
    ...(aiGatewayBaseUrl ? { VESLO_AI_GATEWAY_BASE_URL: aiGatewayBaseUrl } : {}),
  };
  const daemonOutput = createWriteStream(daemonLog, { flags: "a" });
  const serverOutput = createWriteStream(serverLog, { flags: "a" });
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const daemonChild = spawn(
    bunCommand,
    [
      "src/cli.ts", "daemon", "run",
      "--data-dir", dataDir,
      "--daemon-host", "127.0.0.1",
      "--daemon-port", String(daemonPort),
      "--allow-external",
      "--sidecar-source", "external",
      "--opencode-source", "external",
      "--opencode-bin", fakeOpenCode,
      "--opencode-username", opencodeUsername,
      "--opencode-password", opencodePassword,
      "--lifecycle-token", lifecycleToken,
      "--run-id", runId,
      "--log-format", "json",
    ],
    {
      cwd: join(repoRoot, "packages", "orchestrator"),
      env: { ...sharedEnvironment, VESLO_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  daemonChild.stdout.pipe(daemonOutput, { end: false });
  daemonChild.stderr.pipe(daemonOutput, { end: false });

  let serverChild;
  try {
    await waitForServer(daemonUrl, daemonChild, daemonLog);
    serverChild = spawn(
      serverBinary,
      [
        "--host", "127.0.0.1",
        "--port", String(serverPort),
        "--workspace", workspace,
        "--workspace-id", workspaceId,
        "--token", token,
        "--host-token", hostToken,
        "--approval", "auto",
        "--orchestrator-url", daemonUrl,
        "--orchestrator-lifecycle-token", lifecycleToken,
        "--cors", "*",
        "--log-format", "json",
        "--no-log-requests",
      ],
      {
        cwd: repoRoot,
        env: { ...sharedEnvironment, VESLO_DATA_DIR: serverDataDir },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    serverChild.stdout.pipe(serverOutput, { end: false });
    serverChild.stderr.pipe(serverOutput, { end: false });
    await waitForServer(`http://127.0.0.1:${serverPort}`, serverChild, serverLog);
  } catch (error) {
    await stopChild(serverChild ?? daemonChild).catch(() => undefined);
    if (serverChild) await stopChild(daemonChild).catch(() => undefined);
    await Promise.all([closeOutput(daemonOutput), closeOutput(serverOutput)]);
    throw error;
  }

  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${serverPort}`,
    daemonUrl,
    token,
    hostToken,
    workspace,
    workspaceId,
    lifecycleToken,
    root,
    logs: {
      orchestratorLog: daemonLog,
      daemonLog,
      serverLog,
      fakeLog,
      serverTrace,
      orchestratorTrace,
    },
    async close({ preserve = false } = {}) {
      if (closed) return;
      closed = true;
      await stopChild(serverChild);
      await stopChild(daemonChild);
      await Promise.all([closeOutput(serverOutput), closeOutput(daemonOutput)]);
      if (!preserve && ownsProfile) await runtimeProfile.cleanup();
    },
  };
}
