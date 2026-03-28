import type { DashboardTab } from "../types";

export type LeftMenuAction =
  | { kind: "toggle-left-sidebar" }
  | { kind: "return-to-session"; sessionId: string };

type ResolveLeftMenuActionInput = {
  tab: DashboardTab;
  selectedSessionId: string | null | undefined;
  isNarrowViewport: boolean;
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

export function resolveLeftMenuAction(input: ResolveLeftMenuActionInput): LeftMenuAction {
  if (!input.isNarrowViewport) {
    return { kind: "toggle-left-sidebar" };
  }

  if (!SESSION_RETURN_TABS.has(input.tab)) {
    return { kind: "toggle-left-sidebar" };
  }

  const sessionId = input.selectedSessionId?.trim() ?? "";
  if (!sessionId) {
    return { kind: "toggle-left-sidebar" };
  }

  return { kind: "return-to-session", sessionId };
}
