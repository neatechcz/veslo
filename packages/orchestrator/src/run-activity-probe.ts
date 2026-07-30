import { deriveConversationRunOpenCodeMessageId } from "./conversation-run-message-id.js";
import type { RunProbeResult } from "./run-registry.js";

export const RUN_ACTIVITY_PROBE_TIMEOUT_MS = 4_000;

export type RunActivityProbeRecord = {
  workspaceId: string;
  engineSessionId: string;
  directory: string;
  createdAt?: number | null;
  clientMessageId?: string | null;
  opencodeMessageId?: string | null;
  kind?: string | null;
  abortRequested?: boolean;
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

function messageIdentity(info: RecordLike): string | null {
  return readString(info.id) ?? readString(info.messageID);
}

function assistantMessageIsTerminal(info: RecordLike): boolean {
  const time = isRecord(info.time) ? info.time : null;
  if (time && readPositiveFiniteNumber(time.completed) !== null) return true;
  if (isRecord(info.error)) return true;
  if (readString(info.finish)) return true;
  return false;
}

function readAssistantError(info: RecordLike): RecordLike | null {
  return isRecord(info.error) ? info.error : null;
}

function assistantErrorMessage(error: RecordLike): string | null {
  const data = isRecord(error.data) ? error.data : null;
  return readString(data?.message) ?? readString(error.message) ?? readString(error.detail);
}

function unsupportedAttachmentRuntimeError(message: string | null): boolean {
  const normalized = message?.toLowerCase() ?? "";
  if (!normalized) return false;
  const mentionsInputType = normalized.includes("file") || normalized.includes("media") || normalized.includes("mime");
  const rejectsType = normalized.includes("not supported") || normalized.includes("unsupported") || normalized.includes("unknown file type");
  return mentionsInputType && rejectsType;
}

function assistantTerminalOutcome(
  info: RecordLike,
  abortRequested: boolean,
): { terminalStatus: "completed" | "failed" | "aborted"; terminalError: string | null } {
  const error = readAssistantError(info);
  if (!error) return { terminalStatus: "completed", terminalError: null };
  const name = readString(error.name) ?? "OpenCodeError";
  const message = assistantErrorMessage(error);
  if (name === "MessageAbortedError") {
    return abortRequested
      ? { terminalStatus: "aborted", terminalError: "Run aborted" }
      : { terminalStatus: "failed", terminalError: "unexpected_message_abort" };
  }
  if (unsupportedAttachmentRuntimeError(message)) {
    return { terminalStatus: "failed", terminalError: "attachment_runtime_rejected" };
  }
  const safeMessage = message?.replace(/\s+/g, " ").trim().slice(0, 300) || name;
  return { terminalStatus: "failed", terminalError: safeMessage };
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

function meaningfulAssistantPartDescriptor(part: RecordLike): string | null {
  const type = readString(part.type);
  if (type === "text" || type === "reasoning") {
    const length = textPartLength(part);
    return length ? `${type}:${length}` : null;
  }
  if (type === "tool") return "tool";
  if (type === "file") return readString(part.url) ? "file" : null;
  if (type === "agent") return readString(part.name) ? "agent" : null;
  if (type === "subtask") {
    return readString(part.agent) || readString(part.prompt) || readString(part.description)
      ? "subtask"
      : null;
  }
  if (type === "patch") {
    return Array.isArray(part.files) && part.files.length > 0 ? "patch" : null;
  }
  return null;
}

function hasMeaningfulAssistantContent(parts: unknown[]): boolean {
  return parts.some((part) => isRecord(part) && meaningfulAssistantPartDescriptor(part) !== null);
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
      return meaningfulAssistantPartDescriptor(part) ?? "";
    })
    .filter(Boolean)
    .join("|");
  const terminal = assistantMessageIsTerminal(latestInfo) ? "terminal" : "open";
  return `messages:${messages.length}:latest:${id}:${role}:${terminal}:visible:${descriptors}`;
}

export function deriveRunActivityFromSessionMessages(
  payload: unknown,
  options?: {
    expectedUserMessageId?: string | null;
    abortRequested?: boolean;
    sessionInactiveObserved?: boolean;
    sessionExplicitlyIdle?: boolean;
  },
): RunProbeResult {
  const messages = readMessages(payload);
  const expectedUserMessageId = options?.expectedUserMessageId?.trim() || "";
  const inactiveExactRunPending = (progressSignature: string): RunProbeResult => ({
    active: true,
    activityKind: "unknown",
    waitReason: "assistant_message_open",
    progressSignature: `inactive-session:${progressSignature}`,
  });

  if (!messages.length) {
    if (expectedUserMessageId && options?.sessionInactiveObserved) {
      return inactiveExactRunPending(`expected-user:${expectedUserMessageId}:messages-empty`);
    }
    return {
      active: true,
      activityKind: "unknown",
      waitReason: "assistant_message_open",
      progressSignature: "messages:0",
    };
  }

  let latestMessage = messages[messages.length - 1];
  if (expectedUserMessageId) {
    const exactUserIndex = messages.findIndex((message) => {
      const info = readMessageInfo(message);
      return Boolean(info && readString(info.role) === "user" && messageIdentity(info) === expectedUserMessageId);
    });
    if (exactUserIndex < 0) {
      if (options?.sessionInactiveObserved) {
        return inactiveExactRunPending(`expected-user:${expectedUserMessageId}:missing`);
      }
      return {
        active: true,
        activityKind: "unknown",
        waitReason: "assistant_message_open",
        progressSignature: `expected-user:${expectedUserMessageId}:missing`,
      };
    }
    const exactAssistants = messages.slice(exactUserIndex + 1).filter((message) => {
      const info = readMessageInfo(message);
      return Boolean(
        info &&
        readString(info.role) === "assistant" &&
        readString(info.parentID) === expectedUserMessageId
      );
    });
    if (!exactAssistants.length) {
      if (options?.sessionInactiveObserved) {
        return inactiveExactRunPending(`expected-user:${expectedUserMessageId}:assistant-missing`);
      }
      return {
        active: true,
        activityKind: "unknown",
        waitReason: "assistant_message_open",
        progressSignature: `expected-user:${expectedUserMessageId}:assistant-missing`,
      };
    }
    latestMessage = exactAssistants[exactAssistants.length - 1];
  }
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

  const hasMeaningfulAssistantOutput = hasMeaningfulAssistantContent(parts);

  if (assistantMessageIsTerminal(latestInfo)) {
    const terminalOutcome = assistantTerminalOutcome(latestInfo, options?.abortRequested === true);
    return {
      active: false,
      terminalCandidate: true,
      terminalConfirmed: Boolean(expectedUserMessageId),
      ...(terminalOutcome.terminalStatus === "completed" && !hasMeaningfulAssistantOutput
        ? { terminalStatus: "failed" as const, terminalError: "assistant_completed_without_visible_output" }
        : terminalOutcome),
      activityKind: "idle",
      waitReason: "session_idle",
      progressSignature,
    };
  }

  if (hasMeaningfulAssistantOutput) {
    // A visible response tied to this exact admitted user message is safe to
    // complete once OpenCode explicitly reports the session idle. Some
    // OpenCode/provider paths persist the response without a finish marker;
    // return a non-authoritative candidate so the registry still requires two
    // stable probes before it terminalizes the run.
    if (expectedUserMessageId && options?.sessionExplicitlyIdle) {
      return {
        active: false,
        terminalCandidate: true,
        terminalStatus: "completed",
        activityKind: "idle",
        waitReason: "session_idle",
        progressSignature: `inactive-session:${progressSignature}`,
      };
    }
    if (expectedUserMessageId && options?.sessionInactiveObserved) {
      return inactiveExactRunPending(progressSignature);
    }
    return {
      active: true,
      activityKind: "assistant_output",
      waitReason: "assistant_message_open",
      progressSignature,
    };
  }

  if (expectedUserMessageId && options?.sessionInactiveObserved) {
    return inactiveExactRunPending(progressSignature);
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

function sessionExplicitlyIdleIsObserved(payload: unknown, engineSessionId: string): boolean {
  if (!isRecord(payload)) return false;
  if (!Object.prototype.hasOwnProperty.call(payload, engineSessionId)) return false;
  const status = payload[engineSessionId];
  return isRecord(status) && readString(status.type) === "idle";
}

function sessionInactiveIsObserved(payload: unknown, engineSessionId: string): boolean {
  if (!isRecord(payload)) return false;
  return !Object.prototype.hasOwnProperty.call(payload, engineSessionId) ||
    sessionExplicitlyIdleIsObserved(payload, engineSessionId);
}

function latestMessageCreatedAt(payload: unknown): number | null {
  const messages = readMessages(payload);
  const latest = messages[messages.length - 1];
  const info = readMessageInfo(latest);
  if (!info) return null;
  const time = isRecord(info.time) ? info.time : null;
  return readPositiveFiniteNumber(time?.created) ?? null;
}

function terminalEvidenceIsPostAdmission(
  payload: unknown,
  record: Pick<RunActivityProbeRecord, "workspaceId" | "engineSessionId" | "createdAt" | "clientMessageId" | "opencodeMessageId" | "kind">,
): boolean {
  const messages = readMessages(payload);
  if (record.kind === "prompt" && record.clientMessageId?.trim()) {
    const expectedId = record.opencodeMessageId?.trim() || deriveConversationRunOpenCodeMessageId({
      workspaceId: record.workspaceId,
      engineSessionId: record.engineSessionId,
      clientMessageId: record.clientMessageId,
    });
    const admissionIndex = messages.findIndex((message) => messageIdentity(readMessageInfo(message) ?? {}) === expectedId);
    if (admissionIndex < 0) return false;
    return messages.some((message, index) => {
      if (index <= admissionIndex) return false;
      const info = readMessageInfo(message);
      return Boolean(
        info &&
        readString(info.role) === "assistant" &&
        readString(info.parentID) === expectedId,
      );
    });
  }
  if (!Number.isFinite(record.createdAt ?? NaN)) return true;
  const createdAt = latestMessageCreatedAt(payload);
  return createdAt !== null && createdAt > (record.createdAt as number);
}

function expectedUserMessageIdForRecord(record: RunActivityProbeRecord): string | null {
  if (record.kind !== "prompt" || !record.clientMessageId?.trim()) return null;
  if (record.opencodeMessageId?.trim()) return record.opencodeMessageId.trim();
  return deriveConversationRunOpenCodeMessageId({
    workspaceId: record.workspaceId,
    engineSessionId: record.engineSessionId,
    clientMessageId: record.clientMessageId,
  });
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
    if (!engine) return { unreachable: true };

    try {
      const status = await fetchJson(engine, record, "/session/status");
      let statusActivity: RunProbeResult | null = null;
      let sessionInactiveObserved = false;
      let sessionExplicitlyIdle = false;
      if (status.ok) {
        statusActivity = deriveRunActivityFromSessionStatus(status.payload, record.engineSessionId);
        sessionInactiveObserved = sessionInactiveIsObserved(status.payload, record.engineSessionId);
        sessionExplicitlyIdle = sessionExplicitlyIdleIsObserved(status.payload, record.engineSessionId);
      } else if (status.status !== 404) {
        return { unreachable: true };
      }

      const messages = await fetchJson(
        engine,
        record,
        `/session/${encodeURIComponent(record.engineSessionId)}/message`,
      );
      if (messages.status === 404) return { unreachable: true };
      if (!messages.ok) return { unreachable: true };
      const messageActivity = deriveRunActivityFromSessionMessages(messages.payload, {
        expectedUserMessageId: expectedUserMessageIdForRecord(record),
        abortRequested: record.abortRequested === true,
        sessionInactiveObserved,
        sessionExplicitlyIdle,
      });
      if ("unreachable" in messageActivity) return messageActivity;
      if (
        !messageActivity.active &&
        !terminalEvidenceIsPostAdmission(messages.payload, record)
      ) {
        return {
          active: true,
          activityKind: "unknown",
          waitReason: "assistant_message_open",
          progressSignature: `pre-admission:${messageActivity.progressSignature ?? "terminal"}`,
        };
      }
      if (statusActivity && !("unreachable" in statusActivity)) {
        // OpenCode can leave /session/status at busy briefly after it has written a
        // terminal assistant message. Exact transcript completion is stronger evidence.
        if (!messageActivity.active) return messageActivity;
        if (statusActivity.activityKind === "model_retry") {
          return mergeRetryStatusWithMessages(messageActivity);
        }
        return messageActivity;
      }
      return messageActivity;
    } catch {
      return { unreachable: true };
    }
  };
}
