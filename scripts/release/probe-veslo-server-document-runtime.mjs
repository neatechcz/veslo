import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const READY_PREFIX = "VESLO_SERVER_READY ";
const DEFAULT_TIMEOUT_MS = 20_000;
const UNREACHABLE_PACKAGE_FEED = "http://127.0.0.1:1/document-runtime-packages.json";

function usage() {
  return [
    "Usage: node scripts/release/probe-veslo-server-document-runtime.mjs --binary <path> [--timeout-ms <ms>] [--json]",
    "",
    "Starts a compiled veslo-server in an isolated temporary profile and verifies its document-runtime provider.",
  ].join("\n");
}

export function parseProbeArgs(argv) {
  const options = {
    binary: null,
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--binary") {
      const binary = argv[index + 1]?.trim();
      if (!binary) throw new Error("--binary requires a path.");
      options.binary = binary;
      index += 1;
      continue;
    }
    if (value.startsWith("--binary=")) {
      const binary = value.slice("--binary=".length).trim();
      if (!binary) throw new Error("--binary requires a path.");
      options.binary = binary;
      continue;
    }
    if (value === "--timeout-ms") {
      const timeoutMs = Number(argv[index + 1]);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
        throw new Error("--timeout-ms must be a positive number.");
      }
      options.timeoutMs = Math.floor(timeoutMs);
      index += 1;
      continue;
    }
    if (value.startsWith("--timeout-ms=")) {
      const timeoutMs = Number(value.slice("--timeout-ms=".length));
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
        throw new Error("--timeout-ms must be a positive number.");
      }
      options.timeoutMs = Math.floor(timeoutMs);
      continue;
    }
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--help" || value === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  if (!options.help && !options.binary) {
    throw new Error("--binary is required.");
  }
  return options;
}

async function resolveExecutablePath(input) {
  const absolute = resolve(input);
  const candidates = process.platform === "win32" && !absolute.toLowerCase().endsWith(".exe")
    ? [absolute, `${absolute}.exe`]
    : [absolute];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next platform-compatible suffix.
    }
  }
  throw new Error(`Compiled Veslo server binary does not exist: ${absolute}`);
}

function redact(value, secrets) {
  let output = String(value ?? "");
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

export function documentRuntimeSummary(payload) {
  return {
    status: typeof payload?.status === "string" ? payload.status : null,
    ready: typeof payload?.ready === "boolean" ? payload.ready : null,
    repair: {
      available: typeof payload?.repair?.available === "boolean" ? payload.repair.available : null,
      inProgress: typeof payload?.repair?.inProgress === "boolean" ? payload.repair.inProgress : null,
      blockedReason: typeof payload?.repair?.blockedReason === "string" ? payload.repair.blockedReason : null,
      lastError: typeof payload?.repair?.lastError === "string" ? payload.repair.lastError : null,
    },
  };
}

export function assertMissingDocumentRuntime(payload) {
  const summary = documentRuntimeSummary(payload);
  const providerUnavailable = summary.status === "blocked" ||
    summary.repair.blockedReason === "document_runtime_provider_unavailable" ||
    /cannot find module/i.test(summary.repair.lastError ?? "");

  if (providerUnavailable) {
    throw new Error(`Compiled server could not load the document-runtime provider: ${JSON.stringify(summary)}`);
  }
  if (summary.status !== "missing") {
    throw new Error(`Expected missing document runtime from an empty profile, received: ${JSON.stringify(summary)}`);
  }
  if (summary.repair.available !== true) {
    throw new Error(`Expected package repair to be available, received: ${JSON.stringify(summary)}`);
  }
  return summary;
}

export function assertPackageInstallStarted(payload) {
  const summary = documentRuntimeSummary(payload);
  if (summary.status !== "package_installing" || summary.repair.inProgress !== true) {
    throw new Error(`Expected package install to start without downloading a public package, received: ${JSON.stringify(summary)}`);
  }
  return summary;
}

function createIsolatedEnvironment({ root, clientToken, hostToken }) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VESLO_")) delete env[key];
  }

  const home = join(root, "home");
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    VESLO_DATA_DIR: join(root, "data"),
    VESLO_DOCUMENT_RUNTIME_ROOT: join(root, "document-runtime"),
    VESLO_DOCUMENT_RUNTIME_PACKAGE_FEED_URL: UNREACHABLE_PACKAGE_FEED,
    VESLO_TOKEN: clientToken,
    VESLO_HOST_TOKEN: hostToken,
  };
}

function waitForReady(child, output, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const inspect = () => {
      for (const line of output.stdout.split(/\r?\n/)) {
        if (!line.startsWith(READY_PREFIX)) continue;
        try {
          finish(resolvePromise, JSON.parse(line.slice(READY_PREFIX.length)));
          return;
        } catch (error) {
          finish(reject, new Error(`Could not parse VESLO_SERVER_READY descriptor: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
      }
    };
    const timeout = setTimeout(() => {
      finish(reject, new Error(`Timed out after ${timeoutMs}ms waiting for VESLO_SERVER_READY.`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      output.stdout += chunk.toString();
      inspect();
    });
    child.stderr?.on("data", (chunk) => {
      output.stderr += chunk.toString();
    });
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      finish(reject, new Error(`Server exited before readiness (code=${code ?? "null"}, signal=${signal ?? "null"}).`));
    });
  });
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(documentRuntimeSummary(payload))}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolvePromise(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolvePromise(true);
    };
    child.once("exit", onExit);
  });
}

async function stopChildProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 3_000)) return;

  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGKILL");
  }
  if (!(await waitForExit(child, 3_000))) {
    throw new Error(`Compiled document-runtime probe could not stop its own server process (pid=${child.pid ?? "unknown"}).`);
  }
}

export async function probeVesloServerDocumentRuntime({ binary, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const executablePath = await resolveExecutablePath(binary);
  const root = await mkdtemp(join(tmpdir(), "veslo-compiled-document-runtime-"));
  const clientToken = `probe-client-${randomUUID()}`;
  const hostToken = `probe-host-${randomUUID()}`;
  const output = { stdout: "", stderr: "" };
  let child;

  try {
    const configPath = join(root, "server.json");
    const cwd = join(root, "cwd");
    await mkdir(cwd, { recursive: true });
    child = spawn(
      executablePath,
      ["--config", configPath, "--host", "127.0.0.1", "--port", "0", "--token", clientToken, "--host-token", hostToken],
      {
        cwd,
        env: createIsolatedEnvironment({ root, clientToken, hostToken }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const descriptor = await waitForReady(child, output, timeoutMs);
    if (!descriptor || typeof descriptor.baseUrl !== "string") {
      throw new Error("Veslo server readiness descriptor did not contain baseUrl.");
    }
    const headers = { authorization: `Bearer ${clientToken}` };
    const statusPayload = await fetchJson(`${descriptor.baseUrl}/document-runtime/status`, { headers }, timeoutMs);
    const status = assertMissingDocumentRuntime(statusPayload);
    const repairPayload = await fetchJson(
      `${descriptor.baseUrl}/document-runtime/repair`,
      { method: "POST", headers },
      timeoutMs,
    );
    const repair = assertPackageInstallStarted(repairPayload);

    return {
      schemaVersion: 1,
      binary: executablePath,
      binaryName: basename(executablePath),
      status,
      repair,
    };
  } catch (error) {
    const details = [
      error instanceof Error ? error.message : String(error),
      output.stdout ? `stdout:\n${output.stdout}` : "",
      output.stderr ? `stderr:\n${output.stderr}` : "",
    ].filter(Boolean).join("\n");
    throw new Error(redact(details, [clientToken, hostToken]));
  } finally {
    await stopChildProcess(child);
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseProbeArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const report = await probeVesloServerDocumentRuntime(options);
  if (options.json) {
    console.log(JSON.stringify(report));
    return;
  }
  console.log(`Compiled document-runtime probe passed: ${report.binary}`);
  console.log(JSON.stringify({ status: report.status, repair: report.repair }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
