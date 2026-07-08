import { posix } from "node:path";
import { requireWslInDistro, runWslInDistro, type Wsl2Runtime } from "./discovery.js";

export type WslOpencodeRuntime = {
  bin: string;
  binDir: string;
  source: "env" | "path";
  version?: string;
  expectedVersion?: string;
  assetHint?: string;
};

const WSL_OPENCODE_PROBE_TIMEOUT_MS = 30_000;

function opencodeAssetForWslArch(arch: string): string | null {
  if (arch === "x86_64" || arch === "amd64") return "opencode-linux-x64-baseline.tar.gz";
  if (arch === "aarch64" || arch === "arm64") return "opencode-linux-arm64.tar.gz";
  return null;
}

function parseVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/)?.[0];
}

async function readWslOpencodeVersion(
  runtime: Wsl2Runtime,
  bin: string,
): Promise<string | undefined> {
  const result = await runWslInDistro(runtime.distro, `${quote(bin)} --version`, WSL_OPENCODE_PROBE_TIMEOUT_MS);
  if (result.code !== 0) return undefined;
  return parseVersion(`${result.stdout}\n${result.stderr}`);
}

function assertExpectedVersion(runtime: WslOpencodeRuntime): void {
  if (!runtime.expectedVersion) return;
  if (!runtime.version) {
    throw new Error(
      `Unable to determine WSL OpenCode version from ${runtime.bin}. Expected ${runtime.expectedVersion}.`,
    );
  }
  if (runtime.version !== runtime.expectedVersion) {
    throw new Error(
      `WSL OpenCode version mismatch: expected ${runtime.expectedVersion}, got ${runtime.version}. ` +
        `Run the Veslo first-run Windows sandbox onboarding with the matching Linux OpenCode asset` +
        `${runtime.assetHint ? ` (${runtime.assetHint})` : ""}.`,
    );
  }
}

function quote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

async function realpath(runtime: Wsl2Runtime, path: string, label: string): Promise<string> {
  return requireWslInDistro(runtime.distro, `realpath ${quote(path)}`, label, WSL_OPENCODE_PROBE_TIMEOUT_MS);
}

export async function resolveWslOpencodeRuntime(
  runtime: Wsl2Runtime,
  expectedVersion?: string,
): Promise<WslOpencodeRuntime> {
  const override = process.env.VESLO_WSL_OPENCODE_BIN?.trim();
  const assetHint = opencodeAssetForWslArch(runtime.arch) ?? undefined;

  if (override) {
    const bin = await realpath(runtime, override, "VESLO_WSL_OPENCODE_BIN realpath");
    const version = await readWslOpencodeVersion(runtime, bin);
    const resolved: WslOpencodeRuntime = {
      bin,
      binDir: posix.dirname(bin),
      source: "env",
      version,
      expectedVersion,
      assetHint,
    };
    assertExpectedVersion(resolved);
    return resolved;
  }

  let bin: string;
  try {
    bin = await requireWslInDistro(
      runtime.distro,
      "command -v opencode",
      "OpenCode runtime probe",
      WSL_OPENCODE_PROBE_TIMEOUT_MS,
    );
  } catch {
    throw new Error(
      `The Veslo WSL2 sandbox runtime is missing OpenCode in distro '${runtime.distro}'. ` +
        `Run the Veslo first-run Windows sandbox onboarding${assetHint ? ` (${assetHint})` : ""}, ` +
        "or set VESLO_WSL_OPENCODE_BIN to a provisioned Linux opencode binary inside WSL.",
    );
  }
  const version = await readWslOpencodeVersion(runtime, bin);
  const resolved: WslOpencodeRuntime = {
    bin,
    binDir: posix.dirname(bin),
    source: "path",
    version,
    expectedVersion,
    assetHint,
  };
  assertExpectedVersion(resolved);
  return resolved;
}
