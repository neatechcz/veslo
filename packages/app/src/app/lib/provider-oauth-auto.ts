import { fetchWithTimeout } from "./http";

const DEFAULT_CALLBACK_LISTENER_TIMEOUT_MS = 5_000;
const DEFAULT_CALLBACK_LISTENER_POLL_MS = 25;
const DEFAULT_CALLBACK_LISTENER_REQUEST_TIMEOUT_MS = 250;

export type SettledAsyncResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export function settleAsyncResult<T>(promise: Promise<T>): Promise<SettledAsyncResult<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
}

export function extractProviderOAuthCallbackProbeUrl(authorizationUrl: string): string | null {
  try {
    const parsed = new URL(authorizationUrl);
    const redirectUri = parsed.searchParams.get("redirect_uri");
    if (!redirectUri) return null;
    const redirectUrl = new URL(redirectUri);
    if (redirectUrl.protocol !== "http:" && redirectUrl.protocol !== "https:") {
      return null;
    }
    return new URL("/", redirectUrl).toString();
  } catch {
    return null;
  }
}

export async function waitForProviderOAuthCallbackListener(
  authorizationUrl: string,
  options?: {
    fetchImpl?: typeof globalThis.fetch;
    timeoutMs?: number;
    pollMs?: number;
    requestTimeoutMs?: number;
  },
): Promise<boolean> {
  const probeUrl = extractProviderOAuthCallbackProbeUrl(authorizationUrl);
  if (!probeUrl) return false;

  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CALLBACK_LISTENER_TIMEOUT_MS;
  const pollMs = options?.pollMs ?? DEFAULT_CALLBACK_LISTENER_POLL_MS;
  const requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_CALLBACK_LISTENER_REQUEST_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fetchWithTimeout(
        fetchImpl,
        probeUrl,
        {
          method: "GET",
        },
        requestTimeoutMs,
      );
      return true;
    } catch {
      // Keep polling until the local callback listener is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return false;
}
