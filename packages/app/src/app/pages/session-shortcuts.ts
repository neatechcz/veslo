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

type AgentMode = "build" | "plan" | "veslo";

export type AgentModeCycleShortcutInput = {
  key: string;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  busy: boolean;
};

const AGENT_MODE_SEQUENCE: AgentMode[] = ["build", "plan", "veslo"];

export function shouldStopRunOnEscape(input: StopRunShortcutInput): boolean {
  if (input.key !== "Escape") return false;
  if (input.defaultPrevented) return false;
  if (input.metaKey || input.ctrlKey || input.altKey || input.shiftKey) return false;
  if (input.commandPaletteOpen || input.searchOpen) return false;
  if (!input.showRunIndicator || input.abortBusy) return false;
  return true;
}

export function nextAgentModeOnShiftTab(current: string | null, input: AgentModeCycleShortcutInput): AgentMode | null {
  if (input.key !== "Tab") return null;
  if (input.defaultPrevented) return null;
  if (!input.shiftKey) return null;
  if (input.metaKey || input.ctrlKey || input.altKey) return null;
  if (input.busy) return null;

  const currentMode = current?.trim().toLowerCase() ?? "";
  const index = AGENT_MODE_SEQUENCE.indexOf(currentMode as AgentMode);
  if (index === -1) return AGENT_MODE_SEQUENCE[0];
  return AGENT_MODE_SEQUENCE[(index + 1) % AGENT_MODE_SEQUENCE.length];
}
