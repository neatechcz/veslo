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
