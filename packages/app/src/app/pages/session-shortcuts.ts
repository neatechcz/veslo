export type StopRunShortcutInput = {
  key: string;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  commandPaletteOpen: boolean;
  searchOpen: boolean;
  showRunIndicator: boolean;
  abortBusy: boolean;
};

export type EscapeStopShortcutInput = StopRunShortcutInput & {
  confirmationPending: boolean;
};

export type EscapeStopShortcutAction = "ignore" | "request-confirmation" | "confirm-stop";

export function isEscapeStopShortcutEligible(input: StopRunShortcutInput): boolean {
  if (input.key !== "Escape") return false;
  if (input.defaultPrevented) return false;
  if (input.metaKey || input.ctrlKey || input.altKey || input.shiftKey) return false;
  if (input.commandPaletteOpen || input.searchOpen) return false;
  if (!input.showRunIndicator || input.abortBusy) return false;
  return true;
}

export function resolveEscapeStopShortcut(input: EscapeStopShortcutInput): EscapeStopShortcutAction {
  if (!isEscapeStopShortcutEligible(input)) return "ignore";
  return input.confirmationPending ? "confirm-stop" : "request-confirmation";
}
