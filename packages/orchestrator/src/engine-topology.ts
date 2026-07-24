const RED = "\u001b[31;1m";
const RESET = "\u001b[0m";
const BORDER = "############################################################";

export type EngineTopologyMode =
  | "pooled-per-workspace"
  | "shared-unsandboxed"
  | "shared-directory-scoped";

export type EngineSandboxKind =
  | "none"
  | "mac-sandbox-exec"
  | "windows-job-object"
  | "windows-wsl2"
  | "stub"
  | "unknown";

export type EngineTopology = {
  mode: EngineTopologyMode;
  reason: string;
  sharedRequested: boolean;
};

export function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function sharedOpencodeEngineRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagEnabled(env.VESLO_SHARED_OPENCODE_ENGINE);
}

/**
 * This is intentionally a separate opt-in from the legacy shared fallback.
 * The mode remains experimental until the bundled capability fingerprint and
 * desktop acceptance matrix are promoted together.
 */
export function sharedDirectoryScopedEngineRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagEnabled(env.VESLO_SHARED_OPENCODE_DIRECTORY_SCOPED);
}

export function usesSharedOpenCodeEngine(mode: EngineTopologyMode): boolean {
  return mode === "shared-unsandboxed" || mode === "shared-directory-scoped";
}

export function sandboxExplicitlyDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagEnabled(env.VESLO_DISABLE_SANDBOX);
}

export function buildSharedOpencodeEngineWarning(): string {
  const lines = [
    BORDER,
    "!!! UNSANDBOXED SHARED OPENCODE ENGINE !!!",
    "",
    "VESLO_DISABLE_SANDBOX=1 and VESLO_SHARED_OPENCODE_ENGINE=1 are enabled.",
    "One OpenCode process will serve multiple workspaces without filesystem isolation.",
    "Do not use this mode for untrusted workspaces.",
    BORDER,
  ];
  return `${RED}${lines.join("\n")}${RESET}`;
}

export function resolveEngineTopology(input: {
  env?: NodeJS.ProcessEnv;
  sandboxKind: EngineSandboxKind;
  sandboxFallbackReason?: string;
}): EngineTopology {
  const env = input.env ?? process.env;
  const sharedRequested = sharedOpencodeEngineRequested(env);

  if (!sharedRequested) {
    return {
      mode: "pooled-per-workspace",
      reason: input.sandboxFallbackReason
        ? `shared engine not requested; ${input.sandboxFallbackReason}`
        : "shared engine not requested",
      sharedRequested,
    };
  }

  if (!sandboxExplicitlyDisabled(env)) {
    throw new Error(
      "VESLO_SHARED_OPENCODE_ENGINE=1 requires VESLO_DISABLE_SANDBOX=1. Shared OpenCode engines are not supported in sandboxed runtimes.",
    );
  }

  if (input.sandboxKind !== "none") {
    throw new Error(
      `Shared OpenCode engine requested, but sandbox kind '${input.sandboxKind}' is active. Disable sandboxing first.`,
    );
  }

  if (sharedDirectoryScopedEngineRequested(env)) {
    return {
      mode: "shared-directory-scoped",
      reason: "explicit experimental directory-scoped shared engine requested",
      sharedRequested,
    };
  }

  return {
    mode: "shared-unsandboxed",
    reason: "explicit non-sandbox shared engine requested",
    sharedRequested,
  };
}
