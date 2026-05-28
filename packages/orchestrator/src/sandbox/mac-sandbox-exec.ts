/**
 * F4Ú2 — macOS sandbox impl (Anthropic sandbox-runtime).
 *
 * Wraps shell commands with kernel-level `sandbox-exec` profile. Per-call config
 * lets us serve multiple workspaces from one SandboxManager singleton (Anthropic
 * lib `wrapWithSandbox` accepts `customConfig: Partial<SandboxRuntimeConfig>`).
 *
 * Initialize lazily on first wrap; idempotent. `.git` ⊂ workspace becomes RO
 * automatically (F4Ú5).
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { defaultBlockedReadPaths } from "./blocked-defaults.js";
import { commandToShellString } from "./launch.js";
import type { SandboxLaunch, SandboxSpawnOptions, WorkerSandbox } from "./types.js";

let initialized = false;

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  const bootstrapConfig: SandboxRuntimeConfig = {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead: defaultBlockedReadPaths(),
      allowWrite: [],
      denyWrite: [],
    },
    allowPty: true,
  };
  await SandboxManager.initialize(bootstrapConfig);
  initialized = true;
}

function gitDirIfPresent(workspacePath: string): string | null {
  const candidate = join(workspacePath, ".git");
  try {
    if (existsSync(candidate)) return candidate;
  } catch {
    // ignore
  }
  return null;
}

function buildConfig(opts: SandboxSpawnOptions): SandboxRuntimeConfig {
  const allowWrite: string[] = [opts.workspacePath, ...(opts.additionalWritePaths ?? [])];
  const denyWrite: string[] = [];
  const denyRead: string[] = [
    ...defaultBlockedReadPaths(),
    ...(opts.blockedReadPaths ?? []),
  ];

  // F4Ú5 — .git inside workspace is always RO (agent must not commit silently).
  const gitDir = gitDirIfPresent(opts.workspacePath);
  if (gitDir) denyWrite.push(gitDir);

  for (const mount of opts.extraMounts ?? []) {
    if (!mount.readonly) allowWrite.push(mount.hostPath);
    // RO mounts are reachable for read by default (not in denyRead).
    // Caller is responsible for ensuring hostPath is not inside denyRead list.
    if (mount.readonly) denyWrite.push(mount.hostPath);
  }

  return {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: opts.allowLocalBinding ?? true,
    },
    filesystem: {
      denyRead,
      allowWrite,
      denyWrite,
    },
    allowPty: opts.allowPty ?? true,
  };
}

export const MacSandboxExec: WorkerSandbox = {
  name: "mac-sandbox-exec",
  isAvailable: () => process.platform === "darwin",
  async buildLaunch(opts: SandboxSpawnOptions): Promise<SandboxLaunch> {
    if (!MacSandboxExec.isAvailable()) {
      throw new Error("MacSandboxExec is macOS-only (current: " + process.platform + ")");
    }
    if (!opts.workspacePath) {
      throw new Error("MacSandboxExec.buildLaunch requires workspacePath");
    }
    try {
      const root = statSync(opts.workspacePath);
      if (!root.isDirectory()) {
        throw new Error("workspacePath is not a directory: " + opts.workspacePath);
      }
    } catch (err) {
      throw new Error("workspacePath stat failed: " + (err instanceof Error ? err.message : String(err)));
    }
    await ensureInitialized();
    const customConfig = buildConfig(opts);
    const wrapped = await SandboxManager.wrapWithSandbox(
      commandToShellString(opts.command),
      undefined,
      customConfig,
    );
    return {
      command: "/bin/sh",
      args: ["-c", wrapped],
      cwd: opts.command.cwd,
      env: opts.command.env,
      displayCommand: wrapped,
      childKind: "direct",
    };
  },
};
