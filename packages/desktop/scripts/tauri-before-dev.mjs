import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const readPort = () => {
  const value = Number.parseInt(process.env.PORT ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : 5173;
};

const hostOverride = process.env.OPENWORK_DEV_HOST?.trim() || null;
const port = readPort();
const baseUrls = (hostOverride ? [hostOverride] : ["127.0.0.1", "localhost"]).map((host) => `http://${host}:${port}`);

const fetchWithTimeout = async (url, { timeoutMs = 1200 } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
};

const portHasHttpServer = async (baseUrl) => {
  try {
    await fetchWithTimeout(baseUrl, { timeoutMs: 900 });
    return true;
  } catch {
    return false;
  }
};

const looksLikeVite = async (baseUrl) => {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/@vite/client`, { timeoutMs: 1200 });
    if (!res.ok) return false;

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("javascript")) return true;

    const body = await res.text();
    return body.includes("import.meta.hot") || body.includes("@vite/client");
  } catch {
    return false;
  }
};

const waitForever = async () => {
  await new Promise((resolvePromise) => {
    const stop = () => resolvePromise();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
};

const runPrepareSidecars = () => {
  const prepareScript = resolve(fileURLToPath(new URL("./prepare-sidecar.mjs", import.meta.url)));
  const args = [prepareScript];
  if (process.env.OPENWORK_SIDECAR_FORCE_BUILD !== "0") {
    args.push("--force");
  }
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const runUiDevServer = () => {
  const child = spawn(pnpmCmd, ["-w", "dev:ui"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      // Make sure vite sees the intended port.
      PORT: String(port),
    },
  });

  const forwardSignal = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) process.exit(0);
    process.exit(code ?? 0);
  });
};

runPrepareSidecars();

let detectedViteUrl = null;
for (const candidate of baseUrls) {
  if (await looksLikeVite(candidate)) {
    detectedViteUrl = candidate;
    break;
  }
}

if (detectedViteUrl) {
  console.log(`[openwork] UI dev server already running at ${detectedViteUrl} (reusing).`);
  await waitForever();
  process.exit(0);
}

let portInUse = false;
for (const candidate of baseUrls) {
  if (await portHasHttpServer(candidate)) {
    portInUse = true;
    break;
  }
}

if (portInUse) {
  console.error(
    `[openwork] Port ${port} is in use, but it does not look like a Vite dev server.\n` +
      `Set PORT to a free port (e.g. PORT=5174) or stop the process using port ${port}.`
  );
  process.exit(1);
}

console.log(`[openwork] Starting UI dev server on port ${port}...`);
runUiDevServer();
await waitForever();
