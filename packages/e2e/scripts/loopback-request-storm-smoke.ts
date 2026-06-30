import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  resolveLaunchTimeout,
  resolvePilotRuntimeDir,
  resolvePilotSocketPath,
  startApp,
  stopApp,
} from '../helpers/app-launcher.js';
import {
  ensurePilotReady,
  resolvePilotBinary,
} from '../helpers/pilot-runner.js';

type TcpSample = {
  sample: number;
  at: string;
  total: number;
  listening: number;
  established: number;
  timeWait: number;
  closeWait: number;
};

type SmokeResult = {
  ok: boolean;
  port: number;
  durationMs: number;
  sampleIntervalMs: number;
  startedAt: string;
  finishedAt: string;
  maxTotal: number;
  maxTimeWait: number;
  maxEstablished: number;
  brokerSnapshot: unknown;
  samples: TcpSample[];
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, got: ${trimmed}`);
  }
  return value;
}

function runPowerShellJson(script: string): Promise<unknown> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      script,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout?.on('data', (chunk: Uint8Array) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Uint8Array) => stderr.push(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      const output = Buffer.concat(stdout).toString().trim();
      if (code !== 0) {
        const error = Buffer.concat(stderr).toString().trim();
        reject(new Error(error || `PowerShell exited with code ${code}`));
        return;
      }
      try {
        resolveCommand(output ? JSON.parse(output) : null);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function samplePort(port: number, sample: number): Promise<TcpSample> {
  const script = [
    `$conns = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq ${port} -or $_.RemotePort -eq ${port} });`,
    `[pscustomobject]@{`,
    `  sample = ${sample};`,
    `  at = (Get-Date).ToUniversalTime().ToString("o");`,
    `  total = $conns.Count;`,
    `  listening = @($conns | Where-Object State -eq 'Listen').Count;`,
    `  established = @($conns | Where-Object State -eq 'Established').Count;`,
    `  timeWait = @($conns | Where-Object State -eq 'TimeWait').Count;`,
    `  closeWait = @($conns | Where-Object State -eq 'CloseWait').Count`,
    `} | ConvertTo-Json -Compress`,
  ].join(' ');
  return await runPowerShellJson(script) as TcpSample;
}

async function readBrokerSnapshot(options: {
  binary: string;
  socket: string;
  e2eRoot: string;
}): Promise<unknown> {
  const script = [
    `const snapshot = window.__vesloRequestBrokerSnapshot?.();`,
    `if (!snapshot || typeof snapshot !== 'object') { throw new Error('request broker snapshot unavailable'); }`,
    `console.log(JSON.stringify(snapshot));`,
    `snapshot;`,
  ].join('\n');
  return await new Promise((resolveSnapshot, reject) => {
    const child = spawn(options.binary, ['--socket', options.socket, 'eval', script], {
      cwd: options.e2eRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('tauri-pilot eval timed out while reading request broker snapshot'));
    }, Math.min(10_000, resolveLaunchTimeout()));
    child.stdout?.on('data', (chunk: Uint8Array) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Uint8Array) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      const output = Buffer.concat(stdout).toString().trim();
      if (code !== 0) {
        const error = Buffer.concat(stderr).toString().trim();
        reject(new Error(error || `tauri-pilot eval exited with ${code ?? signal}`));
        return;
      }
      const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'));
      if (!jsonLine) {
        reject(new Error(`request broker snapshot JSON was not printed; output=${output}`));
        return;
      }
      try {
        resolveSnapshot(JSON.parse(jsonLine));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function main() {
  const port = parsePositiveInt(process.env.E2E_VESLO_SERVER_PORT, 8787);
  const durationMs = parsePositiveInt(process.env.E2E_LOOPBACK_STORM_DURATION_MS, 10 * 60_000);
  const sampleIntervalMs = parsePositiveInt(process.env.E2E_LOOPBACK_STORM_SAMPLE_INTERVAL_MS, 10_000);
  const e2eRoot = resolve(join(import.meta.dirname, '..'));
  const binary = resolvePilotBinary();
  const socket = resolvePilotSocketPath({ runtimeDir: resolvePilotRuntimeDir() });
  const samples: TcpSample[] = [];
  const startedAt = new Date().toISOString();

  process.env.E2E_VESLO_SERVER_PORT = String(port);

  await startApp();
  try {
    await ensurePilotReady({ binary, socket, cwd: e2eRoot, timeoutMs: resolveLaunchTimeout() });

    const deadline = Date.now() + durationMs;
    let sample = 0;
    while (Date.now() <= deadline) {
      samples.push(await samplePort(port, sample));
      sample += 1;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(sampleIntervalMs, remainingMs)));
    }

    const brokerSnapshot = await readBrokerSnapshot({ binary, socket, e2eRoot });
    samples.push(await samplePort(port, sample));

    const result: SmokeResult = {
      ok: true,
      port,
      durationMs,
      sampleIntervalMs,
      startedAt,
      finishedAt: new Date().toISOString(),
      maxTotal: Math.max(...samples.map((entry) => entry.total), 0),
      maxTimeWait: Math.max(...samples.map((entry) => entry.timeWait), 0),
      maxEstablished: Math.max(...samples.map((entry) => entry.established), 0),
      brokerSnapshot,
      samples,
    };

    const outputPath = process.env.E2E_LOOPBACK_STORM_OUTPUT?.trim();
    if (outputPath) {
      writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    }
    console.log(JSON.stringify({
      ok: result.ok,
      port: result.port,
      durationMs: result.durationMs,
      samples: result.samples.length,
      maxTotal: result.maxTotal,
      maxTimeWait: result.maxTimeWait,
      maxEstablished: result.maxEstablished,
      brokerSnapshot: result.brokerSnapshot,
      outputPath: outputPath || null,
    }, null, 2));
  } finally {
    await stopApp();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
