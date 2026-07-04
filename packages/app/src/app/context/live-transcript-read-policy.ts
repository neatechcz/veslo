import { createSignal } from "solid-js";

export type LiveTranscriptReadPolicyEvent =
  | {
      type: "conversation-run.succeeded";
      workspaceId?: string | null;
      sessionId?: string | null;
      traceId?: string | null;
      reason: "sendPrompt:success";
    }
  | {
      type: "conversation-compact.succeeded";
      workspaceId?: string | null;
      sessionId?: string | null;
      traceId?: string | null;
      reason: "sendPrompt:compact-success";
    };

export type LiveTranscriptReadAllowance = {
  workspaceId: string;
  reason: LiveTranscriptReadPolicyEvent["reason"];
  eventType: LiveTranscriptReadPolicyEvent["type"];
  sessionId: string | null;
  traceId: string | null;
  allowedAt: number;
};

export type LiveTranscriptReadPolicyOptions = {
  activeWorkspaceId: () => string;
  now?: () => number;
  record?: (event: string, payload?: Record<string, unknown>) => void;
};

export type LiveTranscriptReadPolicy = {
  emit: (event: LiveTranscriptReadPolicyEvent) => void;
  isAllowedForWorkspace: (workspaceId?: string | null) => boolean;
  allowanceForWorkspace: (workspaceId?: string | null) => LiveTranscriptReadAllowance | null;
  allowedWorkspaceIds: () => ReadonlySet<string>;
};

export function createLiveTranscriptReadPolicy(
  options: LiveTranscriptReadPolicyOptions,
): LiveTranscriptReadPolicy {
  const now = options.now ?? (() => Date.now());
  const [allowancesByWorkspaceId, setAllowancesByWorkspaceId] =
    createSignal<Record<string, LiveTranscriptReadAllowance>>({});

  const resolveWorkspaceId = (workspaceId?: string | null) =>
    workspaceId?.trim() || options.activeWorkspaceId().trim();

  const allowanceForWorkspace = (workspaceId?: string | null) => {
    const id = resolveWorkspaceId(workspaceId);
    return id ? allowancesByWorkspaceId()[id] ?? null : null;
  };

  const allow = (event: LiveTranscriptReadPolicyEvent) => {
    const workspaceId = resolveWorkspaceId(event.workspaceId);
    if (!workspaceId) return;
    setAllowancesByWorkspaceId((current) => {
      if (current[workspaceId]) return current;
      const allowance: LiveTranscriptReadAllowance = {
        workspaceId,
        reason: event.reason,
        eventType: event.type,
        sessionId: event.sessionId?.trim() || null,
        traceId: event.traceId?.trim() || null,
        allowedAt: now(),
      };
      options.record?.("live-transcript-read:allowed", allowance);
      return {
        ...current,
        [workspaceId]: allowance,
      };
    });
  };

  return {
    emit(event) {
      allow(event);
    },
    isAllowedForWorkspace(workspaceId) {
      return Boolean(allowanceForWorkspace(workspaceId));
    },
    allowanceForWorkspace,
    allowedWorkspaceIds() {
      return new Set(Object.keys(allowancesByWorkspaceId()));
    },
  };
}
