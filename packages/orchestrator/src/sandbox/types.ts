/**
 * F4U2 - WorkerSandbox abstraction.
 *
 * Per-platform sandbox impl builds a concrete child-process launch with
 * OS-level restrictions. macOS uses Anthropic `@anthropic-ai/sandbox-runtime`.
 * Windows WSL2 launches `wsl.exe` and enforces filesystem isolation inside WSL
 * with `bubblewrap`.
 */

type SandboxMount = {
  /** Absolute host path. Realpath-resolved before passing. */
  hostPath: string;
  /** Read-only mount. Default true; explicit RW must be confirmed by user. */
  readonly: boolean;
};

export type SandboxCommand = {
  /** Program requested by the caller before sandbox backend translation. */
  program: string;
  /** Program arguments, not shell-joined. */
  args: string[];
  /** Host cwd requested by the caller. */
  cwd: string;
  /** Environment requested by the caller. */
  env: NodeJS.ProcessEnv;
};

export type SandboxLaunch = {
  /** Final host command passed to child_process.spawn(). */
  command: string;
  /** Final host argv passed to child_process.spawn(). */
  args: string[];
  /** Final host cwd. Undefined lets Node inherit the current cwd. */
  cwd?: string;
  /** Final host env. Undefined lets Node inherit process.env. */
  env?: NodeJS.ProcessEnv;
  /** Redacted/loggable command description. */
  displayCommand?: string;
  /** Host process kind, used for lifecycle diagnostics. */
  childKind?: "direct" | "wsl";
  /** Host-reachable address for wildcard-bound guest processes. */
  connectHost?: string;
};

export type SandboxSpawnOptions = {
  /** Structured command to launch. Backends may translate it for their OS. */
  command: SandboxCommand;
  /** Primary workspace path (RW). `.git` under workspace becomes RO automatically. */
  workspacePath: string;
  /** Secondary mounts (reference folders from F5). Default RO. */
  extraMounts?: SandboxMount[];
  /**
   * Engine-specific extra writable paths (config dir, cache dir, /tmp area).
   * Not user-controlled - orchestrator picks them. RO mounts go via extraMounts.
   */
  additionalWritePaths?: string[];
  /** Paths denied for read (defaults from `blocked_defaults.ts`). */
  blockedReadPaths?: string[];
  /** Allow local-only HTTP bind (orchestrator <-> engine). Default true. */
  allowLocalBinding?: boolean;
  /** Allow PTY for interactive shell tool (vim, ssh). Default true. */
  allowPty?: boolean;
  /** Optional engine metadata for backends that need a platform-specific runtime. */
  engine?: {
    kind: "opencode";
    expectedVersion?: string;
  };
};

export interface WorkerSandbox {
  /** Build the final sandboxed child-process launch. */
  buildLaunch(opts: SandboxSpawnOptions): Promise<SandboxLaunch>;
  /** Platform support check. False = caller should refuse to spawn. */
  isAvailable(): boolean;
  /** Backend identifier for logs / telemetry. */
  readonly name: "mac-sandbox-exec" | "windows-wsl2" | "windows-job-object" | "stub";
}
