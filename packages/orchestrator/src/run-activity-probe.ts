import type { RunProbeResult } from "./run-registry.js";

export const RUN_ACTIVITY_PROBE_TIMEOUT_MS = 4_000;

export type RunActivityProbeRecord = {
  workspaceId: string;
  engineSessionId: string;
  directory: string;
};

export type RunActivityEngineRequestInput = {
  workspaceId: string;
  directory: string;
  targetPath: string;
  method: "GET";
};

export type RunActivityEngineRequest = {
  url: string;
  headers: Record<string, string>;
};

type RecordLike = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordLike =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readPositiveFiniteNumber = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const terminalToolStatuses = new Set(["completed", "done", "success", "failed", "error", "cancelled", "canceled"]);

const stableString = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export function deriveRunActivityFromSessionStatus(
  payload: unknown,
  engineSessionId: string,
): RunProbeResult | null {
  if (!isRecord(payload)) return null;
  const sessionStatus = payload[engineSessionId];
  if (!isRecord(sessionStatus)) return null;

  const type = readString(sessionStatus.type);
  if (type === "busy") {
    return {
      active: true,
      activityKind: "unknown",
      waitReason: "assistant_message_open",
      progressSignature: `status:${engineSessionId}:busy`,
    };
  }
  if (type === "retry") {
    return {
      active: true,
      activityKind: "model_retry",
      waitReason: "model_retry_no_output",
      progressSignature: `status:${engineSessionId}:retry`,
    };
  }
  if (type === "idle") {
    return {
      active: false,
      activityKind: "idle",
      waitReason: "session_idle",
      progressSignature: `status:${engineSessionId}:idle`,
    };
  }
  return null;
}

function readMessages(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.items)) return payload.items;
  return [];
}

function readMessageInfo(message: unknown): RecordLike | null {
  if (!isRecord(message)) return null;
  if (isRecord(message.info)) return message.info;
  if (readString(message.role)) return message;
  return null;
}

function assistantMessageIsTerminal(info: RecordLike): boolean {
  const time = isRecord(info.time) ? info.time : null;
  if (time && readPositiveFiniteNumber(time.completed) !== null) return true;
  if (isRecord(info.error)) return true;
  if (readString(info.finish)) return true;
  return false;
}

function readParts(message: unknown): unknown[] {
  if (!isRecord(message)) return [];
  if (Array.isArray(message.parts)) return message.parts;
  return [];
}

function toolPartStatus(part: RecordLike): string {
  const state = isRecord(part.state) ? part.state : null;
  return readString(state?.status) ?? readString(part.status) ?? "";
}

function toolPartName(part: RecordLike): string {
  return readString(part.tool) ?? readString(part.name) ?? readString(part.type) ?? "tool";
}

function toolOutputSize(part: RecordLike): number {
  const state = isRecord(part.state) ? part.state : null;
  const output = state && "output" in state ? state.output : part.output;
  if (typeof output === "string") return output.length;
  if (Array.isArray(output)) return output.length;
  if (output && typeof output === "object") return stableString(output).length;
  return 0;
}

function textPartLength(part: RecordLike): number {
  const text = typeof part.text === "string" ? part.text : "";
  return text.trim() ? text.length : 0;
}

function messageProgressSignature(messages: unknown[], latestInfo: RecordLike, latestMessage: unknown): string {
  const id = readString(latestInfo.id) ?? readString(latestInfo.messageID) ?? "unknown";
  const role = readString(latestInfo.role) ?? "unknown";
  const parts = readParts(latestMessage);
  const descriptors = parts
    .map((part) => {
      if (!isRecord(part)) return "";
      const type = readString(part.type) ?? "";
      if (type === "tool") {
        return `tool:${toolPartName(part)}:${toolPartStatus(part)}:${toolOutputSize(part)}`;
      }
      if (type === "text" || type === "reasoning") {
        const text = typeof part.text === "string" ? part.text : "";
        const length = textPartLength(part);
        return length ? `${type}:${length}:${text.slice(-48)}` : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("|");
  const terminal = assistantMessageIsTerminal(latestInfo) ? "terminal" : "open";
  return `messages:${messages.length}:latest:${id}:${role}:${terminal}:visible:${descriptors}`;
}

export function deriveRunActivityFromSessionMessages(payload: unknown): RunProbeResult {
  const messages = readMessages(payload);
  if (!messages.length) {
    return {
      active: true,
      activityKind: "unknown",
      waitReason: "assistant_message_open",
      progressSignature: "messages:0",
    };
  }

  const latestMessage = messages[messages.length - 1];
  const latestInfo = readMessageInfo(latestMessage);
  if (!latestInfo) {
    return {
      active: true,
      activityKind: "unknown",
      waitReason: "assistant_message_open",
      progressSignature: `messages:${messages.length}:latest:unknown`,
    };
  }

  const latestRole = readString(latestInfo.role);
  if (latestRole !== "assistant") {
    return {
      active: true,
      activityKind: "unknown",
      waitReason: "assistant_message_open",
      progressSignature: messageProgressSignature(messages, latestInfo, latestMessage),
    };
  }

  const progressSignature = messageProgressSignature(messages, latestInfo, latestMessage);
  const parts = readParts(latestMessage);
  if (assistantMessageIsTerminal(latestInfo)) {
    return {
      active: false,
      activityKind: "idle",
      waitReason: "session_idle",
      progressSignature,
    };
  }

  const activeTool = parts.find((part) => {
    if (!isRecord(part)) return false;
    if (readString(part.type) !== "tool") return false;
    const status = toolPartStatus(part).toLowerCase();
    return !status || !terminalToolStatuses.has(status);
  });
  if (activeTool) {
    return {
      active: true,
      activityKind: "local_tool",
      waitReason: "running_tool",
      progressSignature,
    };
  }

  const hasAssistantOutput = parts.some((part) =>
    isRecord(part) &&
    (readString(part.type) === "text" || readString(part.type) === "reasoning") &&
    textPartLength(part) > 0
  );
  if (hasAssistantOutput) {
    return {
      active: true,
      activityKind: "assistant_output",
      waitReason: "assistant_message_open",
      progressSignature,
    };
  }

  return {
    active: true,
    activityKind: "unknown",
    waitReason: "assistant_message_open",
    progressSignature,
  };
}

function mergeRetryStatusWithMessages(messages: RunProbeResult): RunProbeResult {
  if ("unreachable" in messages) return messages;
  if (!messages.active) return messages;
  if (messages.activityKind === "local_tool" || messages.activityKind === "assistant_output") {
    return messages;
  }
  return {
    ...messages,
    activityKind: "model_retry",
    waitReason: "model_retry_no_output",
  };
}

export function createRunActivityProbe<Engine>(deps: {
  getEngine: (workspaceId: string) => Engine | null | undefined;
  buildEngineRequest: (
    engine: Engine,
    input: RunActivityEngineRequestInput,
  ) => RunActivityEngineRequest;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): (record: RunActivityProbeRecord) => Promise<RunProbeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs =
    Number.isFinite(deps.timeoutMs ?? NaN) && (deps.timeoutMs ?? 0) > 0
      ? Math.floor(deps.timeoutMs ?? RUN_ACTIVITY_PROBE_TIMEOUT_MS)
      : RUN_ACTIVITY_PROBE_TIMEOUT_MS;

  const fetchJson = async (
    engine: Engine,
    record: RunActivityProbeRecord,
    targetPath: string,
  ): Promise<{ status: number; ok: boolean; payload: unknown }> => {
    const engineRequest = deps.buildEngineRequest(engine, {
      workspaceId: record.workspaceId,
      directory: record.directory,
      targetPath,
      method: "GET",
    });
    const response = await fetchImpl(engineRequest.url, {
      headers: engineRequest.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { status: response.status, ok: false, payload: null };
    }
    return { status: response.status, ok: true, payload: await response.json() };
  };

  return async (record) => {
    const engine = deps.getEngine(record.workspaceId);
    if (!engine) return { active: false };

    try {
      const status = await fetchJson(engine, record, "/session/status");
      if (status.ok) {
        const activity = deriveRunActivityFromSessionStatus(status.payload, record.engineSessionId);
        if (activity && !("unreachable" in activity)) {
          const messages = await fetchJson(
            engine,
            record,
            `/session/${encodeURIComponent(record.engineSessionId)}/message`,
          );
          if (messages.status === 404) return { active: false };
          if (!messages.ok) return { unreachable: true };
          const messageActivity = deriveRunActivityFromSessionMessages(messages.payload);
          if ("unreachable" in messageActivity) return messageActivity;
          if (!activity.active) {
            return activity;
          }
          // OpenCode can leave /session/status at busy briefly after it has written a
          // terminal assistant message. For one server-owned run, explicit transcript
          // completion is stronger evidence than that stale status; otherwise the UI
          // keeps rendering a second "responding" state beneath the completed reply.
          if (!messageActivity.active) {
            return messageActivity;
          }
          if (activity.activityKind === "model_retry") {
            return mergeRetryStatusWithMessages(messageActivity);
          }
          return messageActivity.activityKind === "local_tool" || messageActivity.activityKind === "assistant_output"
            ? messageActivity
            : activity;
        }
      } else if (status.status !== 404) {
        return { unreachable: true };
      }

      const messages = await fetchJson(
        engine,
        record,
        `/session/${encodeURIComponent(record.engineSessionId)}/message`,
      );
      if (messages.status === 404) return { active: false };
      if (!messages.ok) return { unreachable: true };
      return deriveRunActivityFromSessionMessages(messages.payload);
    } catch {
      return { unreachable: true };
    }
  };
}
