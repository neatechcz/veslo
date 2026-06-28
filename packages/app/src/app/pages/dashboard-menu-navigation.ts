import type { DashboardTab } from "../types";

export type LeftMenuAction =
  | { kind: "toggle-left-sidebar" }
  | { kind: "return-to-session"; sessionId?: string };

export type DashboardTabSelectionAction =
  | { kind: "open-dashboard-tab"; tab: DashboardTab }
  | { kind: "return-to-session"; sessionId?: string };

type DashboardEscapeShortcutInput = {
  key: string;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  modalOpen: boolean;
  targetTagName: string | null;
  targetIsContentEditable: boolean;
};

type ResolveLeftMenuActionInput = {
  tab: DashboardTab;
  selectedSessionId: string | null | undefined;
  lastWorkspaceSessionId?: string | null | undefined;
};

type ResolveDashboardTabSelectionActionInput = {
  currentTab: DashboardTab;
  nextTab: DashboardTab;
  selectedSessionId: string | null | undefined;
  lastWorkspaceSessionId?: string | null | undefined;
};

const SESSION_RETURN_TABS = new Set<DashboardTab>([
  "scheduled",
  "soul",
  "skills",
  "plugins",
  "mcp",
  "config",
  "settings",
]);

const resolveReturnSessionAction = (
  selectedSessionId: string | null | undefined,
  lastWorkspaceSessionId?: string | null | undefined,
): Extract<LeftMenuAction, { kind: "return-to-session" }> => {
  const sessionId = selectedSessionId?.trim() || lastWorkspaceSessionId?.trim() || "";
  return sessionId ? { kind: "return-to-session", sessionId } : { kind: "return-to-session" };
};

export function resolveLeftMenuAction(input: ResolveLeftMenuActionInput): LeftMenuAction {
  if (!SESSION_RETURN_TABS.has(input.tab)) {
    return { kind: "toggle-left-sidebar" };
  }

  return resolveReturnSessionAction(input.selectedSessionId, input.lastWorkspaceSessionId);
}

export function resolveDashboardTabSelectionAction(
  input: ResolveDashboardTabSelectionActionInput,
): DashboardTabSelectionAction {
  const sessionId = input.selectedSessionId?.trim() ?? "";

  if (input.currentTab === input.nextTab) {
    return resolveReturnSessionAction(sessionId, input.lastWorkspaceSessionId);
  }

  return { kind: "open-dashboard-tab", tab: input.nextTab };
}

export function shouldReturnToSessionOnEscape(input: DashboardEscapeShortcutInput): boolean {
  if (input.key !== "Escape") return false;
  if (input.defaultPrevented) return false;
  if (input.metaKey || input.ctrlKey || input.altKey || input.shiftKey) return false;
  if (input.modalOpen) return false;
  if (input.targetIsContentEditable) return false;
  const tagName = input.targetTagName?.toUpperCase() ?? "";
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") return false;
  return true;
}
