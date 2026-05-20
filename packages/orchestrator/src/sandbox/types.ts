/**
 * F4Ú2 — WorkerSandbox abstraction.
 *
 * Per-platform sandbox impl wraps an arbitrary shell command with OS-level
 * restrictions. macOS uses Anthropic `@anthropic-ai/sandbox-runtime` (sekce 11
 * v `docs/design/vslo-86-process-sandbox-multiplatform.md`). Windows stub panics
 * (fáze 7).
 */

export type SandboxMount = {
  /** Absolute host path. Realpath-resolved before passing. */
  hostPath: string;
  /** Read-only mount. Default true; explicit RW must be confirmed by user. */
  readonly: boolean;
};

export type SandboxSpawnOptions = {
  /** Shell command to wrap (`/bin/sh -c <wrapped>` is responsibility of caller). */
  command: string;
  /** Primary workspace path (RW). `.git` ⊂ workspace becomes RO automatically. */
  workspacePath: string;
  /** Secondary mounts (reference folders from F5). Default RO. */
  extraMounts?: SandboxMount[];
  /** Paths denied for read (defaults from `blocked_defaults.ts`). */
  blockedReadPaths?: string[];
  /** Allow local-only HTTP bind (orchestrator ↔ engine). Default true. */
  allowLocalBinding?: boolean;
  /** Allow PTY for interactive shell tool (vim, ssh). Default true. */
  allowPty?: boolean;
};

export interface WorkerSandbox {
  /**
   * Wrap a shell command for sandboxed execution. Returns the wrapped command
   * string to be passed to `spawn("/bin/sh", ["-c", wrapped])`.
   */
  wrap(opts: SandboxSpawnOptions): Promise<string>;
  /** Platform support check. False = caller should refuse to spawn. */
  isAvailable(): boolean;
  /** Backend identifier for logs / telemetry. */
  readonly name: "mac-sandbox-exec" | "windows-wsl2" | "windows-job-object" | "stub";
}
