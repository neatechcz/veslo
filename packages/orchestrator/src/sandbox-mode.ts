import type { WorkerSandbox } from "./sandbox/types.js";
import { envFlagEnabled } from "./engine-topology.js";

type SandboxLogger = {
  warn: (message: string, attributes?: Record<string, unknown>, component?: string) => void;
};

const RED = "\u001b[31;1m";
const RESET = "\u001b[0m";
const BORDER = "############################################################";

export function buildUnsandboxedSandboxWarning(input: {
  workspace: string;
  reason: string;
  detail?: string;
}): string {
  const lines = [
    BORDER,
    "!!! UNSANDBOXED OPENCODE ENGINE !!!",
    "",
    "OpenCode is running without the Veslo OS sandbox boundary.",
    `Reason: ${input.reason}`,
    `Workspace: ${input.workspace}`,
  ];
  if (input.detail?.trim()) {
    lines.push(`Detail: ${input.detail.trim()}`);
  }
  lines.push("", "This is intended only for explicit diagnostics or non-sandbox runtime work.", BORDER);
  return `${RED}${lines.join("\n")}${RESET}`;
}

export function sandboxDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagEnabled(env.VESLO_DISABLE_SANDBOX);
}

export function resolveEngineSandbox(input: {
  env?: NodeJS.ProcessEnv;
  workspace: string;
  sandbox?: WorkerSandbox | null;
  resolveSandbox: () => WorkerSandbox;
  logger: SandboxLogger;
  writeWarning?: (message: string) => void;
}): WorkerSandbox | null {
  const writeWarning = input.writeWarning ?? ((message) => console.error(message));

  if (sandboxDisabledByEnv(input.env)) {
    const reason = "VESLO_DISABLE_SANDBOX=1";
    input.logger.warn("engine spawn unsandboxed", { workspace: input.workspace, reason }, "sandbox");
    writeWarning(buildUnsandboxedSandboxWarning({ workspace: input.workspace, reason }));
    return null;
  }

  if (input.sandbox === null) {
    return null;
  }
  if (input.sandbox) {
    return input.sandbox;
  }

  try {
    return input.resolveSandbox();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    input.logger.warn(
      "sandbox unavailable, spawning unsandboxed",
      { workspace: input.workspace, error: detail },
      "sandbox",
    );
    writeWarning(
      buildUnsandboxedSandboxWarning({
        workspace: input.workspace,
        reason: "sandbox unavailable",
        detail,
      }),
    );
    return null;
  }
}
