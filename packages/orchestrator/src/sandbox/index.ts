/**
 * F4 - Sandbox abstraction.
 *
 * `resolveSandbox()` selects the backend for orchestrator engine spawn and
 * future non-engine spawn callers.
 */

import type { WorkerSandbox } from "./types.js";
import { MacSandboxExec } from "./mac-sandbox-exec.js";
import { WindowsWsl2 } from "./windows-wsl2/index.js";
import { WindowsJobObject } from "./windows-stubs.js";

export type {
  SandboxCommand,
  SandboxLaunch,
  SandboxMount,
  SandboxSpawnOptions,
  WorkerSandbox,
} from "./types.js";
export { MacSandboxExec, WindowsWsl2, WindowsJobObject };
export { defaultBlockedReadPaths } from "./blocked-defaults.js";

export function resolveSandbox(): WorkerSandbox {
  if (process.platform === "darwin") return MacSandboxExec;
  if (process.platform === "win32") return WindowsWsl2;
  throw new Error(
    `No sandbox backend for platform=${process.platform}. ` +
      "macOS and Windows WSL2 are supported sandbox hosts.",
  );
}
