import { scopedSessionAliasKeys } from "./session-store-model";

export type SidebarActivityToken =
  | { kind: "local"; generation: number }
  | { kind: "durable"; generation: number; runId: string };

export type SidebarActivityTokenHandle = {
  id: string;
  generation: number;
};

export type SidebarActivityTokenScope = {
  workspaceId: string;
  sessionId?: string | null;
  opencodeSessionId?: string | null;
  conversationId?: string | null;
};

type TokenRecord = SidebarActivityToken & { aliases: string[] };

const normalize = (value: string | null | undefined) => value?.trim() ?? "";

const aliasesForScope = (scope: SidebarActivityTokenScope) =>
  scopedSessionAliasKeys(normalize(scope.workspaceId), [
    scope.sessionId,
    scope.opencodeSessionId,
    scope.conversationId,
  ]);

export function createSidebarSessionActivityTokenModel(
  onChange: (tokensByScopedAlias: Record<string, SidebarActivityToken>) => void,
) {
  let nextGeneration = 0;
  const records = new Map<string, TokenRecord>();

  const publish = () => {
    const next: Record<string, SidebarActivityToken> = {};
    for (const record of records.values()) {
      const token: SidebarActivityToken = record.kind === "durable"
        ? { kind: "durable", generation: record.generation, runId: record.runId }
        : { kind: "local", generation: record.generation };
      for (const alias of record.aliases) next[alias] = token;
    }
    onChange(next);
  };

  const recordFor = (handle: SidebarActivityTokenHandle) => records.get(handle.id) ?? null;

  return {
    begin(scope: SidebarActivityTokenScope): SidebarActivityTokenHandle | null {
      const aliases = aliasesForScope(scope);
      if (aliases.length === 0) return null;
      const nextAliasSet = new Set(aliases);
      for (const [id, record] of records) {
        if (record.aliases.some((alias) => nextAliasSet.has(alias))) {
          records.delete(id);
        }
      }
      const generation = ++nextGeneration;
      const handle = { id: `sidebar-activity-${generation}`, generation };
      records.set(handle.id, { kind: "local", generation, aliases });
      publish();
      return handle;
    },
    migrate(handle: SidebarActivityTokenHandle | null | undefined, scope: SidebarActivityTokenScope) {
      if (!handle) return false;
      const record = recordFor(handle);
      const aliases = aliasesForScope(scope);
      if (!record || aliases.length === 0) return false;
      record.aliases = aliases;
      publish();
      return true;
    },
    promote(handle: SidebarActivityTokenHandle | null | undefined, runId: string | null | undefined) {
      if (!handle) return false;
      const record = recordFor(handle);
      const normalizedRunId = normalize(runId);
      if (!record || !normalizedRunId) return false;
      records.set(handle.id, { kind: "durable", generation: record.generation, runId: normalizedRunId, aliases: record.aliases });
      publish();
      return true;
    },
    remove(handle: SidebarActivityTokenHandle | null | undefined) {
      if (!handle || !records.delete(handle.id)) return false;
      publish();
      return true;
    },
  };
}
