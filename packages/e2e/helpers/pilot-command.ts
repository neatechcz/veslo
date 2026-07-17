import { spawn } from 'node:child_process';

import { createRedactingLineBuffer } from './pilot-redaction.js';

export type BuildPilotCommandOptions = {
  binary: string;
  socket: string;
  args: string[];
};

export type PilotCommandExecutionOptions = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  inheritStdio?: boolean;
};

export type PilotCommandResult = {
  command: string;
  args: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error: string | null;
};

export function buildPilotCommand(options: BuildPilotCommandOptions): { command: string; args: string[] } {
  return {
    command: options.binary,
    args: ['--socket', options.socket, ...options.args],
  };
}

export function pilotCommandSucceeded(result: PilotCommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.error;
}

export async function executePilotCommand(options: PilotCommandExecutionOptions): Promise<PilotCommandResult> {
  const startedAt = new Date();
  return await new Promise<PilotCommandResult>((resolveCommand) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const stdoutRedactor = createRedactingLineBuffer();
    const stderrRedactor = createRedactingLineBuffer();
    let timeout: NodeJS.Timeout | null = null;
    let timedOut = false;
    let settled = false;

    const flushInheritedOutput = () => {
      if (!options.inheritStdio) return;
      const safeStdout = stdoutRedactor.flush();
      const safeStderr = stderrRedactor.flush();
      if (safeStdout) process.stdout.write(safeStdout);
      if (safeStderr) process.stderr.write(safeStderr);
    };

    const finish = (result: Omit<PilotCommandResult, 'command' | 'args' | 'startedAt' | 'finishedAt' | 'durationMs' | 'stdout' | 'stderr'>) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      flushInheritedOutput();
      const finishedAt = new Date();
      resolveCommand({
        command: options.command,
        args: options.args,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        ...result,
      });
    };

    child.stdout?.on('data', (chunk: Uint8Array) => {
      stdout.push(chunk);
      if (options.inheritStdio) {
        const safeOutput = stdoutRedactor.push(Buffer.from(chunk).toString('utf8'));
        if (safeOutput) process.stdout.write(safeOutput);
      }
    });
    child.stderr?.on('data', (chunk: Uint8Array) => {
      stderr.push(chunk);
      if (options.inheritStdio) {
        const safeOutput = stderrRedactor.push(Buffer.from(chunk).toString('utf8'));
        if (safeOutput) process.stderr.write(safeOutput);
      }
    });

    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
      }, options.timeoutMs);
    }

    child.on('error', (error) => {
      finish({
        exitCode: null,
        signal: null,
        timedOut,
        error: error.message,
      });
    });
    child.on('close', (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        timedOut,
        error: null,
      });
    });
  });
}
