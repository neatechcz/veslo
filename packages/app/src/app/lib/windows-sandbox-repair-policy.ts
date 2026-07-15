export type WindowsSandboxRepairPreferences = {
  sharedUnsandboxedEngine: boolean;
};

export type WindowsSandboxRepairPolicy = "hidden" | "available";

// The WSL sandbox runtime is deliberately not shipped in current desktop
// installers. Keep every app-side repair entry point unavailable until that
// packaging decision changes together with its installer contract.
export const WINDOWS_WSL_SANDBOX_RUNTIME_ENABLED = false;

export function resolveWindowsSandboxRepairPolicy(input: {
  isWindowsDesktop: boolean;
  preferences: WindowsSandboxRepairPreferences | null | undefined;
  supportFlow?: boolean;
}): WindowsSandboxRepairPolicy {
  if (!WINDOWS_WSL_SANDBOX_RUNTIME_ENABLED) return "hidden";
  if (!input.isWindowsDesktop) return "hidden";
  if (input.supportFlow) return "available";
  return input.preferences?.sharedUnsandboxedEngine === false ? "available" : "hidden";
}

export function maybeStartWindowsSandboxAutoPrepare(
  policy: WindowsSandboxRepairPolicy,
  start: () => void,
): void {
  if (policy === "available") start();
}
