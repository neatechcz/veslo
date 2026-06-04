import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

export type WslCommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

export type WslDistro = {
  name: string;
  state: string;
  version: number | null;
  default: boolean;
};

export type Wsl2Runtime = {
  wslExe: string;
  distro: string;
  kernel: string;
  arch: string;
  bwrapPath: string;
  localhostMode: "windows-localhost" | "wsl-ip";
  wslIp?: string;
};

const MANAGED_WSL_DISTRO = "VesloSandbox";

function isUsableWslConnectIp(value: string): boolean {
  const parts = value.trim().split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet, index) => !/^\d+$/.test(parts[index] ?? "") || octet < 0 || octet > 255)) {
    return false;
  }
  const [a, b, c, d] = octets;
  if (a === 0 || a === 127 || a === 255) return false;
  if (a === 169 && b === 254) return false;
  if (a === 224 || a > 224) return false;
  if (a === 10 && b === 255 && c === 255 && d === 254) return false;
  return true;
}

async function resolveWslConnectIp(distro: string): Promise<{ ip: string; detail: string }> {
  const override = process.env.VESLO_WSL_CONNECT_HOST?.trim();
  if (override) {
    if (!isUsableWslConnectIp(override)) {
      throw new Error(`VESLO_WSL_CONNECT_HOST is not a usable IPv4 address: ${override}`);
    }
    return { ip: override, detail: "VESLO_WSL_CONNECT_HOST" };
  }

  const script = [
    "set +e",
    "{",
    `  ip -4 -o addr show dev eth0 scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1]}'`,
    "  ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p'",
    `  ip -4 -o addr show scope global up 2>/dev/null | awk '$2 != "lo" {split($4,a,"/"); print a[1]}'`,
    "  hostname -I 2>/dev/null | tr ' ' '\\n'",
    "} | awk 'NF && !seen[$0]++'",
  ].join("\n");
  const probe = await runWslInDistro(distro, script, 5000);
  const candidates = probe.stdout
    .replace(/\r/g, "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const ip = candidates.find(isUsableWslConnectIp);
  const detail = [
    probe.stdout.trim() ? `stdout=${JSON.stringify(probe.stdout.trim())}` : "",
    probe.stderr.trim() ? `stderr=${JSON.stringify(probe.stderr.trim())}` : "",
    `candidates=${JSON.stringify(candidates)}`,
  ].filter(Boolean).join(" ");

  if (!ip) {
    throw new Error(
      `Could not resolve a host-reachable IPv4 address for WSL distro '${distro}'. ` +
        "Tried eth0, route source, non-loopback global IPv4, and hostname -I. " +
        "Without this address Veslo would have to use flaky Windows localhost forwarding. " +
        "Set VESLO_WSL_CONNECT_HOST to the distro IPv4 address after verifying Windows can reach it." +
        (detail ? ` Probe output: ${detail}` : ""),
    );
  }

  return { ip, detail };
}

export function resolveWslExe(): string {
  const override = process.env.VESLO_WSL_EXE?.trim();
  if (override) return override;
  const systemRoot = process.env.SystemRoot?.trim() || process.env.SYSTEMROOT?.trim();
  if (systemRoot) {
    const candidate = `${systemRoot}\\System32\\wsl.exe`;
    if (existsSync(candidate)) return candidate;
  }
  return "wsl.exe";
}

export function isWslStatusAvailableSync(): boolean {
  if (process.platform !== "win32") return false;
  const result = spawnSync(resolveWslExe(), ["--status"], {
    encoding: "utf8",
    timeout: 2500,
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

export function runWsl(args: string[], timeoutMs = 15_000): Promise<WslCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveWslExe(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(new Error(`wsl.exe ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.replace(/\0/g, ""),
        stderr: stderr.replace(/\0/g, ""),
        code,
      });
    });
  });
}

export async function runWslInDistro(
  distro: string,
  script: string,
  timeoutMs = 15_000,
): Promise<WslCommandResult> {
  const wrappedScript = [
    'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
    script,
  ].join("\n");
  return runWsl(["-d", distro, "--exec", "bash", "-c", wrappedScript], timeoutMs);
}

export async function requireWslInDistro(
  distro: string,
  script: string,
  label: string,
  timeoutMs = 15_000,
): Promise<string> {
  const result = await runWslInDistro(distro, script, timeoutMs);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${label} failed in WSL distro '${distro}'${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

export async function listWslDistributions(): Promise<WslDistro[]> {
  const result = await runWsl(["-l", "-v"], 5000);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      "No usable WSL2 runtime was found. Run the Veslo first-run Windows sandbox onboarding, then retry." +
        (detail ? `\n${detail}` : ""),
    );
  }
  return result.stdout
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^NAME\s+STATE\s+VERSION/i.test(line.trim()))
    .map((line) => {
      const defaultDistro = line.trimStart().startsWith("*");
      const clean = line.replace(/^\s*\*\s*/, "").trim();
      const parts = clean.split(/\s{2,}/);
      const version = parts[2] ? Number.parseInt(parts[2], 10) : NaN;
      return {
        name: parts[0] ?? clean,
        state: parts[1] ?? "",
        version: Number.isFinite(version) ? version : null,
        default: defaultDistro,
      };
    })
    .filter((entry) => entry.name);
}

async function selectDistro(): Promise<string> {
  const override = process.env.VESLO_WSL_DISTRO?.trim();
  if (override) return override;

  const distros = await listWslDistributions();
  if (distros.length === 0) {
    throw new Error("No WSL distributions are installed. Run the Veslo first-run Windows sandbox onboarding, then retry.");
  }
  const wsl2 = distros.filter((entry) => entry.version === 2);
  if (wsl2.length === 0) {
    const names = distros.map((entry) => `${entry.name}${entry.version ? ` (WSL${entry.version})` : ""}`).join(", ");
    throw new Error(`No WSL2 distribution is available. Run the Veslo first-run Windows sandbox onboarding. Found: ${names}`);
  }
  return (
    wsl2.find((entry) => entry.name.toLowerCase() === MANAGED_WSL_DISTRO.toLowerCase())?.name ??
    wsl2.find((entry) => entry.default)?.name ??
    wsl2.find((entry) => entry.state.toLowerCase() === "running")?.name ??
    wsl2.find((entry) => /^ubuntu/i.test(entry.name))?.name ??
    wsl2[0]?.name ??
    "Ubuntu"
  );
}

export async function discoverWsl2Runtime(): Promise<Wsl2Runtime> {
  if (process.platform !== "win32") {
    throw new Error(`Windows WSL2 sandbox is Windows-only (current platform: ${process.platform}).`);
  }

  const distro = await selectDistro();
  const [kernel, arch] = await Promise.all([
    requireWslInDistro(distro, "uname -r", "WSL kernel probe"),
    requireWslInDistro(distro, "uname -m", "WSL architecture probe"),
  ]);
  let bwrapPath: string;
  try {
    bwrapPath = await requireWslInDistro(distro, "command -v bwrap", "bubblewrap probe");
  } catch {
    throw new Error(
      `The Veslo WSL2 sandbox runtime is missing bubblewrap in distro '${distro}'. ` +
        "Run the Veslo first-run Windows sandbox onboarding, or set VESLO_WSL_DISTRO to a provisioned distro.",
    );
  }

  const smoke = await runWslInDistro(
    distro,
    [
      "set -e",
      `${bwrapPath} --new-session --die-with-parent --unshare-user --unshare-pid --unshare-ipc --unshare-uts --cap-drop ALL --proc /proc --dev /dev --tmpfs /tmp --ro-bind /usr /usr --ro-bind-try /bin /bin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 --ro-bind /etc /etc -- /bin/sh -lc 'echo veslo-bwrap-ok'`,
    ].join("\n"),
    10_000,
  );
  if (smoke.code !== 0 || !smoke.stdout.includes("veslo-bwrap-ok")) {
    const detail = (smoke.stderr || smoke.stdout).trim();
    throw new Error(formatBwrapRuntimeError(distro, detail));
  }
  const connectIp = await resolveWslConnectIp(distro);

  return {
    wslExe: resolveWslExe(),
    distro,
    kernel,
    arch,
    bwrapPath,
    localhostMode: "wsl-ip",
    wslIp: connectIp.ip,
  };
}

function formatBwrapRuntimeError(distro: string, detail: string): string {
  const lower = detail.toLowerCase();
  if (
    lower.includes("operation not permitted") ||
    lower.includes("permission denied") ||
    lower.includes("no permissions") ||
    lower.includes("user namespace") ||
    lower.includes("unshare") ||
    lower.includes("apparmor")
  ) {
    return (
      `bubblewrap cannot create the required user namespace in WSL distro '${distro}'. ` +
      "On Ubuntu 24.04+ this can be caused by unprivileged user namespace/AppArmor restrictions. " +
      "Use the Veslo-managed WSL sandbox runtime or a distro configuration that supports bubblewrap." +
      (detail ? `\n${detail}` : "")
    );
  }
  return `bubblewrap runtime probe failed in WSL distro '${distro}'${detail ? `: ${detail}` : ""}`;
}
