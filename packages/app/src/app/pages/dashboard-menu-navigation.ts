import type { DashboardTab } from "../types";

export type LeftMenuAction =
  | { kind: "toggle-left-sidebar" }
  | { kind: "return-to-session"; sessionId: string };

export type DashboardTabSelectionAction =
  | { kind: "open-dashboard-tab"; tab: DashboardTab }
  | { kind: "return-to-session"; sessionId: string };

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
};

type ResolveDashboardTabSelectionActionInput = {
  currentTab: DashboardTab;
  nextTab: DashboardTab;
  selectedSessionId: string | null | undefined;
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

const normalizeDashboardNavTab = (tab: DashboardTab): DashboardTab => (tab === "plugins" ? "mcp" : tab);

export function resolveLeftMenuAction(input: ResolveLeftMenuActionInput): LeftMenuAction {
  if (!SESSION_RETURN_TABS.has(input.tab)) {
    return { kind: "toggle-left-sidebar" };
  }

  const sessionId = input.selectedSessionId?.trim() ?? "";
  if (!sessionId) {
    return { kind: "toggle-left-sidebar" };
  }

  return { kind: "return-to-session", sessionId };
}

export function resolveDashboardTabSelectionAction(
  input: ResolveDashboardTabSelectionActionInput,
): DashboardTabSelectionAction {
  const sessionId = input.selectedSessionId?.trim() ?? "";
  const currentTab = normalizeDashboardNavTab(input.currentTab);
  const nextTab = normalizeDashboardNavTab(input.nextTab);

  if (currentTab === nextTab && sessionId) {
    return { kind: "return-to-session", sessionId };
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
