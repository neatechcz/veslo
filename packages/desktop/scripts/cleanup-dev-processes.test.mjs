import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupStaleDevProcesses,
  findStaleDevProcesses,
  isPathInside,
  looksLikeVesloServerWatcher,
  stopProcesses,
} from "./cleanup-dev-processes.mjs";

const targetDebugDir = "C:\\repo\\packages\\desktop\\src-tauri\\target\\debug";
const sidecarsDir = "C:\\repo\\packages\\desktop\\src-tauri\\sidecars";

test("isPathInside scopes process executable paths to the checkout", () => {
  assert.equal(isPathInside("C:\\repo\\packages\\desktop\\src-tauri\\target\\debug\\veslo.exe", targetDebugDir), true);
  assert.equal(isPathInside("C:\\other\\target\\debug\\veslo.exe", targetDebugDir), false);
});

test("looksLikeVesloServerWatcher matches Bun dev server command lines without exposing tokens", () => {
  assert.equal(
    looksLikeVesloServerWatcher('"bun" --watch src/cli.ts -- --host 0.0.0.0 --host-token secret --approval auto'),
    true,
  );
  assert.equal(looksLikeVesloServerWatcher('"bun" --watch other.ts -- --host-token secret --approval auto'), false);
});

test("findStaleDevProcesses includes repo sidecars and related Bun watcher family on 8787", () => {
  const processes = [
    {
      ProcessId: 10,
      ParentProcessId: 1,
      Name: "veslo-code-router.exe",
      ExecutablePath: `${targetDebugDir}\\veslo-code-router.exe`,
      CommandLine: `"${targetDebugDir}\\veslo-code-router.exe" serve`,
    },
    {
      ProcessId: 20,
      ParentProcessId: 99,
      Name: "bun.exe",
      ExecutablePath: "C:\\tools\\bun.exe",
      CommandLine: '"bun" --watch src/cli.ts -- --host 0.0.0.0 --host-token secret --approval auto',
    },
    {
      ProcessId: 21,
      ParentProcessId: 20,
      Name: "bun.exe",
      ExecutablePath: "C:\\tools\\bun.exe",
      CommandLine: '"bun" --watch src/cli.ts -- --host 0.0.0.0 --host-token secret --approval auto',
    },
    {
      ProcessId: 30,
      ParentProcessId: 1,
      Name: "node.exe",
      ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
      CommandLine: "vite --host 127.0.0.1",
    },
  ];

  const stale = findStaleDevProcesses(processes, [{ OwningProcess: 21, LocalPort: 8787 }], {
    targetDebugDir,
    sidecarsDir,
  });

  assert.deepEqual(
    stale.map((item) => item.pid),
    [10, 20, 21],
  );
});

test("findStaleDevProcesses includes recursive Chrome MCP children by vendored package command line", () => {
  const processes = [
    {
      ProcessId: 40,
      ParentProcessId: 10,
      Name: "chrome-devtools-mcp.exe",
      ExecutablePath: "",
      CommandLine: `"${targetDebugDir}\\chrome-devtools-mcp.exe" "${targetDebugDir}\\chrome-devtools-mcp-package\\build\\src\\telemetry\\watchdog\\main.js" --parent-pid=10`,
    },
    {
      ProcessId: 41,
      ParentProcessId: 1,
      Name: "chrome-devtools-mcp.exe",
      ExecutablePath: "",
      CommandLine: '"C:\\other\\chrome-devtools-mcp.exe" "C:\\other\\chrome-devtools-mcp-package\\build\\src\\telemetry\\watchdog\\main.js"',
    },
  ];

  const stale = findStaleDevProcesses(processes, [], {
    targetDebugDir,
    sidecarsDir,
  });

  assert.deepEqual(stale.map((item) => item.pid), [40]);
  assert.equal(stale[0]?.reason, "repo Chrome DevTools MCP package command line");
});

test("stopProcesses tolerates Windows process cleanup races", () => {
  const commands = [];
  const warnings = [];

  assert.doesNotThrow(() => {
    stopProcesses(
      [10, 20],
      (command) => {
        commands.push(command);
        if (command.includes("-Id 10 ")) {
          throw new Error("PowerShell command failed");
        }
        return "";
      },
      (message) => warnings.push(message),
    );
  });

  assert.deepEqual(commands, [
    "Stop-Process -Id 10 -Force -ErrorAction SilentlyContinue",
    "Stop-Process -Id 20 -Force -ErrorAction SilentlyContinue",
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Failed to stop stale process pid=10/);
});

test("cleanupStaleDevProcesses rescans for respawned stale sidecars", () => {
  const snapshots = [
    [
      {
        ProcessId: 10,
        ParentProcessId: 1,
        Name: "chrome-devtools-mcp.exe",
        ExecutablePath: `${targetDebugDir}\\chrome-devtools-mcp.exe`,
        CommandLine: `"${targetDebugDir}\\chrome-devtools-mcp.exe" watchdog`,
      },
    ],
    [
      {
        ProcessId: 20,
        ParentProcessId: 10,
        Name: "chrome-devtools-mcp.exe",
        ExecutablePath: `${targetDebugDir}\\chrome-devtools-mcp.exe`,
        CommandLine: `"${targetDebugDir}\\chrome-devtools-mcp.exe" watchdog`,
      },
    ],
    [],
  ];
  const stopped = [];
  const sleeps = [];
  const logs = [];

  const result = cleanupStaleDevProcesses({
    targetDebugDir,
    sidecarsDir,
    processReader: () => snapshots.shift() ?? [],
    listeningPortReader: () => [],
    stopper: (pids) => stopped.push(pids),
    sleep: (ms) => sleeps.push(ms),
    log: (message) => logs.push(message),
    warn: (message) => logs.push(message),
    maxPasses: 4,
    settleMs: 25,
  });

  assert.equal(result, 0);
  assert.deepEqual(stopped, [[10], [20]]);
  assert.deepEqual(sleeps, [25, 25]);
  assert.match(logs.join("\n"), /cleanup pass 2/);
});
