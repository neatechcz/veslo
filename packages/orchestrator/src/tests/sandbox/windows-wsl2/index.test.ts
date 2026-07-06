import { describe, expect, test } from "bun:test";

import type { SandboxSpawnOptions } from "../../../sandbox/types.js";
import type { Wsl2Runtime } from "../../../sandbox/windows-wsl2/discovery.js";
import {
  buildWindowsWsl2Script,
  workspaceKey,
} from "../../../sandbox/windows-wsl2/index.js";
import type { WslOpencodeRuntime } from "../../../sandbox/windows-wsl2/runtime.js";

const runtime: Wsl2Runtime = {
  wslExe: "wsl.exe",
  distro: "VesloSandbox",
  kernel: "test",
  arch: "x86_64",
  bwrapPath: "/usr/bin/bwrap",
  localhostMode: "windows-localhost",
};

const opencode: WslOpencodeRuntime = {
  bin: "/usr/local/bin/opencode",
  binDir: "/usr/local/bin",
  source: "path",
  version: "1.17.13",
  expectedVersion: "1.17.13",
};

function spawnOptions(configDir: string): SandboxSpawnOptions {
  return {
    command: {
      program: "opencode",
      args: ["serve", "--hostname", "0.0.0.0", "--port", "12345"],
      cwd: "C:\\Users\\alice\\project",
      env: {
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_CLIENT: "veslo-orchestrator",
      },
    },
    workspacePath: "C:\\Users\\alice\\project",
    engine: {
      kind: "opencode",
      expectedVersion: "1.17.13",
    },
  };
}

describe("windows-wsl2 launch script", () => {
  test("salts the WSL engine cache key by host config dir", () => {
    const workspace = "C:\\Users\\alice\\project";

    expect(workspaceKey(workspace, "C:\\data\\one")).not.toBe(
      workspaceKey(workspace, "C:\\data\\two"),
    );
  });

  test("copies project config and binds managed dependency dirs read-only", () => {
    const script = buildWindowsWsl2Script(
      spawnOptions("C:\\Users\\alice\\.veslo\\opencode-config\\ws-a"),
      runtime,
      opencode,
    );

    expect(script).toContain('--bind "$CONFIG_DIR" /config');
    expect(script).toContain('cp "$HOST_CONFIG_DIR/$config_name" "$CONFIG_DIR/$config_name"');
    expect(script).toContain('BWRAP_ARGS+=(--ro-bind "$HOST_CONFIG_DIR/$config_name" "/config/$config_name")');
    expect(script).toContain('--ro-bind "$HOST_CONFIG_DIR/tools" /config/tools');
    expect(script).toContain('--ro-bind "$HOST_CONFIG_DIR/node_modules" /config/node_modules');
    expect(script).not.toContain('cp -a "$src" "$stage"');
  });

  test("binds the resolv.conf symlink target so DNS works inside bwrap", () => {
    const script = buildWindowsWsl2Script(
      spawnOptions("C:\\Users\\alice\\.veslo\\opencode-config\\ws-a"),
      runtime,
      opencode,
    );

    expect(script).toContain('RESOLV_TARGET="$(readlink -f /etc/resolv.conf');
    expect(script).toContain('add_target_parent_dirs "$RESOLV_TARGET"');
    expect(script).toContain('BWRAP_ARGS+=(--ro-bind "$RESOLV_TARGET" "$RESOLV_TARGET")');
    // Targets already covered by the base /etc and /usr style mounts must not
    // be re-bound (the case statement skips them).
    expect(script).toContain("/etc/*|/usr/*|/bin/*|/lib/*|/lib64/*) ;;");
  });
});
