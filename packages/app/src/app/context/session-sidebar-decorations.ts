import { createEffect, createSignal, untrack } from "solid-js";

import {
  buildSubagentDecorationModel,
  classifySubagentRoleDeterministic,
  normalizeSubagentLocale,
  normalizeSubagentRoleKey,
  roleProfileFromRoleKey,
  SUBAGENT_DECORATION_PALETTE,
  type SubagentLocale,
} from "../lib/subagent-decoration-model";
import {
  emptySubagentDecorationsPersistence,
  parseSubagentDecorationsPersistence,
  serializeSubagentDecorationsPersistence,
  type SubagentDecorationPersistentRole,
  type SubagentDecorationPersistentSession,
  type SubagentDecorationsPersistenceV1,
} from "../lib/subagent-decorations-persistence";
import type {
  SidebarSubagentDecoration,
  WorkspaceSessionGroup,
} from "../types";

const SUBAGENT_DECORATIONS_PREF_KEY = "veslo.subagent-decorations.v1";

type SidebarSubagentCandidate = {
  workspaceId: string;
  sessionId: string;
  parentSessionId: string;
  sessionTitle: string;
  parentSessionTitle: string;
};

export type SessionSidebarDecorationsStore = {
  state: () => SubagentDecorationsPersistenceV1;
  ready: () => boolean;
  hydrate: () => void;
  markReady: () => void;
  flushPendingDecorations: () => Promise<void>;
  subagentDecorationsBySessionId: () => Record<string, SidebarSubagentDecoration>;
};

export type SessionSidebarDecorationsOptions = {
  locale: () => SubagentLocale;
  sidebarWorkspaceGroups: () => WorkspaceSessionGroup[];
  readState?: () => SubagentDecorationsPersistenceV1;
  writeState?: (value: SubagentDecorationsPersistenceV1) => void;
};

function readSubagentDecorationsState(): SubagentDecorationsPersistenceV1 {
  if (typeof window === "undefined") return emptySubagentDecorationsPersistence();
  try {
    const raw = window.localStorage.getItem(SUBAGENT_DECORATIONS_PREF_KEY);
    return parseSubagentDecorationsPersistence(raw) ?? emptySubagentDecorationsPersistence();
  } catch {
    return emptySubagentDecorationsPersistence();
  }
}

function writeSubagentDecorationsState(value: SubagentDecorationsPersistenceV1): void {
  if (typeof window === "undefined") return;
  try {
    const payload = serializeSubagentDecorationsPersistence(value);
    if (payload) {
      window.localStorage.setItem(SUBAGENT_DECORATIONS_PREF_KEY, payload);
    } else {
      window.localStorage.removeItem(SUBAGENT_DECORATIONS_PREF_KEY);
    }
  } catch {
    // ignore localStorage failures
  }
}

function nextSubagentOccurrenceIndex(
  existingSessions: SubagentDecorationPersistentSession[],
  roleKey: string,
): number {
  const used = new Set<number>();
  for (const session of existingSessions) {
    if (session.roleKey !== roleKey) continue;
    if (Number.isFinite(session.occurrenceIndex) && session.occurrenceIndex > 0) {
      used.add(Math.floor(session.occurrenceIndex));
    }
  }
  let index = 1;
  while (used.has(index)) index += 1;
  return index;
}

function nextSubagentColor(existingSessions: SubagentDecorationPersistentSession[]): string {
  const usedColors = new Set(
    existingSessions
      .map((session) => session.color?.trim() ?? "")
      .filter((color) => color.length > 0),
  );
  for (const color of SUBAGENT_DECORATION_PALETTE) {
    if (!usedColors.has(color)) return color;
  }
  let attempt = usedColors.size + 1;
  while (true) {
    const generated = `hsl(${(attempt * 47) % 360} 72% 46%)`;
    if (!usedColors.has(generated)) return generated;
    attempt += 1;
  }
}

function buildSubagentRoleEntry(input: {
  locale: SubagentLocale;
  roleKey: string;
  roleLabel: string;
  aiFirstName: string;
  existingRole: SubagentDecorationPersistentRole | null;
  fallbackPrompt: string;
}): SubagentDecorationPersistentRole {
  const fallbackProfile = classifySubagentRoleDeterministic({
    locale: input.locale,
    prompt: input.fallbackPrompt,
  });
  const roleCatalogProfile = roleProfileFromRoleKey(input.roleKey, input.locale);
  const fallbackCs = roleCatalogProfile?.firstNameByLocale.cs ?? fallbackProfile.firstNameByLocale.cs;
  const fallbackEn = roleCatalogProfile?.firstNameByLocale.en ?? fallbackProfile.firstNameByLocale.en;

  const aiFirstName = input.aiFirstName.trim();
  const firstNameByLocale = input.existingRole?.firstNameByLocale ?? {
    cs: input.locale === "cs" ? (aiFirstName || fallbackCs) : fallbackCs,
    en: input.locale === "en" ? (aiFirstName || fallbackEn) : fallbackEn,
  };

  return {
    roleKey: input.roleKey,
    roleLabel: input.existingRole?.roleLabel?.trim() || input.roleLabel,
    firstNameByLocale: {
      cs: firstNameByLocale.cs.trim() || fallbackCs,
      en: firstNameByLocale.en.trim() || fallbackEn,
    },
  };
}

export function createSessionSidebarDecorations(
  options: SessionSidebarDecorationsOptions,
): SessionSidebarDecorationsStore {
  const readState = options.readState ?? readSubagentDecorationsState;
  const writeState = options.writeState ?? writeSubagentDecorationsState;
  const [state, setState] = createSignal<SubagentDecorationsPersistenceV1>(
    emptySubagentDecorationsPersistence(),
  );
  const [ready, setReady] = createSignal(false);

  const readSubagentCandidates = (): SidebarSubagentCandidate[] => {
    const candidates: SidebarSubagentCandidate[] = [];
    const seenSessionIds = new Set<string>();

    for (const group of options.sidebarWorkspaceGroups()) {
      const bySessionId = new Map(
        group.sessions.map((session) => [session.id, session] as const),
      );
      for (const session of group.sessions) {
        const parentSessionId = typeof session.parentID === "string" ? session.parentID.trim() : "";
        if (!parentSessionId || seenSessionIds.has(session.id)) continue;
        seenSessionIds.add(session.id);
        candidates.push({
          workspaceId: group.workspace.id,
          sessionId: session.id,
          parentSessionId,
          sessionTitle: session.title?.trim() ?? "",
          parentSessionTitle: bySessionId.get(parentSessionId)?.title?.trim() ?? "",
        });
      }
    }

    return candidates;
  };

  const ensureSubagentDecorationForSession = async (candidate: SidebarSubagentCandidate) => {
    const locale = options.locale();
    const fallbackPrompt = `${candidate.sessionTitle}\n${candidate.parentSessionTitle}`;
    const deterministic = classifySubagentRoleDeterministic({
      locale,
      prompt: fallbackPrompt,
    });

    const roleKey = normalizeSubagentRoleKey(deterministic.roleKey) ?? deterministic.roleKey;
    const roleProfile = roleProfileFromRoleKey(roleKey, locale);
    const roleLabel =
      deterministic.roleLabel?.trim() ||
      roleProfile?.roleLabel ||
      deterministic.roleLabel;
    const aiFirstName = deterministic.firstName;

    setState((current) => {
      if (current.sessions.some((entry) => entry.sessionId === candidate.sessionId)) {
        return current;
      }

      const siblingSessions = current.sessions.filter((entry) =>
        entry.workspaceId === candidate.workspaceId &&
        entry.parentSessionId === candidate.parentSessionId
      );
      const existingRole = current.roles.find((entry) => entry.roleKey === roleKey) ?? null;
      const roleEntry = buildSubagentRoleEntry({
        locale,
        roleKey,
        roleLabel,
        aiFirstName,
        existingRole,
        fallbackPrompt,
      });
      const roles = existingRole
        ? current.roles.map((entry) => (entry.roleKey === roleKey ? roleEntry : entry))
        : [...current.roles, roleEntry];

      const sessionEntry: SubagentDecorationPersistentSession = {
        sessionId: candidate.sessionId,
        workspaceId: candidate.workspaceId,
        parentSessionId: candidate.parentSessionId,
        roleKey,
        roleLabel,
        color: nextSubagentColor(siblingSessions),
        occurrenceIndex: nextSubagentOccurrenceIndex(siblingSessions, roleKey),
      };

      const next = {
        ...current,
        roles,
        sessions: [...current.sessions, sessionEntry],
      };
      if (ready()) writeState(next);
      return next;
    });
  };

  let queue = Promise.resolve();
  const pendingSessionIds = new Set<string>();

  const scheduleMissingDecorations = () => {
    if (!ready()) return;
    const knownDecoratedIds = new Set(
      state().sessions.map((entry) => entry.sessionId),
    );
    for (const candidate of readSubagentCandidates()) {
      if (knownDecoratedIds.has(candidate.sessionId)) continue;
      if (pendingSessionIds.has(candidate.sessionId)) continue;

      pendingSessionIds.add(candidate.sessionId);
      queue = queue
        .then(() => untrack(() => (async () => {
          await ensureSubagentDecorationForSession(candidate);
        })()))
        .catch(() => {})
        .finally(() => {
          pendingSessionIds.delete(candidate.sessionId);
        });
    }
  };

  const flushPendingDecorations = async () => {
    scheduleMissingDecorations();
    await queue;
  };

  createEffect(() => {
    scheduleMissingDecorations();
  });

  const subagentDecorationsBySessionId = (): Record<string, SidebarSubagentDecoration> => {
    if (!ready()) return {};
    const locale = normalizeSubagentLocale(options.locale()) ?? "en";
    const currentState = state();
    const visibleSubagentIds = new Set(readSubagentCandidates().map((candidate) => candidate.sessionId));
    if (visibleSubagentIds.size === 0) return {};

    const model = buildSubagentDecorationModel({
      locale,
      roles: currentState.roles,
      sessions: currentState.sessions.map((entry) => ({
        sessionId: entry.sessionId,
        parentSessionId: `${entry.workspaceId}:${entry.parentSessionId}`,
        roleKey: entry.roleKey,
        roleLabel: entry.roleLabel,
        color: entry.color,
        occurrenceIndex: entry.occurrenceIndex,
      })),
    });

    const map: Record<string, SidebarSubagentDecoration> = {};
    for (const item of model.decorations) {
      if (!visibleSubagentIds.has(item.sessionId)) continue;
      map[item.sessionId] = {
        label: item.displayName,
        color: item.color,
      };
    }
    return map;
  };

  return {
    state,
    ready,
    hydrate: () => {
      const next = readState();
      setState(next);
      if (ready()) writeState(next);
    },
    markReady: () => {
      setReady(true);
      writeState(state());
      scheduleMissingDecorations();
    },
    flushPendingDecorations,
    subagentDecorationsBySessionId,
  };
}
