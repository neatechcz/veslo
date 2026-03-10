const DEN_AUTH_STORAGE_KEY = "veslo.den.auth";
const DEFAULT_DEN_API_BASE = "https://openwork-den-dev-api.onrender.com";

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
    const response = await fetch(`${denApiBase}/v1/desktop-auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

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
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

export async function validateDenAuth(state: DenAuthState): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const response = await fetch(`${state.denApiBase}/v1/me`, {
      headers: { Authorization: `Bearer ${state.token}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
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
