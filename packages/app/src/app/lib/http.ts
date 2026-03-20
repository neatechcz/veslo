/**
 * Shared HTTP utilities.
 *
 * Consolidates the duplicated fetchWithTimeout implementations from
 * opencode.ts and veslo-server.ts into a single shared module.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Fetch with an AbortController-based timeout.
 * Distinguishes AbortError from network errors — both become
 * descriptive Error instances.
 *
 * @param fetchImpl - The fetch implementation to use (globalThis.fetch, tauriFetch, etc.)
 * @param input - URL or Request
 * @param init - Standard RequestInit, optionally extended with timeoutMs
 * @param timeoutMs - Timeout in milliseconds (default 10s). Pass 0 or Infinity to disable.
 */
export async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(input, init);
  }

  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const initWithSignal =
    signal && !init?.signal ? { ...(init ?? {}), signal } : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetchImpl(input, initWithSignal),
      timeoutPromise,
    ]);
  } catch (error) {
    const name =
      error &&
      typeof error === "object" &&
      "name" in error
        ? (error as { name: string }).name
        : "";
    if (name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Convenience wrapper: fetch JSON with timeout, auto-headers, and error handling.
 */
export async function fetchJson<T>(
  url: string,
  opts?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof globalThis.fetch;
  },
): Promise<T> {
  const fetchFn = opts?.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...opts?.headers,
  };

  let bodyStr: string | undefined;
  if (opts?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(opts.body);
  }

  const response = await fetchWithTimeout(
    fetchFn,
    url,
    {
      method: opts?.method ?? (opts?.body ? "POST" : "GET"),
      headers,
      body: bodyStr,
      signal: opts?.signal,
    },
    opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!response.ok) {
    const preview = await response.text().catch(() => "");
    const suffix = preview ? `: ${preview.slice(0, 200)}` : "";
    throw new Error(`HTTP ${response.status}${suffix}`);
  }

  return (await response.json()) as T;
}
