import { afterEach, describe, expect, test } from "bun:test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";

import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";

const LIVE_ENABLED = process.env.VESLO_LIVE_WSL_NETWORK_TEST === "1";
const maybeDescribe = LIVE_ENABLED && process.platform === "win32" ? describe : describe.skip;

const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];
const tempDirs: string[] = [];
const childProcesses: ChildProcess[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    try {
      server?.stop(true);
    } catch {
      // best effort cleanup
    }
  }
  while (childProcesses.length > 0) {
    const child = childProcesses.pop();
    child?.kill("SIGTERM");
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

let runtimePromise: Promise<{ distro: string; bridgeHost: string }> | null = null;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function decodeCommandOutput(value: Buffer): string {
  const utf16 = value.toString("utf16le").replace(/\u0000/g, "").replace(/^\uFEFF/, "");
  const utf8 = value.toString("utf8").replace(/\u0000/g, "").replace(/^\uFEFF/, "");
  return utf16.trim().length >= utf8.trim().length ? utf16 : utf8;
}

function runCommand(file: string, args: string[], timeoutMs = 15_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: "buffer",
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = typeof (error as { code?: unknown } | null)?.code === "number"
          ? ((error as { code: number }).code)
          : error
            ? 1
            : 0;
        resolve({
          code,
          stdout: decodeCommandOutput(stdout as Buffer),
          stderr: decodeCommandOutput(stderr as Buffer),
        });
      },
    );
  });
}

async function runWsl(distro: string, script: string, timeoutMs = 15_000): Promise<CommandResult> {
  return runCommand("wsl.exe", ["-d", distro, "--exec", "sh", "-lc", script], timeoutMs);
}

async function findFreePort(host = "127.0.0.1"): Promise<number> {
  const probe = createServer();
  probe.listen(0, host);
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  await once(probe, "close");
  return port;
}

function createConfig(overrides: Partial<ServerConfig>): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    debugLogs: {
      enabled: false,
      ingestUrl: null,
      ingestToken: null,
      batchMaxEvents: 200,
      batchMaxBytes: 256 * 1024,
      spoolMaxBytes: 100 * 1024 * 1024,
      flushIntervalMs: 5000,
    },
    ...overrides,
  };
}

function parseWslDistros(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*?\s*/, "").trim())
    .filter(Boolean)
    .filter((line) => !/^name\s+state\s+version$/i.test(line));
}

async function resolveWslDistro(): Promise<string> {
  const list = await runCommand("wsl.exe", ["-l", "-q"], 15_000);
  if (list.code !== 0) {
    throw new Error(`wsl.exe -l -q failed: ${list.stderr || list.stdout}`);
  }
  const distros = parseWslDistros(list.stdout);
  const requested = process.env.VESLO_WSL_DISTRO?.trim();
  if (requested) {
    if (!distros.includes(requested)) {
      throw new Error(`VESLO_WSL_DISTRO=${requested} was not found. Available: ${distros.join(", ")}`);
    }
    return requested;
  }
  return distros.find((entry) => entry === "VesloSandbox") ?? distros[0] ?? "";
}

function normalizeIpv4Candidates(raw: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const match of raw.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const ip = match[0];
    if (ip.startsWith("127.") || ip === "0.0.0.0") continue;
    if (ip.split(".").some((part) => Number(part) > 255)) continue;
    if (seen.has(ip)) continue;
    seen.add(ip);
    candidates.push(ip);
  }
  return candidates;
}

async function candidateBridgeHostsFromWindows(): Promise<string[]> {
  const result = await runCommand(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      "Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias '*WSL*' | Select-Object -ExpandProperty IPAddress",
    ],
    15_000,
  );
  return result.code === 0 ? normalizeIpv4Candidates(result.stdout) : [];
}

async function candidateBridgeHostsFromWsl(distro: string): Promise<string[]> {
  const result = await runWsl(
    distro,
    [
      "{",
      "ip route show default 2>/dev/null | awk '/default/ {print $3; exit}';",
      "awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf 2>/dev/null;",
      "} | awk 'NF'",
    ].join(" "),
    10_000,
  );
  return result.code === 0 ? normalizeIpv4Candidates(result.stdout) : [];
}

async function canBindHost(host: string): Promise<boolean> {
  const probe = createServer();
  return await new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(0, host, () => {
      probe.close(() => resolve(true));
    });
  });
}

async function resolveBridgeHost(distro: string): Promise<string> {
  const candidates = [
    ...(await candidateBridgeHostsFromWsl(distro)),
    ...(await candidateBridgeHostsFromWindows()),
  ];
  const unique = [...new Set(candidates)];
  for (const candidate of unique) {
    if (await canBindHost(candidate)) return candidate;
  }
  throw new Error(`No bindable WSL bridge host found. Candidates: ${unique.join(", ") || "(none)"}`);
}

async function resolveRuntime(): Promise<{ distro: string; bridgeHost: string }> {
  runtimePromise ??= (async () => {
    const distro = await resolveWslDistro();
    if (!distro) throw new Error("No WSL distro is available.");
    const probe = await runWsl(distro, "printf ok", 15_000);
    if (probe.code !== 0 || probe.stdout.trim() !== "ok") {
      throw new Error(`WSL distro ${distro} is not runnable: ${probe.stderr || probe.stdout}`);
    }
    const bridgeHost = await resolveBridgeHost(distro);
    return { distro, bridgeHost };
  })();
  return runtimePromise;
}

async function waitForText(url: string, expected: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      latest = await response.text();
      if (response.ok && latest.includes(expected)) return;
    } catch (error) {
      latest = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url} to include ${expected}. Latest=${latest}`);
}

function windowsPathToWslMountPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const match = normalized.match(/^([a-zA-Z]):\/?(.*)$/);
  if (!match) throw new Error(`Cannot map Windows path to WSL mount path: ${path}`);
  return `/mnt/${match[1]!.toLowerCase()}/${match[2] ?? ""}`;
}

async function probeWslUrl(
  distro: string,
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 8_000,
): Promise<CommandResult> {
  const curlHeaders = Object.entries(headers)
    .map(([key, value]) => ` -H ${shellQuote(`${key}: ${value}`)}`)
    .join("");
  const wgetHeaders = Object.entries(headers)
    .map(([key, value]) => ` --header=${shellQuote(`${key}: ${value}`)}`)
    .join("");
  const script = [
    `URL=${shellQuote(url)}`,
    "if command -v curl >/dev/null 2>&1; then",
    `  curl --connect-timeout 2 --max-time 4 -fsS${curlHeaders} "$URL";`,
    "elif command -v wget >/dev/null 2>&1; then",
    `  wget --timeout=4 --tries=1 -q -O -${wgetHeaders} "$URL";`,
    "else",
    "  echo 'curl-or-wget-missing' >&2; exit 127;",
    "fi",
  ].join("\n");
  return runWsl(distro, script, timeoutMs);
}

maybeDescribe("live WSL bridge networking", () => {
  test("Windows can reach a localhost HTTP server running inside VesloSandbox", async () => {
    const { distro } = await resolveRuntime();
    const python = await runWsl(distro, "command -v python3 || command -v python", 10_000);
    if (python.code !== 0) {
      console.warn(`SKIP - ${distro} has no python interpreter for the Windows->WSL HTTP smoke.`);
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), "veslo-wsl-http-"));
    tempDirs.push(dir);
    const marker = `veslo-windows-to-wsl-${randomUUID()}`;
    await writeFile(join(dir, "marker.txt"), marker, "utf8");

    const port = await findFreePort();
    const wslDir = windowsPathToWslMountPath(dir);
    const command = [
      `cd ${shellQuote(wslDir)}`,
      `exec ${python.stdout.trim()} -m http.server ${port} --bind 127.0.0.1`,
    ].join(" && ");
    const child = spawn("wsl.exe", ["-d", distro, "--exec", "sh", "-lc", command], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    childProcesses.push(child);

    try {
      await waitForText(`http://127.0.0.1:${port}/marker.txt`, marker, 12_000);
    } finally {
      child.kill("SIGTERM");
      await runWsl(distro, `pkill -f ${shellQuote(`http.server ${port}`)} 2>/dev/null || true`, 5_000);
    }
  }, 20_000);

  test("WSL cannot reach the bridge IP when veslo-server is loopback-only", async () => {
    const { distro, bridgeHost } = await resolveRuntime();
    const port = await findFreePort();
    const server = startServer(createConfig({ host: "127.0.0.1", port }));
    servers.push(server);

    const primary = await fetch(`http://127.0.0.1:${port}/health`);
    expect(primary.status).toBe(200);

    const bridge = await probeWslUrl(distro, `http://${bridgeHost}:${port}/health`);
    expect(bridge.code).not.toBe(0);
  }, 20_000);

  test("WSL reaches veslo-server through the explicit bridge listener", async () => {
    const { distro, bridgeHost } = await resolveRuntime();
    const port = await findFreePort();
    const server = startServer(createConfig({ host: "127.0.0.1", bridgeHost, port }));
    servers.push(server);

    const primary = await fetch(`http://127.0.0.1:${port}/health`);
    expect(primary.status).toBe(200);

    const health = await probeWslUrl(distro, `http://${bridgeHost}:${port}/health`);
    expect(health.code).toBe(0);
    expect(health.stdout).toContain("client-token");

    const workspaces = await probeWslUrl(
      distro,
      `http://${bridgeHost}:${port}/workspaces`,
      { Authorization: "Bearer client-token" },
    );
    expect(workspaces.code).toBe(0);
    expect(JSON.parse(workspaces.stdout)).toEqual({ items: [], activeId: null });

    console.log(JSON.stringify({ distro, bridgeHost, port, wslToWindowsBridge: true }));
  }, 20_000);
});
