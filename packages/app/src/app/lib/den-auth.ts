import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "../utils";

const DEN_AUTH_STORAGE_KEY = "veslo.den.auth";
const DEFAULT_DEN_API_BASE = "https://openwork-den-dev-api.onrender.com";
const DEN_EXCHANGE_TIMEOUT_MS = 12_000;
const DEN_VALIDATE_TIMEOUT_MS = 8_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const resolveFetch = (): FetchLike => (isTauriRuntime() ? tauriFetch : globalThis.fetch);

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const initWithSignal = signal && !init.signal ? { ...init, signal } : init;

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
    return await Promise.race([fetchImpl(url, initWithSignal), timeoutPromise]);
  } catch (error) {
    const name = (error && typeof error === "object" && "name" in error ? (error as { name?: string }).name : "") ?? "";
    if (name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export type DenAuthState = {
  denApiBase: string;
  token: string;
  orgId: string;
  user: { id: string };
  org: { id: string; name?: string; slug?: string; role?: string };
};

export type DenExchangeResult =
  | { ok: true; state: DenAuthState }
  | { ok: false; error: string };

export function getDenApiBase(): string {
  if (typeof import.meta !== "undefined") {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    const fromEnv = env?.VITE_DEN_API_BASE?.trim();
    if (fromEnv) return fromEnv.replace(/\/+$/, "");
  }
  return DEFAULT_DEN_API_BASE;
}

export function readDenAuth(): DenAuthState | null {
  try {
    const raw = window.localStorage.getItem(DEN_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "denApiBase" in parsed &&
      "token" in parsed &&
      "orgId" in parsed
    ) {
      return parsed as DenAuthState;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeDenAuth(state: DenAuthState): void {
  try {
    window.localStorage.setItem(DEN_AUTH_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore storage errors
  }
}

export function clearDenAuth(): void {
  try {
    window.localStorage.removeItem(DEN_AUTH_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export async function exchangeHandoffCode(code: string): Promise<DenExchangeResult> {
  const denApiBase = getDenApiBase();
  try {
    const response = await fetchWithTimeout(
      resolveFetch(),
      `${denApiBase}/v1/desktop-auth/exchange`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      },
      DEN_EXCHANGE_TIMEOUT_MS,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let errorMessage = `Exchange failed (${response.status})`;
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.error === "string") {
          errorMessage = parsed.error;
        }
      } catch {
        // use default message
      }
      return { ok: false, error: errorMessage };
    }

    const payload = (await response.json()) as {
      token?: string;
      user?: { id?: string };
      org?: { id?: string; name?: string; slug?: string; role?: string };
    };

    const userId = payload?.user?.id;
    const orgId = payload?.org?.id;
    if (!userId || !orgId) {
      return { ok: false, error: "Invalid exchange response" };
    }

    const state: DenAuthState = {
      denApiBase,
      token: payload.token ?? code,
      orgId,
      user: { id: userId },
      org: {
        id: orgId,
        name: payload.org?.name,
        slug: payload.org?.slug,
        role: payload.org?.role,
      },
    };

    return { ok: true, state };
  } catch (err) {
    if (err instanceof Error && err.message === "Failed to fetch") {
      return {
        ok: false,
        error: "Failed to reach the Openwork auth API. Check your network or API CORS settings.",
      };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

export async function validateDenAuth(state: DenAuthState): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      resolveFetch(),
      `${state.denApiBase}/v1/me`,
      {
        headers: { Authorization: `Bearer ${state.token}` },
      },
      DEN_VALIDATE_TIMEOUT_MS,
    );
    return response.ok;
  } catch {
    return false;
  }
}

export function parseAuthCompleteDeepLink(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== "veslo:" && protocol !== "https:" && protocol !== "http:") {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  if (routeHost !== "auth-complete" && routePath !== "auth-complete") {
    return null;
  }

  const code = url.searchParams.get("code")?.trim() ?? "";
  return code || null;
}
