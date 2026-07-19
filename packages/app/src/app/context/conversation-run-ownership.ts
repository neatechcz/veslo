import type {
  SessionLifecycleRecoveryScope,
  SessionLifecycleRecoveryStatus,
} from "./session-lifecycle-recovery";

type RunRecord = {
  scope: SessionLifecycleRecoveryScope;
  state: "active" | "queued" | "terminal";
  status: SessionLifecycleRecoveryStatus | null;
  terminalBoundaryComplete: boolean;
  terminalTranscriptSettled: boolean;
};

export type ProvisionalConversationRunScope = Omit<SessionLifecycleRecoveryScope, "runId"> & {
  clientMessageId: string;
};

const normalize = (value: string | null | undefined) => value?.trim() ?? "";

const runKey = (scope: SessionLifecycleRecoveryScope) =>
  `${normalize(scope.workspaceId)}\0${normalize(scope.conversationId)}\0${normalize(scope.runId)}`;

const aliasKeys = (scope: SessionLifecycleRecoveryScope) => {
  const workspaceId = normalize(scope.workspaceId);
  const aliases = [scope.sessionId, scope.opencodeSessionId, scope.conversationId]
    .map(normalize)
    .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
  return workspaceId ? aliases.map((alias) => `${workspaceId}\0${alias}`) : [];
};

const provisionalAliasKeys = (scope: ProvisionalConversationRunScope) => aliasKeys({ ...scope, runId: "provisional" });

const provisionalKey = (scope: ProvisionalConversationRunScope) =>
  `${normalize(scope.workspaceId)}\0${normalize(scope.conversationId)}\0${normalize(scope.clientMessageId)}`;

const activeStatus = new Set(["submitted", "running", "retry", "blocked"]);

/** Keeps queue reservations separate from the one run allowed to consume an engine alias. */
export function createConversationRunOwnershipIndex() {
  const records = new Map<string, RunRecord>();
  const activeRunKeyByAlias = new Map<string, string>();
  const terminalAliases = new Set<string>();
  const terminalBoundaryAliases = new Set<string>();
  const pendingCommitsByAlias = new Map<string, Array<() => void>>();
  const provisionalByKey = new Map<string, ProvisionalConversationRunScope>();
  const provisionalKeyByAlias = new Map<string, string>();

  const remember = (scope: SessionLifecycleRecoveryScope, state: RunRecord["state"]) => {
    const key = runKey(scope);
    if (!key || !normalize(scope.runId)) return null;
    const existing = records.get(key);
    const record: RunRecord = existing ?? {
      scope,
      state,
      status: null,
      terminalBoundaryComplete: false,
      terminalTranscriptSettled: false,
    };
    record.scope = scope;
    record.state = state;
    records.set(key, record);
    return record;
  };

  const claim = (record: RunRecord) => {
    const key = runKey(record.scope);
    for (const alias of aliasKeys(record.scope)) activeRunKeyByAlias.set(alias, key);
    record.state = "active";
  };

  const promote = (record: RunRecord) => {
    claim(record);
    const commits = aliasKeys(record.scope).flatMap((alias) => {
      terminalAliases.delete(alias);
      terminalBoundaryAliases.delete(alias);
      const pending = pendingCommitsByAlias.get(alias) ?? [];
      pendingCommitsByAlias.delete(alias);
      return pending;
    });
    return { scope: record.scope, status: record.status!, commits };
  };

  const readyQueuedRecordForAliases = (aliases: string[]) => Array.from(records.values()).find((record) =>
    record.state === "queued" &&
    record.status !== null &&
    activeStatus.has(record.status.status) &&
    aliasKeys(record.scope).some((alias) => aliases.includes(alias)),
  );

  const hasQueuedRecordForAliases = (aliases: string[]) => Array.from(records.values()).some((record) =>
    record.state === "queued" && aliasKeys(record.scope).some((alias) => aliases.includes(alias)),
  );

  const releasePendingCommits = (aliases: string[]) => {
    const commits = new Set<() => void>();
    for (const alias of aliases) {
      terminalAliases.delete(alias);
      terminalBoundaryAliases.delete(alias);
      for (const commit of pendingCommitsByAlias.get(alias) ?? []) commits.add(commit);
      pendingCommitsByAlias.delete(alias);
    }
    return [...commits];
  };

  const releaseTerminalWhenReady = (scope: SessionLifecycleRecoveryScope) => {
    const key = runKey(scope);
    const record = records.get(key);
    const aliases = aliasKeys(scope);
    if (record && (!record.terminalBoundaryComplete || !record.terminalTranscriptSettled)) {
      return { promoted: null, commits: [] as Array<() => void> };
    }
    for (const alias of aliases) {
      if (activeRunKeyByAlias.get(alias) === key) activeRunKeyByAlias.delete(alias);
      terminalBoundaryAliases.add(alias);
    }
    const candidate = readyQueuedRecordForAliases(aliases);
    if (candidate) return { promoted: promote(candidate), commits: [] as Array<() => void> };
    if (hasQueuedRecordForAliases(aliases)) return { promoted: null, commits: [] as Array<() => void> };
    return { promoted: null, commits: releasePendingCommits(aliases) };
  };

  const provisionalFor = (sessionId: string, workspaceId?: string | null) => {
    const alias = normalize(sessionId);
    const workspace = normalize(workspaceId);
    if (!alias || !workspace) return null;
    const key = provisionalKeyByAlias.get(`${workspace}\0${alias}`);
    return key ? provisionalByKey.get(key) ?? null : null;
  };

  const disposeProvisional = (scope: ProvisionalConversationRunScope) => {
    const key = provisionalKey(scope);
    const provisional = provisionalByKey.get(key);
    if (!provisional) return false;
    provisionalByKey.delete(key);
    for (const alias of provisionalAliasKeys(provisional)) {
      if (provisionalKeyByAlias.get(alias) === key) provisionalKeyByAlias.delete(alias);
    }
    return true;
  };

  const isActive = (scope: SessionLifecycleRecoveryScope) => {
    const key = runKey(scope);
    return aliasKeys(scope).some((alias) => activeRunKeyByAlias.get(alias) === key);
  };

  return {
    activate(scope: SessionLifecycleRecoveryScope) {
      const record = remember(scope, "active");
      if (!record) return false;
      claim(record);
      return true;
    },
    reserve(scope: SessionLifecycleRecoveryScope) {
      return Boolean(remember(scope, "queued"));
    },
    armProvisional(scope: ProvisionalConversationRunScope) {
      const key = provisionalKey(scope);
      const aliases = provisionalAliasKeys(scope);
      if (!key || !aliases.length) return false;
      if (aliases.some((alias) => activeRunKeyByAlias.has(alias) || provisionalKeyByAlias.has(alias))) return false;
      if (Array.from(records.values()).some((record) =>
        record.state === "queued" && aliasKeys(record.scope).some((alias) => aliases.includes(alias)),
      )) return false;
      provisionalByKey.set(key, { ...scope });
      for (const alias of aliases) provisionalKeyByAlias.set(alias, key);
      return true;
    },
    promoteProvisional(scope: SessionLifecycleRecoveryScope) {
      const clientMessageId = normalize(scope.clientMessageId);
      if (!clientMessageId) return null;
      const provisional = provisionalFor(scope.sessionId, scope.workspaceId);
      if (!provisional || normalize(provisional.clientMessageId) !== clientMessageId) return null;
      disposeProvisional(provisional);
      return provisional;
    },
    disposeProvisional,
    observeStatus(scope: SessionLifecycleRecoveryScope, status: SessionLifecycleRecoveryStatus | null) {
      const record = records.get(runKey(scope));
      if (!record) return false;
      const active = isActive(scope);
      record.status = status;
      if (status && ["completed", "failed", "aborted"].includes(status.status)) record.state = "terminal";
      return active;
    },
    beginTerminal(scope: SessionLifecycleRecoveryScope) {
      const record = records.get(runKey(scope));
      if (record) {
        record.terminalBoundaryComplete = false;
        record.terminalTranscriptSettled = false;
      }
      for (const alias of aliasKeys(scope)) {
        terminalAliases.add(alias);
        terminalBoundaryAliases.delete(alias);
      }
    },
    holdTransitionMutation(sessionId: string, workspaceId: string | null | undefined, commit: () => void) {
      const alias = normalize(sessionId);
      const workspace = normalize(workspaceId);
      const key = alias && workspace ? `${workspace}\0${alias}` : "";
      if (!key || !terminalAliases.has(key)) return false;
      const pending = pendingCommitsByAlias.get(key) ?? [];
      pending.push(commit);
      pendingCommitsByAlias.set(key, pending);
      return true;
    },
    isActive,
    isActiveOrUnknown(scope: SessionLifecycleRecoveryScope) {
      const key = runKey(scope);
      return !records.has(key) || aliasKeys(scope).some((alias) => activeRunKeyByAlias.get(alias) === key);
    },
    resolveActive(sessionId: string, workspaceId?: string | null) {
      const alias = normalize(sessionId);
      const workspace = normalize(workspaceId);
      if (!alias || !workspace) return null;
      const key = activeRunKeyByAlias.get(`${workspace}\0${alias}`);
      return key ? records.get(key)?.scope ?? null : null;
    },
    resolveProvisional: provisionalFor,
    releaseTerminal(scope: SessionLifecycleRecoveryScope) {
      const record = records.get(runKey(scope));
      if (record) record.terminalBoundaryComplete = true;
      return releaseTerminalWhenReady(scope);
    },
    settleTerminalTranscript(scope: SessionLifecycleRecoveryScope) {
      const record = records.get(runKey(scope));
      if (record) record.terminalTranscriptSettled = true;
      return releaseTerminalWhenReady(scope);
    },
    promoteReadyRun(scope: SessionLifecycleRecoveryScope) {
      const record = records.get(runKey(scope));
      if (!record || record.state !== "queued" || !record.status || !activeStatus.has(record.status.status)) return null;
      if (!aliasKeys(record.scope).some((alias) => terminalBoundaryAliases.has(alias))) return null;
      return promote(record);
    },
    settleNonActiveTerminal(scope: SessionLifecycleRecoveryScope) {
      const key = runKey(scope);
      const record = records.get(key);
      if (!record || isActive(scope)) return [];
      records.delete(key);
      const aliases = aliasKeys(scope);
      if (hasQueuedRecordForAliases(aliases)) return [];
      return releasePendingCommits(aliases);
    },
    dispose() {
      records.clear();
      activeRunKeyByAlias.clear();
      terminalAliases.clear();
      terminalBoundaryAliases.clear();
      pendingCommitsByAlias.clear();
      provisionalByKey.clear();
      provisionalKeyByAlias.clear();
    },
  };
}
