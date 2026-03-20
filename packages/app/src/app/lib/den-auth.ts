import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "../utils";

const DEN_AUTH_STORAGE_KEY = "veslo.den.auth";
const DEN_KEEP_SIGNED_IN_STORAGE_KEY = "veslo.den.keepSignedIn";
const DEN_API_BASE_OVERRIDE_STORAGE_KEY = "veslo.den.apiBaseOverride";
const DEN_DESKTOP_AUTH_PENDING_STORAGE_KEY = "veslo.den.desktopAuthPending";
const DEFAULT_DEN_API_BASE = "https://openwork-den-dev-api.onrender.com";
const DEN_START_TIMEOUT_MS = 12_000;
const DEN_EXCHANGE_TIMEOUT_MS = 12_000;
const DEN_VALIDATE_TIMEOUT_MS = 8_000;
const DESKTOP_AUTH_STATE_BYTES = 32;
const DESKTOP_AUTH_CODE_VERIFIER_BYTES = 48;
const DESKTOP_AUTH_FALLBACK_TTL_MS = 10 * 60 * 1000;

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
  user: { id: string; name?: string; email?: string };
  org: { id: string; name?: string; slug?: string; role?: string };
};

export type DenExchangeResult =
  | { ok: true; state: DenAuthState }
  | { ok: false; error: string };

export type DenApiBaseOverrideWriteResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

export type DesktopAuthExchangeProof = {
  sessionId: string;
  state: string;
  codeVerifier: string;
};

type PendingDesktopAuth = DesktopAuthExchangeProof & {
  expiresAt: number;
};

export type DesktopAuthStartResult =
  | { ok: true; authorizeUrl: string; sessionId: string }
  | { ok: false; error: string };

export type AuthCompleteDeepLinkPayload = {
  code: string;
  sessionId: string | null;
};

function localStorageAccess(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function sessionStorageAccess(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function storage(): Storage | null {
  return localStorageAccess();
}

function normalizeDenApiBase(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!parsed.hostname) return null;
    parsed.search = "";
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${pathname === "/" ? "" : pathname}`;
  } catch {
    return null;
  }
}

function envDenApiBase(): string | null {
  if (typeof import.meta !== "undefined") {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    const fromEnv = env?.VITE_DEN_API_BASE;
    const normalized = fromEnv ? normalizeDenApiBase(fromEnv) : null;
    if (normalized) return normalized;
  }
  return null;
}

export function getDefaultDenApiBase(): string {
  return envDenApiBase() ?? DEFAULT_DEN_API_BASE;
}

export function readDenApiBaseOverride(): string | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(DEN_API_BASE_OVERRIDE_STORAGE_KEY);
    if (!raw) return null;
    const normalized = normalizeDenApiBase(raw);
    if (!normalized) {
      store.removeItem(DEN_API_BASE_OVERRIDE_STORAGE_KEY);
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

export function writeDenApiBaseOverride(value: string): DenApiBaseOverrideWriteResult {
  const store = storage();
  if (!store) {
    return { ok: false, error: "Local storage is unavailable in this environment." };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    try {
      store.removeItem(DEN_API_BASE_OVERRIDE_STORAGE_KEY);
      return { ok: true, value: null };
    } catch {
      return { ok: false, error: "Failed to clear endpoint override." };
    }
  }

  const normalized = normalizeDenApiBase(trimmed);
  if (!normalized) {
    return { ok: false, error: "Enter a valid http(s) URL." };
  }

  try {
    store.setItem(DEN_API_BASE_OVERRIDE_STORAGE_KEY, normalized);
    return { ok: true, value: normalized };
  } catch {
    return { ok: false, error: "Failed to save endpoint override." };
  }
}

export function getDenApiBase(): string {
  return readDenApiBaseOverride() ?? getDefaultDenApiBase();
}

function readDenAuthFromStorage(store: Storage | null): DenAuthState | null {
  if (!store) return null;
  try {
    const raw = store.getItem(DEN_AUTH_STORAGE_KEY);
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

function writeDenAuthToStorage(store: Storage | null, state: DenAuthState): boolean {
  if (!store) return false;
  try {
    store.setItem(DEN_AUTH_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function clearDenAuthFromStorage(store: Storage | null): void {
  if (!store) return;
  try {
    store.removeItem(DEN_AUTH_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function readDenKeepSignedIn(): boolean {
  const store = localStorageAccess();
  if (!store) return true;
  try {
    const raw = store.getItem(DEN_KEEP_SIGNED_IN_STORAGE_KEY);
    if (!raw) return true;
    const normalized = raw.trim().toLowerCase();
    if (normalized === "1" || normalized === "true") return true;
    if (normalized === "0" || normalized === "false") return false;
    return true;
  } catch {
    return true;
  }
}

export function writeDenKeepSignedIn(value: boolean): void {
  const keepSignedIn = Boolean(value);
  const localStore = localStorageAccess();
  const sessionStore = sessionStorageAccess();
  try {
    localStore?.setItem(DEN_KEEP_SIGNED_IN_STORAGE_KEY, keepSignedIn ? "1" : "0");
  } catch {
    // ignore storage errors
  }

  const existingAuth = readDenAuthFromStorage(localStore) ?? readDenAuthFromStorage(sessionStore);
  if (!existingAuth) return;

  if (keepSignedIn) {
    if (writeDenAuthToStorage(localStore, existingAuth)) {
      clearDenAuthFromStorage(sessionStore);
    }
    return;
  }

  const wroteSession = writeDenAuthToStorage(sessionStore, existingAuth);
  if (wroteSession) {
    clearDenAuthFromStorage(localStore);
    return;
  }

  writeDenAuthToStorage(localStore, existingAuth);
}

export function readDenAuth(): DenAuthState | null {
  const keepSignedIn = readDenKeepSignedIn();
  const localStore = localStorageAccess();
  const sessionStore = sessionStorageAccess();

  if (keepSignedIn) {
    const localAuth = readDenAuthFromStorage(localStore);
    if (localAuth) return localAuth;
    const sessionAuth = readDenAuthFromStorage(sessionStore);
    if (!sessionAuth) return null;
    if (writeDenAuthToStorage(localStore, sessionAuth)) {
      clearDenAuthFromStorage(sessionStore);
    }
    return sessionAuth;
  }

  const sessionAuth = readDenAuthFromStorage(sessionStore);
  if (sessionAuth) return sessionAuth;
  clearDenAuthFromStorage(localStore);
  return null;
}

export function writeDenAuth(state: DenAuthState): void {
  const keepSignedIn = readDenKeepSignedIn();
  const localStore = localStorageAccess();
  const sessionStore = sessionStorageAccess();

  if (keepSignedIn) {
    const wroteLocal = writeDenAuthToStorage(localStore, state);
    if (wroteLocal) {
      clearDenAuthFromStorage(sessionStore);
      return;
    }
    writeDenAuthToStorage(sessionStore, state);
    return;
  }

  const wroteSession = writeDenAuthToStorage(sessionStore, state);
  if (wroteSession) {
    clearDenAuthFromStorage(localStore);
    return;
  }

  writeDenAuthToStorage(localStore, state);
}

export function clearDenAuth(): void {
  clearDenAuthFromStorage(localStorageAccess());
  clearDenAuthFromStorage(sessionStorageAccess());
}

function bytesToBase64Url(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  throw new Error("Base64 encoding is unavailable in this environment.");
}

function randomBase64Url(byteLength: number): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error("Secure random generator unavailable.");
  }
  const bytes = new Uint8Array(byteLength);
  cryptoApi.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    throw new Error("Secure hash generator unavailable.");
  }
  const digest = await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function readPendingDesktopAuth(): PendingDesktopAuth | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(DEN_DESKTOP_AUTH_PENDING_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      store.removeItem(DEN_DESKTOP_AUTH_PENDING_STORAGE_KEY);
      return null;
    }

    const candidate = parsed as Partial<PendingDesktopAuth>;
    if (
      typeof candidate.sessionId !== "string" ||
      typeof candidate.state !== "string" ||
      typeof candidate.codeVerifier !== "string" ||
      typeof candidate.expiresAt !== "number"
    ) {
      store.removeItem(DEN_DESKTOP_AUTH_PENDING_STORAGE_KEY);
      return null;
    }

    if (!Number.isFinite(candidate.expiresAt) || candidate.expiresAt <= Date.now()) {
      store.removeItem(DEN_DESKTOP_AUTH_PENDING_STORAGE_KEY);
      return null;
    }

    return {
      sessionId: candidate.sessionId,
      state: candidate.state,
      codeVerifier: candidate.codeVerifier,
      expiresAt: candidate.expiresAt,
    };
  } catch {
    return null;
  }
}

function writePendingDesktopAuth(value: PendingDesktopAuth): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(DEN_DESKTOP_AUTH_PENDING_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export function clearDesktopAuthExchangeProof(sessionId?: string | null): void {
  const store = storage();
  if (!store) return;
  try {
    if (!sessionId) {
      store.removeItem(DEN_DESKTOP_AUTH_PENDING_STORAGE_KEY);
      return;
    }
    const pending = readPendingDesktopAuth();
    if (pending?.sessionId === sessionId) {
      store.removeItem(DEN_DESKTOP_AUTH_PENDING_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

export function readDesktopAuthExchangeProof(sessionId?: string | null): DesktopAuthExchangeProof | null {
  const pending = readPendingDesktopAuth();
  if (!pending) return null;
  if (sessionId && pending.sessionId !== sessionId) return null;
  return {
    sessionId: pending.sessionId,
    state: pending.state,
    codeVerifier: pending.codeVerifier,
  };
}

export async function startDesktopBrowserAuth(intent: "signin" | "signup" = "signin"): Promise<DesktopAuthStartResult> {
  const denApiBase = getDenApiBase();
  try {
    const state = randomBase64Url(DESKTOP_AUTH_STATE_BYTES);
    const codeVerifier = randomBase64Url(DESKTOP_AUTH_CODE_VERIFIER_BYTES);
    const codeChallenge = await sha256Base64Url(codeVerifier);

    const response = await fetchWithTimeout(
      resolveFetch(),
      `${denApiBase}/v1/desktop-auth/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent,
          redirectUri: "veslo://auth-complete",
          state,
          codeChallenge,
          codeChallengeMethod: "S256",
        }),
      },
      DEN_START_TIMEOUT_MS,
    );

    const text = await response.text().catch(() => "");
    let payload: Record<string, unknown> | null = null;
    try {
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message = typeof payload?.error === "string" ? payload.error : `Start failed (${response.status})`;
      return { ok: false, error: message };
    }

    const authorizeUrl = typeof payload?.authorizeUrl === "string" ? payload.authorizeUrl.trim() : "";
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    const expiresAtRaw = typeof payload?.expiresAt === "string" ? payload.expiresAt : "";
    if (!authorizeUrl || !sessionId) {
      return { ok: false, error: "Invalid start response" };
    }

    let expiresAt = Date.now() + DESKTOP_AUTH_FALLBACK_TTL_MS;
    if (expiresAtRaw) {
      const parsedExpiresAt = Date.parse(expiresAtRaw);
      if (Number.isFinite(parsedExpiresAt) && parsedExpiresAt > Date.now()) {
        expiresAt = parsedExpiresAt;
      }
    }

    writePendingDesktopAuth({
      sessionId,
      state,
      codeVerifier,
      expiresAt,
    });

    return { ok: true, authorizeUrl, sessionId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

export async function exchangeHandoffCode(
  code: string,
  exchangeProof?: DesktopAuthExchangeProof | null,
): Promise<DenExchangeResult> {
  const denApiBase = getDenApiBase();
  try {
    const body: Record<string, string> = { code };
    if (exchangeProof?.sessionId && exchangeProof.state && exchangeProof.codeVerifier) {
      body.sessionId = exchangeProof.sessionId;
      body.state = exchangeProof.state;
      body.codeVerifier = exchangeProof.codeVerifier;
    }

    const response = await fetchWithTimeout(
      resolveFetch(),
      `${denApiBase}/v1/desktop-auth/exchange`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
      user?: { id?: string; name?: string; email?: string };
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
      user: {
        id: userId,
        name: payload.user?.name,
        email: payload.user?.email,
      },
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

export function parseAuthCompleteDeepLink(rawUrl: string): AuthCompleteDeepLinkPayload | null {
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
  if (!code) return null;

  const sessionId = url.searchParams.get("sessionId")?.trim() ?? "";
  return { code, sessionId: sessionId || null };
}
