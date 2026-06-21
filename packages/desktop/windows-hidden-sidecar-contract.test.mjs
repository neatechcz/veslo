import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const rustSourceUrl = (relativePath) =>
  new URL(`./src-tauri/src/${relativePath}`, import.meta.url);

const readRustSource = (relativePath) =>
  readFileSync(rustSourceUrl(relativePath), "utf8");

const repoSourceUrl = (relativePath) =>
  new URL(`../../${relativePath}`, import.meta.url);

const readRepoSource = (relativePath) =>
  readFileSync(repoSourceUrl(relativePath), "utf8");

const rawCommandChildImport =
  /use\s+tauri_plugin_shell::process(?:::CommandChild|::\{[^}]*\bCommandChild\b[^}]*\})/;
const rawCommandChildReference = /tauri_plugin_shell::process::CommandChild/;

const assertSourceMatches = (source, pattern, message) => {
  assert.equal(pattern.test(source), true, message);
};

const assertSourceOmits = (source, pattern, message) => {
  assert.equal(pattern.test(source), false, message);
};

const readRustFunction = (source, name) => {
  const marker = `fn ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `expected function ${name} to exist`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `expected function ${name} to have a body`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  assert.fail(`expected function ${name} body to close`);
};

const coreSidecarLaunchSources = [
  "engine/spawn.rs",
  "veslo_server/spawn.rs",
  "opencode_router/spawn.rs",
  "orchestrator/mod.rs",
  "commands/orchestrator.rs",
];

const coreSidecarStateSources = [
  "engine/manager.rs",
  "veslo_server/manager.rs",
  "opencode_router/manager.rs",
  "orchestrator/manager.rs",
  "process_supervisor.rs",
];

test("Windows sidecar launches have a central hidden supervised process abstraction", () => {
  const supervisedProcessUrl = rustSourceUrl("supervised_process.rs");

  assert.equal(
    existsSync(supervisedProcessUrl),
    true,
    "expected packages/desktop/src-tauri/src/supervised_process.rs to centralize hidden Windows sidecar process spawning",
  );

  const supervisedProcessSource = readFileSync(supervisedProcessUrl, "utf8");

  assertSourceMatches(
    supervisedProcessSource,
    /#\[\s*cfg\s*\(\s*windows\s*\)\s*\]/,
    "supervised_process.rs should contain Windows-specific launch handling",
  );
  assertSourceMatches(
    supervisedProcessSource,
    /\bCREATE_NO_WINDOW\b/,
    "supervised_process.rs should opt Windows sidecars into CREATE_NO_WINDOW",
  );
  assertSourceMatches(
    supervisedProcessSource,
    /\bCommandExt\b/,
    "supervised_process.rs should use std::os::windows::process::CommandExt for Windows creation flags",
  );
  assertSourceMatches(
    supervisedProcessSource,
    /\.creation_flags\s*\(/,
    "supervised_process.rs should apply Windows creation flags before spawning",
  );
});

test("core sidecar launch sites route through the supervised process abstraction", () => {
  assertSourceMatches(
    readRustSource("lib.rs"),
    /\bmod\s+supervised_process\s*;/,
    "src-tauri/src/lib.rs should register the supervised_process module",
  );

  for (const relativePath of coreSidecarLaunchSources) {
    const source = readRustSource(relativePath);

    assertSourceMatches(
      source,
      /crate::supervised_process\b/,
      `${relativePath} should delegate sidecar spawning through crate::supervised_process`,
    );
    assertSourceOmits(
      source,
      rawCommandChildImport,
      `${relativePath} should not import raw tauri_plugin_shell CommandChild for sidecar supervision`,
    );
    assertSourceOmits(
      source,
      rawCommandChildReference,
      `${relativePath} should not reference raw tauri_plugin_shell CommandChild directly`,
    );
  }
});

test("Windows WSL engine health probes hide PowerShell and WSL subprocess windows", () => {
  const source = readRustSource("veslo_server/mod.rs");

  const powershellProbe = readRustFunction(source, "resolve_engine_url_from_wsl_interface");
  assertSourceMatches(
    powershellProbe,
    /let\s+mut\s+command\s*=\s*Command::new\("powershell"\)\s*;/,
    "WSL interface discovery should build a mutable PowerShell command",
  );
  assertSourceMatches(
    powershellProbe,
    /configure_hidden\(&mut\s+command\)\s*;/,
    "WSL interface discovery should hide the PowerShell probe window",
  );
  assertSourceMatches(
    powershellProbe,
    /\.args\(\[[\s\S]*?"-NonInteractive"[\s\S]*?"-WindowStyle"[\s\S]*?"Hidden"[\s\S]*?"-Command"/,
    "WSL interface discovery should pass hidden, non-interactive PowerShell arguments",
  );
  assertSourceMatches(
    powershellProbe,
    /command\s*\.args\([\s\S]*?\.output\(\)/,
    "WSL interface discovery should execute the hidden PowerShell command",
  );

  const wslProbe = readRustFunction(source, "probe_engine_url_from_wsl_once");
  assertSourceMatches(
    wslProbe,
    /let\s+mut\s+command\s*=\s*Command::new\("wsl\.exe"\)\s*;/,
    "WSL health probing should build a mutable wsl.exe command",
  );
  assertSourceMatches(
    wslProbe,
    /configure_hidden\(&mut\s+command\)\s*;/,
    "WSL health probing should hide the wsl.exe probe window",
  );
  assertSourceMatches(
    wslProbe,
    /command\s*\.args\([\s\S]*?\.status\(\)/,
    "WSL health probing should execute the hidden wsl.exe command",
  );
});

test("Windows WSL repair commands hide PowerShell subprocess windows", () => {
  const source = readRustSource("commands/wsl_sandbox.rs");
  const powershellLaunches = source.match(/Command::new\("powershell\.exe"\)/g) ?? [];
  const hiddenLaunches = source.match(/configure_hidden\(&mut\s+command\)\s*;/g) ?? [];

  assertSourceMatches(
    source,
    /use\s+crate::platform::configure_hidden\s*;/,
    "WSL repair commands should import the central Windows hidden-process helper",
  );
  assert.equal(
    powershellLaunches.length,
    3,
    "expected the WSL repair module to launch three PowerShell commands",
  );
  assert.equal(
    hiddenLaunches.length,
    powershellLaunches.length,
    "every WSL repair PowerShell command should apply configure_hidden before spawning",
  );

  const prerequisiteRepair = readRustFunction(source, "wsl_prerequisites_repair");
  assert.equal(
    prerequisiteRepair.match(/\.arg\("-WindowStyle"\)[\s\S]*?\.arg\("Hidden"\)/g)?.length,
    2,
    "WSL prerequisite check and elevated wrapper commands should pass -WindowStyle Hidden",
  );

  const sandboxRepair = readRustFunction(source, "wsl_sandbox_repair");
  assertSourceMatches(
    sandboxRepair,
    /\.arg\("-WindowStyle"\)[\s\S]*?\.arg\("Hidden"\)/,
    "WSL sandbox repair should pass -WindowStyle Hidden",
  );

  const elevatedCommand = readRustFunction(source, "elevated_powershell_command");
  assertSourceMatches(
    elevatedCommand,
    /"-NonInteractive"\.to_string\(\)[\s\S]*?"-WindowStyle"\.to_string\(\)[\s\S]*?"Hidden"\.to_string\(\)/,
    "elevated WSL prerequisite command should make the elevated PowerShell child non-interactive and hidden",
  );
  assertSourceMatches(
    elevatedCommand,
    /Start-Process[^;]*-WindowStyle Hidden[^;]*-Verb RunAs/,
    "elevated WSL prerequisite command should hide the elevated PowerShell process",
  );
});

test("core sidecar state stores supervised child handles instead of raw CommandChild", () => {
  for (const relativePath of coreSidecarStateSources) {
    const source = readRustSource(relativePath);

    assertSourceOmits(
      source,
      rawCommandChildImport,
      `${relativePath} should not import raw tauri_plugin_shell CommandChild for managed sidecars`,
    );
    assertSourceOmits(
      source,
      rawCommandChildReference,
      `${relativePath} should not reference raw tauri_plugin_shell CommandChild directly`,
    );
  }
});

test("Windows Node helpers hide PowerShell and WSL child process windows", () => {
  const orchestratorCli = readRepoSource("packages/orchestrator/src/cli.ts");
  assertSourceMatches(
    orchestratorCli,
    /function\s+spawnProcess[\s\S]*?windowsHide:\s*true/,
    "orchestrator spawnProcess should hide Windows child process windows",
  );
  assertSourceMatches(
    orchestratorCli,
    /runCommand\("powershell",\s*\[[\s\S]*?"-NonInteractive"[\s\S]*?"-WindowStyle"[\s\S]*?"Hidden"[\s\S]*?"-ExecutionPolicy"[\s\S]*?"Bypass"[\s\S]*?"-Command"/,
    "orchestrator PowerShell helpers should be non-interactive and hidden",
  );

  const wslDiscovery = readRepoSource("packages/orchestrator/src/sandbox/windows-wsl2/discovery.ts");
  assert.equal(
    (wslDiscovery.match(/windowsHide:\s*true/g) ?? []).length,
    2,
    "WSL discovery should hide both spawnSync and spawn wsl.exe subprocesses",
  );

  const prepareSidecar = readRepoSource("packages/desktop/scripts/prepare-sidecar.mjs");
  assertSourceMatches(
    prepareSidecar,
    /const\s+hiddenPowerShellArgs\s*=\s*\(script\)\s*=>\s*\[[\s\S]*?"-NonInteractive"[\s\S]*?"-WindowStyle"[\s\S]*?"Hidden"[\s\S]*?"-ExecutionPolicy"[\s\S]*?"Bypass"[\s\S]*?"-Command"/,
    "prepare-sidecar should use hidden, non-interactive PowerShell arguments",
  );
  assert.equal(
    (prepareSidecar.match(/windowsHide:\s*true/g) ?? []).length,
    2,
    "prepare-sidecar should hide both Windows PowerShell subprocesses",
  );

  const cleanupDevProcesses = readRepoSource("packages/desktop/scripts/cleanup-dev-processes.mjs");
  assertSourceMatches(
    cleanupDevProcesses,
    /spawnSync\(\s*powershellExe\(\),\s*\[[\s\S]*?"-NonInteractive"[\s\S]*?"-WindowStyle"[\s\S]*?"Hidden"[\s\S]*?"-ExecutionPolicy"[\s\S]*?"Bypass"[\s\S]*?"-Command"/,
    "dev cleanup PowerShell should be non-interactive and hidden",
  );
  assertSourceMatches(
    cleanupDevProcesses,
    /windowsHide:\s*true/,
    "dev cleanup should hide its PowerShell subprocess window",
  );
});
