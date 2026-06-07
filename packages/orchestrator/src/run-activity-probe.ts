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

export function deriveRunActivityFromSessionStatus(
  payload: unknown,
  engineSessionId: string,
): RunProbeResult | null {
  if (!isRecord(payload)) return null;
  const sessionStatus = payload[engineSessionId];
  if (!isRecord(sessionStatus)) return null;

  const type = readString(sessionStatus.type);
  if (type === "busy" || type === "retry") return { active: true };
  if (type === "idle") return { active: false };
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

export function deriveRunActivityFromSessionMessages(payload: unknown): RunProbeResult {
  const messages = readMessages(payload);
  if (!messages.length) return { active: true };

  const latestInfo = readMessageInfo(messages[messages.length - 1]);
  if (!latestInfo) return { active: true };

  const latestRole = readString(latestInfo.role);
  if (latestRole !== "assistant") return { active: true };

  return { active: !assistantMessageIsTerminal(latestInfo) };
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
        if (activity) return activity;
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
