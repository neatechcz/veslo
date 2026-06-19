#!/usr/bin/env bun
/**
 * Windows WSL2 + bubblewrap smoke test.
 *
 * Run from packages/orchestrator on Windows:
 *   bun scripts/windows-wsl2-sandbox-smoke.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWsl2Runtime, runWslInDistro } from "../src/sandbox/windows-wsl2/discovery.js";
import { isWslMappableWindowsPath, windowsPathToWslPath } from "../src/sandbox/windows-wsl2/paths.js";
import { shellQuote } from "../src/sandbox/launch.js";

if (process.platform !== "win32") {
  console.error("This smoke test must run on Windows.");
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), "veslo-wsl2-smoke-"));
const workspace = join(root, "workspace");
const sibling = join(root, "sibling");
mkdirSync(workspace, { recursive: true });
mkdirSync(sibling, { recursive: true });
writeFileSync(join(workspace, "marker.txt"), "veslo-wsl2-marker\n");
writeFileSync(join(sibling, "secret.txt"), "veslo-wsl2-secret\n");
mkdirSync(join(workspace, ".git"), { recursive: true });
writeFileSync(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");

const runtime = await discoverWsl2Runtime();
const wslWorkspace = windowsPathToWslPath(workspace);
const wslSibling = windowsPathToWslPath(sibling);
const wslUserProfile =
  process.env.USERPROFILE && isWslMappableWindowsPath(process.env.USERPROFILE)
    ? windowsPathToWslPath(process.env.USERPROFILE)
    : null;

const script = [
  "set -euo pipefail",
  `WORKSPACE=${shellQuote(wslWorkspace)}`,
  `SIBLING=${shellQuote(wslSibling)}`,
  `BWRAP=${shellQuote(runtime.bwrapPath)}`,
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
  "  --ro-bind \"$WORKSPACE/.git\" /workspace/.git",
  "  --chdir /workspace",
  ")",
  "\"$BWRAP\" \"${BWRAP_ARGS[@]}\" -- /bin/sh -lc '",
  "  set -e",
  "  test \"$(cat marker.txt)\" = \"veslo-wsl2-marker\"",
  "  echo ok > out.txt",
  "  test \"$(cat out.txt)\" = \"ok\"",
  "  if echo bad > .git/config 2>/tmp/git-write.err; then exit 10; fi",
  `  if cat ${shellQuote(`${wslSibling}/secret.txt`)} >/tmp/sibling-read.out 2>/tmp/sibling-read.err; then exit 11; fi`,
  ...(wslUserProfile
    ? [`  if ls ${shellQuote(wslUserProfile)} >/tmp/userhome-read.out 2>/tmp/userhome-read.err; then exit 12; fi`]
    : []),
  "  echo veslo-wsl2-bwrap-ok",
  "'",
].join("\n");

const result = await runWslInDistro(runtime.distro, script, 15_000);
try {
  if (result.code !== 0 || !result.stdout.includes("veslo-wsl2-bwrap-ok")) {
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(result.code ?? 1);
  }
  if (!existsSync(join(workspace, "out.txt"))) {
    console.error("Expected workspace write did not persist.");
    process.exit(1);
  }
  await verifyLocalhostForwarding();
  console.log(`PASS - WSL2 bwrap smoke passed in distro ${runtime.distro} (${runtime.arch})`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a local TCP port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForMarker(url: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const text = await response.text();
      if (response.ok && text.includes("veslo-wsl2-marker")) return true;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function verifyLocalhostForwarding(): Promise<void> {
  const python = await runWslInDistro(runtime.distro, "command -v python3", 5000);
  if (python.code !== 0) {
    console.warn("SKIP - python3 missing in WSL; localhost forwarding smoke was not run.");
    return;
  }

  const port = await findFreePort();
  const serverScript = [
    "set -euo pipefail",
    `WORKSPACE=${shellQuote(wslWorkspace)}`,
    `BWRAP=${shellQuote(runtime.bwrapPath)}`,
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
    "  --chdir /workspace",
    ")",
    `exec "$BWRAP" "\${BWRAP_ARGS[@]}" -- python3 -m http.server ${port} --bind 127.0.0.1`,
  ].join("\n");

  const child = spawn(runtime.wslExe, ["-d", runtime.distro, "--exec", "bash", "-c", serverScript], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    const ok = await waitForMarker(`http://127.0.0.1:${port}/marker.txt`);
    if (!ok) {
      throw new Error(`WSL localhost forwarding failed for http://127.0.0.1:${port}/marker.txt`);
    }
  } finally {
    child.kill("SIGTERM");
  }
}
