import { createHash } from "node:crypto";
import { basename, posix } from "node:path";
import { shellQuote } from "../launch.js";
import type { SandboxLaunch, SandboxSpawnOptions, WorkerSandbox } from "../types.js";
import { discoverWsl2Runtime, runWslInDistro, type Wsl2Runtime } from "./discovery.js";
import { isWslMappableWindowsPath, windowsPathToWslPath } from "./paths.js";
import { resolveWslOpencodeRuntime, type WslOpencodeRuntime } from "./runtime.js";

export function workspaceKey(workspacePath: string, hostConfigDir: string | null): string {
  return createHash("sha1")
    .update(workspacePath)
    .update("\0")
    .update(hostConfigDir ?? "")
    .digest("hex")
    .slice(0, 12);
}

function buildBashArray(name: string, values: string[]): string {
  return `${name}=(${values.map(shellQuote).join(" ")})`;
}

function isCoveredByBaseMount(path: string): boolean {
  return (
    path.startsWith("/usr/") ||
    path.startsWith("/bin/") ||
    path.startsWith("/lib/") ||
    path.startsWith("/lib64/") ||
    path === "/usr" ||
    path === "/bin" ||
    path === "/lib" ||
    path === "/lib64"
  );
}

function runtimeCommandForSandbox(runtime: WslOpencodeRuntime): {
  bin: string;
  extraBindScript: string[];
} {
  if (isCoveredByBaseMount(runtime.bin)) {
    return { bin: runtime.bin, extraBindScript: [] };
  }
  const runtimeTarget = "/runtime";
  return {
    bin: posix.join(runtimeTarget, basename(runtime.bin)),
    extraBindScript: [
      `BWRAP_ARGS+=(--dir ${shellQuote(runtimeTarget)})`,
      `BWRAP_ARGS+=(--ro-bind ${shellQuote(runtime.binDir)} ${shellQuote(runtimeTarget)})`,
    ],
  };
}

function hostConfigDirFromOptions(opts: SandboxSpawnOptions): string | null {
  const value = opts.command.env.OPENCODE_CONFIG_DIR;
  if (!value || !isWslMappableWindowsPath(value)) return null;
  return windowsPathToWslPath(value);
}

const SANDBOX_ENV_BASE = [
  "HOME",
  "/home/veslo",
  "PATH",
  "/home/veslo/.local/bin:/home/veslo/.bun/bin:/home/veslo/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "OPENCODE_CONFIG_DIR",
  "/config",
  "XDG_CONFIG_HOME",
  "/home/veslo/.config",
  "XDG_CACHE_HOME",
  "/home/veslo/.cache",
  "XDG_DATA_HOME",
  "/home/veslo/.local/share",
  "XDG_STATE_HOME",
  "/home/veslo/.local/state",
];

const SANDBOX_ENV_PASSTHROUGH = [
  "OPENCODE_CLIENT",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_HOT_RELOAD",
  "OPENCODE_HOT_RELOAD_DEBOUNCE_MS",
  "OPENCODE_HOT_RELOAD_COOLDOWN_MS",
  "OPENCODE_ROUTER_HEALTH_PORT",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "VESLO",
  "VESLO_LOG_FORMAT",
  "VESLO_RUN_ID",
];

function sandboxEnvArgs(env: NodeJS.ProcessEnv): string[] {
  const args = [...SANDBOX_ENV_BASE];
  for (const name of SANDBOX_ENV_PASSTHROUGH) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      args.push(name, value);
    }
  }
  return args;
}

async function assertWslDirectory(runtime: Wsl2Runtime, path: string, label: string): Promise<void> {
  const result = await runWslInDistro(runtime.distro, `test -d ${shellQuote(path)}`, 5000);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `${label} is not visible inside WSL distro '${runtime.distro}': ${path}` +
        (detail ? `\n${detail}` : ""),
    );
  }
}

export function buildWindowsWsl2Script(opts: SandboxSpawnOptions, runtime: Wsl2Runtime, opencode: WslOpencodeRuntime): string {
  if (opts.engine?.kind !== "opencode") {
    throw new Error("WindowsWsl2 currently supports only the OpenCode engine sandbox.");
  }

  const workspace = windowsPathToWslPath(opts.workspacePath);
  const hostConfigDir = hostConfigDirFromOptions(opts);
  const key = workspaceKey(opts.workspacePath, hostConfigDir);
  const sandboxRuntime = runtimeCommandForSandbox(opencode);
  const envArgs = sandboxEnvArgs(opts.command.env);

  return [
    "set -euo pipefail",
    'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
    `WORKSPACE=${shellQuote(workspace)}`,
    `HOST_CONFIG_DIR=${hostConfigDir ? shellQuote(hostConfigDir) : "''"}`,
    `ENGINE_BASE="$HOME/.veslo/engines/${key}"`,
    `ENGINE_HOME="$ENGINE_BASE/home"`,
    'CONFIG_DIR="$ENGINE_BASE/config"',
    `BWRAP_BIN=${shellQuote(runtime.bwrapPath)}`,
    `OPENCODE_BIN=${shellQuote(sandboxRuntime.bin)}`,
    "mkdir -p \"$CONFIG_DIR\" \"$ENGINE_HOME/.config\" \"$ENGINE_HOME/.cache\" \"$ENGINE_HOME/.local/share\" \"$ENGINE_HOME/.local/state\"",
    buildBashArray("CMD_ARGS", opts.command.args),
    buildBashArray("SETENV_ARGS", envArgs),
    "add_target_parent_dirs() {",
    "  local target=\"$1\"",
    "  local dir current part",
    "  dir=\"$(dirname \"$target\")\"",
    "  current=\"\"",
    "  IFS='/' read -r -a parts <<< \"${dir#/}\"",
    "  for part in \"${parts[@]}\"; do",
    "    [ -z \"$part\" ] && continue",
    "    current=\"$current/$part\"",
    "    BWRAP_ARGS+=(--dir \"$current\")",
    "  done",
    "}",
    "BWRAP_ARGS=(",
    "  --new-session",
    "  --die-with-parent",
    "  --unshare-user",
    "  --unshare-pid",
    "  --unshare-ipc",
    "  --unshare-uts",
    "  --cap-drop ALL",
    "  --proc /proc",
    "  --dev /dev",
    "  --tmpfs /tmp",
    "  --tmpfs /run",
    "  --ro-bind /usr /usr",
    "  --ro-bind-try /bin /bin",
    "  --ro-bind-try /lib /lib",
    "  --ro-bind-try /lib64 /lib64",
    "  --ro-bind /etc /etc",
    "  --dir /workspace",
    "  --bind \"$WORKSPACE\" /workspace",
    "  --dir /config",
    "  --bind \"$CONFIG_DIR\" /config",
    "  --dir /home",
    "  --dir /home/veslo",
    "  --bind \"$ENGINE_HOME\" /home/veslo",
    "  --chdir /workspace",
    ")",
    "if [ -n \"$HOST_CONFIG_DIR\" ] && [ -d \"$HOST_CONFIG_DIR/tools\" ]; then",
    "  mkdir -p \"$CONFIG_DIR/tools\"",
    "  BWRAP_ARGS+=(--ro-bind \"$HOST_CONFIG_DIR/tools\" /config/tools)",
    "fi",
    "if [ -n \"$HOST_CONFIG_DIR\" ] && [ -d \"$HOST_CONFIG_DIR/node_modules\" ]; then",
    "  mkdir -p \"$CONFIG_DIR/node_modules\"",
    "  BWRAP_ARGS+=(--ro-bind \"$HOST_CONFIG_DIR/node_modules\" /config/node_modules)",
    "fi",
    "if [ -d \"$WORKSPACE/.git\" ]; then",
    "  BWRAP_ARGS+=(--ro-bind \"$WORKSPACE/.git\" /workspace/.git)",
    "elif [ -f \"$WORKSPACE/.git\" ]; then",
    "  BWRAP_ARGS+=(--ro-bind \"$WORKSPACE/.git\" /workspace/.git)",
    "  GITDIR_LINE=\"$(sed -n 's/^gitdir: //p' \"$WORKSPACE/.git\" | head -n1 || true)\"",
    "  if [ -n \"$GITDIR_LINE\" ]; then",
    "    case \"$GITDIR_LINE\" in",
    "      /*) GITDIR=\"$GITDIR_LINE\" ;;",
    "      *) GITDIR=\"$(realpath \"$WORKSPACE/$GITDIR_LINE\")\" ;;",
    "    esac",
    "    if [ -e \"$GITDIR\" ]; then",
    "      add_target_parent_dirs \"$GITDIR\"",
    "      BWRAP_ARGS+=(--ro-bind \"$GITDIR\" \"$GITDIR\")",
    "    fi",
    "  fi",
    "fi",
    ...sandboxRuntime.extraBindScript,
    "for ((i=0; i<${#SETENV_ARGS[@]}; i+=2)); do",
    "  BWRAP_ARGS+=(--setenv \"${SETENV_ARGS[$i]}\" \"${SETENV_ARGS[$i+1]}\")",
    "done",
    "exec \"$BWRAP_BIN\" \"${BWRAP_ARGS[@]}\" -- \"$OPENCODE_BIN\" \"${CMD_ARGS[@]}\"",
  ].join("\n");
}

export const WindowsWsl2: WorkerSandbox = {
  name: "windows-wsl2",
  isAvailable: () => process.platform === "win32",
  async buildLaunch(opts: SandboxSpawnOptions): Promise<SandboxLaunch> {
    if (process.platform !== "win32") {
      throw new Error(`WindowsWsl2 is Windows-only (current platform: ${process.platform}).`);
    }
    if (!isWslMappableWindowsPath(opts.workspacePath)) {
      throw new Error(`Workspace path cannot be mounted into WSL2: ${opts.workspacePath}`);
    }

    const runtime = await discoverWsl2Runtime();
    const workspaceWslPath = windowsPathToWslPath(opts.workspacePath);
    await assertWslDirectory(runtime, workspaceWslPath, "Workspace path");
    const opencode = await resolveWslOpencodeRuntime(runtime, opts.engine?.expectedVersion);
    const script = buildWindowsWsl2Script(opts, runtime, opencode);
    return {
      command: runtime.wslExe,
      args: ["-d", runtime.distro, "--exec", "bash", "-c", script],
      env: opts.command.env,
      displayCommand: `wsl.exe -d ${runtime.distro} --exec bash -c <veslo-wsl2-bwrap-opencode>`,
      childKind: "wsl",
      connectHost: runtime.wslIp,
    };
  },
};
