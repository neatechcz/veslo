import type { FlatSessionRow } from "../components/session/workspace-session-list-model";
import type { WorkspaceBusyMap } from "./workspace-debug";
import type { SessionRunDiagnostic } from "./session-lifecycle-recovery";
import type { SidebarActivityToken } from "./sidebar-session-activity-token";
import { scopedSessionAliasKeys } from "./session-store-model";
import { readScopedSessionStatus } from "../lib/scoped-session-status";

export type SidebarSessionActivity = {
  active: boolean;
  phase: "idle" | "submitted" | "running" | "blocked" | "error";
  source: "lifecycle" | "terminal-lifecycle" | "session-status" | "workspace-busy" | null;
};

const activeLifecycle = new Set(["submitted", "running", "blocked"]);
const terminalLifecycle = new Set(["completed", "failed", "aborted"]);

const activePhase = (status: string): SidebarSessionActivity["phase"] =>
  status === "submitted" || status === "blocked" ? status : "running";

const aliasesForRow = (row: FlatSessionRow) => scopedSessionAliasKeys(row.workspace.id, [
  row.session.id,
  row.session.opencodeSessionId,
  row.session.conversationId,
]);

const matchingDiagnostic = (diagnostics: Record<string, SessionRunDiagnostic>, aliases: string[]) =>
  aliases.map((key) => diagnostics[key]).find((value): value is SessionRunDiagnostic => Boolean(value)) ?? null;

export function projectSidebarSessionActivity(input: {
  rows: readonly FlatSessionRow[];
  sessionStatusById: Record<string, string>;
  workspaceBusy: WorkspaceBusyMap;
  diagnostics: Record<string, SessionRunDiagnostic>;
  tokens: Record<string, SidebarActivityToken>;
}): Record<string, SidebarSessionActivity> {
  const next: Record<string, SidebarSessionActivity> = {};
  for (const row of input.rows) {
    const aliases = aliasesForRow(row);
    const token = aliases.map((key) => input.tokens[key]).find(Boolean) ?? null;
    const diagnostic = matchingDiagnostic(input.diagnostics, aliases);
    const correlated = diagnostic && token?.kind === "durable" && token.runId === diagnostic.runId;
    if (
      diagnostic &&
      diagnostic.stale !== true &&
      correlated &&
      (diagnostic.recoveryState === "connection-unavailable" ||
        diagnostic.recoveryState === "transcript-unavailable")
    ) {
      next[row.rowKey] = { active: false, phase: "error", source: "lifecycle" };
      continue;
    }
    if (diagnostic && diagnostic.stale !== true && correlated && terminalLifecycle.has(diagnostic.status)) {
      next[row.rowKey] = diagnostic.status === "failed"
        ? { active: false, phase: "error", source: "terminal-lifecycle" }
        : { active: false, phase: "idle", source: "terminal-lifecycle" };
      continue;
    }
    if (diagnostic && diagnostic.stale !== true && correlated && activeLifecycle.has(diagnostic.status)) {
      next[row.rowKey] = { active: true, phase: activePhase(diagnostic.status), source: "lifecycle" };
      continue;
    }
    const status = [row.session.id, row.session.opencodeSessionId, row.session.conversationId]
      .map((id) => readScopedSessionStatus(input.sessionStatusById, row.workspace.id, id))
      .find((value) => value !== "idle") ?? "idle";
    if (status !== "idle") {
      next[row.rowKey] = { active: true, phase: activePhase(status), source: "session-status" };
      continue;
    }
    const busy = [row.session.id, row.session.opencodeSessionId, row.session.conversationId]
      .filter((id): id is string => Boolean(id?.trim()))
      .some((id) => Boolean(input.workspaceBusy[row.workspace.id]?.[id]));
    next[row.rowKey] = busy
      ? { active: true, phase: "running", source: "workspace-busy" }
      : { active: false, phase: "idle", source: null };
  }
  return next;
}
