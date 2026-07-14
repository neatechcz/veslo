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

export type SidebarActivityTokenRow = {
  workspace: { id: string };
  session: {
    id: string;
    opencodeSessionId?: string | null;
    conversationId?: string | null;
  };
};

export type SidebarActivityTokenPruned = {
  id: string;
  generation: number;
  runId: string;
  aliases: readonly string[];
};

type TokenRecord = SidebarActivityToken & { aliases: string[] };

const normalize = (value: string | null | undefined) => value?.trim() ?? "";

const aliasesForScope = (scope: SidebarActivityTokenScope) =>
  scopedSessionAliasKeys(normalize(scope.workspaceId), [
    scope.sessionId,
    scope.opencodeSessionId,
    scope.conversationId,
  ]);

const aliasesForRow = (row: SidebarActivityTokenRow) =>
  aliasesForScope({
    workspaceId: row.workspace.id,
    sessionId: row.session.id,
    opencodeSessionId: row.session.opencodeSessionId,
    conversationId: row.session.conversationId,
  });

const sameAliases = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((alias, index) => alias === right[index]);

export function createSidebarSessionActivityTokenModel(
  onChange: (tokensByScopedAlias: Record<string, SidebarActivityToken>) => void,
  onDurableTokenPruned?: (token: SidebarActivityTokenPruned) => void,
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

  const removeRecordsSharing = (aliases: readonly string[], exceptId?: string) => {
    const nextAliasSet = new Set(aliases);
    let changed = false;
    for (const [id, record] of records) {
      if (id !== exceptId && record.aliases.some((alias) => nextAliasSet.has(alias))) {
        records.delete(id);
        changed = true;
      }
    }
    return changed;
  };

  return {
    begin(scope: SidebarActivityTokenScope): SidebarActivityTokenHandle | null {
      const aliases = aliasesForScope(scope);
      if (aliases.length === 0) return null;
      removeRecordsSharing(aliases);
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
      const nextAliasSet = new Set(aliases);
      const newerCollision = [...records.entries()].find(([id, candidate]) =>
        id !== handle.id &&
        candidate.generation > record.generation &&
        candidate.aliases.some((alias) => nextAliasSet.has(alias)),
      );
      if (newerCollision) {
        records.delete(handle.id);
        publish();
        return false;
      }
      const replaced = removeRecordsSharing(aliases, handle.id);
      const changed = replaced || !sameAliases(record.aliases, aliases);
      if (!changed) return true;
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
    reconcileFinalRows(rows: readonly SidebarActivityTokenRow[]) {
      const availableAliases = new Set(rows.flatMap(aliasesForRow));
      const pruned: SidebarActivityTokenPruned[] = [];
      let changed = false;
      for (const [id, record] of records) {
        if (record.kind !== "durable" || record.aliases.some((alias) => availableAliases.has(alias))) continue;
        records.delete(id);
        pruned.push({
          id,
          generation: record.generation,
          runId: record.runId,
          aliases: [...record.aliases],
        });
        changed = true;
      }
      if (changed) {
        publish();
        for (const token of pruned) {
          try {
            onDurableTokenPruned?.(token);
          } catch {
            // Diagnostics must not change sidebar activity state.
          }
        }
      }
      return changed;
    },
  };
}
