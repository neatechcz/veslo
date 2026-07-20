/**
 * F4 - Sandbox abstraction.
 *
 * `resolveSandbox()` selects the backend for orchestrator engine spawn and
 * future non-engine spawn callers.
 */

import type { WorkerSandbox } from "./types.js";
import { envFlagEnabled } from "../engine-topology.js";
import { MacSandboxExec } from "./mac-sandbox-exec.js";
import { WindowsWsl2 } from "./windows-wsl2/index.js";
import { WindowsJobObject } from "./windows-stubs.js";

export const LEGACY_WINDOWS_WSL_SANDBOX_ENV = "VESLO_ENABLE_LEGACY_WINDOWS_WSL_SANDBOX";

export type {
  SandboxCommand,
  SandboxLaunch,
  SandboxMount,
  SandboxSpawnOptions,
  WorkerSandbox,
} from "./types.js";
export { MacSandboxExec, WindowsWsl2, WindowsJobObject };
export { defaultBlockedReadPaths } from "./blocked-defaults.js";

export function resolveSandbox(input: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
} = {}): WorkerSandbox {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  if (platform === "darwin") return MacSandboxExec;
  if (platform === "win32") {
    if (envFlagEnabled(env[LEGACY_WINDOWS_WSL_SANDBOX_ENV])) return WindowsWsl2;
    throw new Error(
      `Windows WSL2 sandbox is disabled. Set ${LEGACY_WINDOWS_WSL_SANDBOX_ENV}=1 only for legacy developer diagnostics.`,
    );
  }
  throw new Error(
    `No sandbox backend for platform=${platform}. macOS is the supported sandbox host.`,
  );
}
