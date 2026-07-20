export type OpenCodeProjectApiFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type OpenCodeProjectApiProbeEndpoint = {
  ok: boolean;
  status?: number;
  error?: string;
};

export type OpenCodeProjectApiProbeResult = {
  available: boolean;
  baseUrl: string;
  directory?: string;
  project: OpenCodeProjectApiProbeEndpoint;
  config?: OpenCodeProjectApiProbeEndpoint;
  provider?: OpenCodeProjectApiProbeEndpoint;
};

export type OpenCodeMcpPrimeResult = OpenCodeProjectApiProbeEndpoint & {
  baseUrl: string;
  directory: string;
};

export type OpenCodeMcpRuntimePrimeInput = {
  workspaceId: string;
  baseUrl: string;
  directory: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export type OpenCodeMcpRuntimePrimeFlight = {
  owner: boolean;
  promise: Promise<OpenCodeMcpPrimeResult>;
};

async function probeEndpoint(input: {
  fetchImpl: OpenCodeProjectApiFetch;
  url: string;
  headers?: Record<string, string>;
  timeoutMs: number;
}): Promise<OpenCodeProjectApiProbeEndpoint> {
  try {
    const response = await input.fetchImpl(input.url, {
      headers: input.headers,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function withDirectory(baseUrl: string, path: string, directory: string): string {
  const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
  url.searchParams.set("directory", directory);
  return url.toString();
}

export async function probeOpenCodeProjectApi(input: {
  baseUrl: string;
  directory?: string;
  headers?: Record<string, string>;
  fetchImpl?: OpenCodeProjectApiFetch;
  timeoutMs?: number;
}): Promise<OpenCodeProjectApiProbeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs =
    Number.isFinite(input.timeoutMs ?? NaN) && (input.timeoutMs ?? 0) > 0
      ? Math.floor(input.timeoutMs ?? 0)
      : 2_000;
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const project = await probeEndpoint({
    fetchImpl,
    url: `${baseUrl}/project`,
    headers: input.headers,
    timeoutMs,
  });

  if (!project.ok) {
    return {
      available: false,
      baseUrl,
      directory: input.directory,
      project,
    };
  }

  const result: OpenCodeProjectApiProbeResult = {
    available: true,
    baseUrl,
    directory: input.directory,
    project,
  };

  if (input.directory?.trim()) {
    result.config = await probeEndpoint({
      fetchImpl,
      url: withDirectory(baseUrl, "/config", input.directory),
      headers: input.headers,
      timeoutMs,
    });
    result.provider = await probeEndpoint({
      fetchImpl,
      url: withDirectory(baseUrl, "/provider", input.directory),
      headers: input.headers,
      timeoutMs,
    });
    result.available = Boolean(result.config.ok && result.provider.ok);
  }

  return result;
}

/**
 * Starts OpenCode's configured MCP transports outside a user prompt. OpenCode
 * initializes local MCP commands lazily, so invoking the normal status endpoint
 * while a workspace is activated keeps that startup off the first-send path.
 */
export async function primeOpenCodeMcpRuntime(input: {
  baseUrl: string;
  directory: string;
  headers?: Record<string, string>;
  fetchImpl?: OpenCodeProjectApiFetch;
  timeoutMs?: number;
}): Promise<OpenCodeMcpPrimeResult> {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const directory = input.directory.trim();
  const result = await probeEndpoint({
    fetchImpl: input.fetchImpl ?? fetch,
    url: withDirectory(baseUrl, "/mcp", directory),
    headers: input.headers,
    timeoutMs:
      Number.isFinite(input.timeoutMs ?? NaN) && (input.timeoutMs ?? 0) > 0
        ? Math.floor(input.timeoutMs ?? 0)
        : 20_000,
  });
  return { baseUrl, directory, ...result };
}

/**
 * Tracks the optional MCP warm-up started during workspace activation. A
 * failed warm-up remains an ordinary prompt fallback rather than a send
 * failure.
 */
export function createOpenCodeMcpRuntimePrimeFlights(options: {
  prime?: (input: Omit<OpenCodeMcpRuntimePrimeInput, "workspaceId">) => Promise<OpenCodeMcpPrimeResult>;
} = {}) {
  const prime = options.prime ?? primeOpenCodeMcpRuntime;
  const pendingByWorkspace = new Map<string, Promise<OpenCodeMcpPrimeResult>>();

  const start = (input: OpenCodeMcpRuntimePrimeInput): OpenCodeMcpRuntimePrimeFlight => {
    const workspaceId = input.workspaceId.trim();
    const existing = pendingByWorkspace.get(workspaceId);
    if (existing) return { owner: false, promise: existing };

    const promise = Promise.resolve()
      .then(() => prime({
        baseUrl: input.baseUrl,
        directory: input.directory,
        headers: input.headers,
        timeoutMs: input.timeoutMs,
      }))
      .catch((error): OpenCodeMcpPrimeResult => ({
        ok: false,
        baseUrl: input.baseUrl.replace(/\/$/, ""),
        directory: input.directory.trim(),
        error: error instanceof Error ? error.message : String(error),
      }));
    pendingByWorkspace.set(workspaceId, promise);
    void promise.then(() => {
      if (pendingByWorkspace.get(workspaceId) === promise) {
        pendingByWorkspace.delete(workspaceId);
      }
    });
    return { owner: true, promise };
  };

  return {
    start,
    join: (workspaceId: string) => pendingByWorkspace.get(workspaceId.trim()) ?? null,
  };
}

/**
 * Records the result of an optional MCP warm-up without placing it on a user
 * request's critical path. `createOpenCodeMcpRuntimePrimeFlights` converts
 * failures into a result, but the rejection handler keeps this observer safe
 * should a different producer be supplied in the future.
 */
export function observeOpenCodeMcpRuntimePrime(
  promise: Promise<OpenCodeMcpPrimeResult>,
  onSettled: (result: OpenCodeMcpPrimeResult) => void,
): void {
  void promise.then(onSettled, () => {});
}
