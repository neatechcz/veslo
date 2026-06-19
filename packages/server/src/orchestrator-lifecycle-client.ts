export type LifecycleRunStatus = "submitted" | "running" | "blocked" | "completed" | "failed" | "aborted";

export const ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER = "X-Veslo-Orchestrator-Token";

export type LifecycleRunStatusResult = {
  runId: string;
  status: LifecycleRunStatus;
  stale: boolean;
};

export const ORCHESTRATOR_LIFECYCLE_REQUEST_TIMEOUT_MS = 5_000;

export class RunAlreadyActiveError extends Error {
  readonly activeRunId: string;

  constructor(activeRunId: string) {
    super("run_already_active");
    this.name = "RunAlreadyActiveError";
    this.activeRunId = activeRunId;
  }
}

export class OrchestratorLifecycleRequestError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: unknown;

  constructor(path: string, status: number, body: unknown) {
    super(`orchestrator lifecycle request failed: ${status}`);
    this.name = "OrchestratorLifecycleRequestError";
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

export class OrchestratorLifecycleTimeoutError extends OrchestratorLifecycleRequestError {
  readonly timeoutMs: number;

  constructor(path: string, timeoutMs: number) {
    super(path, 504, { error: "request_timeout", timeoutMs });
    this.name = "OrchestratorLifecycleTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export type OrchestratorLifecycleClient = {
  register(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    engineSessionId: string;
    directory: string;
    kind: string;
  }): Promise<void>;
  markFailed(workspaceId: string, runId: string, error: string): Promise<void>;
  markAbortRequested(workspaceId: string, runId: string): Promise<void>;
  status(
    workspaceId: string,
    conversationId: string,
    runIdOrLatest: string,
  ): Promise<LifecycleRunStatusResult | null>;
  active(workspaceId: string, conversationId: string): Promise<LifecycleRunStatusResult | null>;
};

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export function createOrchestratorLifecycleClient(options: {
  daemonUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): OrchestratorLifecycleClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.daemonUrl.replace(/\/+$/, "");
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? Math.floor(options.timeoutMs ?? ORCHESTRATOR_LIFECYCLE_REQUEST_TIMEOUT_MS)
    : ORCHESTRATOR_LIFECYCLE_REQUEST_TIMEOUT_MS;
  const headers = {
    "Content-Type": "application/json",
    [ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER]: options.token,
  };

  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        try {
          controller?.abort();
        } catch {
          // ignore abort errors; the timeout error below is the API surface
        }
        reject(new OrchestratorLifecycleTimeoutError(path, timeoutMs));
      }, timeoutMs);
    });
    const initWithSignal =
      controller && !init?.signal
        ? { ...init, signal: controller.signal }
        : init;

    try {
      return await Promise.race([
        fetchImpl(`${baseUrl}${path}`, initWithSignal),
        timeoutPromise,
      ]);
    } catch (error) {
      if (error instanceof OrchestratorLifecycleTimeoutError) {
        throw error;
      }
      if (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new OrchestratorLifecycleTimeoutError(path, timeoutMs);
      }
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  const post = async (path: string, body: unknown): Promise<void> => {
    const response = await request(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (response.status === 409) {
      const payload = await readJsonSafely(response) as { activeRunId?: unknown } | null;
      throw new RunAlreadyActiveError(
        typeof payload?.activeRunId === "string" ? payload.activeRunId : "",
      );
    }
    if (!response.ok) {
      throw new OrchestratorLifecycleRequestError(path, response.status, await readJsonSafely(response));
    }
  };

  const getStatus = async (
    workspaceId: string,
    conversationId: string,
    runIdOrLatest: string,
  ): Promise<LifecycleRunStatusResult | null> => {
    const path = `/workspace/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runIdOrLatest)}`;
    const response = await request(path, { headers });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new OrchestratorLifecycleRequestError(path, response.status, await readJsonSafely(response));
    }
    const payload = await response.json() as {
      runId?: unknown;
      status?: unknown;
      stale?: unknown;
    };
    if (typeof payload.runId !== "string" || typeof payload.status !== "string") {
      throw new OrchestratorLifecycleRequestError(path, 502, payload);
    }
    return {
      runId: payload.runId,
      status: payload.status as LifecycleRunStatus,
      stale: payload.stale === true,
    };
  };

  return {
    async register(input) {
      await post(`/workspace/${encodeURIComponent(input.workspaceId)}/runs/register`, {
        conversationId: input.conversationId,
        runId: input.runId,
        engineSessionId: input.engineSessionId,
        directory: input.directory,
        kind: input.kind,
      });
    },

    async markFailed(workspaceId, runId, error) {
      await post(
        `/workspace/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/failed`,
        { error },
      );
    },

    async markAbortRequested(workspaceId, runId) {
      await post(
        `/workspace/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/abort-requested`,
        {},
      );
    },

    async status(workspaceId, conversationId, runIdOrLatest) {
      return getStatus(workspaceId, conversationId, runIdOrLatest);
    },

    async active(workspaceId, conversationId) {
      return getStatus(workspaceId, conversationId, "active");
    },
  };
}
