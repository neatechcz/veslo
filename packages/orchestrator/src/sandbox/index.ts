/**
 * F4 — Sandbox abstrakce.
 *
 * `resolveSandbox()` vybere backend podle platformy. Centralizovaný entry point
 * pro orchestrator engine spawn (`cli.ts spawnEngine` callback) a budoucí
 * non-engine spawn callers.
 */

import type { WorkerSandbox } from "./types.js";
import { MacSandboxExec } from "./mac-sandbox-exec.js";
import { WindowsJobObject, WindowsWsl2 } from "./windows-stubs.js";

export type { SandboxMount, SandboxSpawnOptions, WorkerSandbox } from "./types.js";
export { MacSandboxExec, WindowsWsl2, WindowsJobObject };
export { defaultBlockedReadPaths } from "./blocked-defaults.js";

export function resolveSandbox(): WorkerSandbox {
  if (process.platform === "darwin") return MacSandboxExec;
  if (process.platform === "win32") return WindowsWsl2; // fáze 7 dořeší
  throw new Error(
    `No sandbox backend for platform=${process.platform}. ` +
      "Mac MVP supports macOS only; Windows je fáze 7, Linux out of scope.",
  );
}
