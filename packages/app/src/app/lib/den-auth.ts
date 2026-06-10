import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { LANGUAGE_PREF_KEY, ONBOARDING_COMPLETE_STORAGE_KEY } from "../constants";
import { isTauriRuntime } from "../utils";
import { currentLocale as __vesloIndirectLocale, t as __vesloIndirectT } from "../../i18n";

const DEN_AUTH_STORAGE_KEY = "veslo.den.auth";
const DEN_KEEP_SIGNED_IN_STORAGE_KEY = "veslo.den.keepSignedIn";
const DEN_API_BASE_OVERRIDE_STORAGE_KEY = "veslo.den.apiBaseOverride";
const DEN_DESKTOP_AUTH_PENDING_STORAGE_KEY = "veslo.den.desktopAuthPending";
const DEN_AUTH_SNAPSHOT_READ_COMMAND = "den_auth_snapshot_read";
const DEN_AUTH_SNAPSHOT_WRITE_COMMAND = "den_auth_snapshot_write";
const DEFAULT_DEN_API_BASE = "https://api.veslo.work";
const DEN_START_TIMEOUT_MS = 12_000;
const DEN_STATUS_TIMEOUT_MS = 8_000;
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
  authorizeUrl?: string;
};

export type PendingDesktopAuthSession = {
  sessionId: string;
  authorizeUrl: string | null;
};

export type DesktopAuthStartResult =
  | { ok: true; authorizeUrl: string; sessionId: string }
  | { ok: false; error: string };

export type DesktopAuthStatusResult =
  | {
      ok: true;
      status: "pending" | "authorized" | "expired" | "cancelled" | "exchanged";
      sessionId: string;
      code: string | null;
      expiresAt: string | null;
    }
  | { ok: false; error: string; statusCode: number | null };

export type AuthCompleteDeepLinkPayload = {
  code: string;
  sessionId: string | null;
};

type DenDesktopSnapshot = {
  authJson?: string | null;
  keepSignedIn?: boolean | null;
  language?: string | null;
  onboardingComplete?: boolean | null;
  source?: string | null;
};

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type DenAuthChangeListener = () => void;
type DenAuthIdentityComparison = "same" | "different" | "unknown";

let desktopSnapshotWriteQueue: Promise<void> = Promise.resolve();
const denAuthChangeListeners = new Set<DenAuthChangeListener>();

export function resolvePreferredDenUserLabel(
  user?: Partial<DenAuthState["user"]> | null,
): string | null {
  const email = typeof user?.email === "string" ? user.email.trim() : "";
  if (email) return email;

  const name = typeof user?.name === "string" ? user.name.trim() : "";
  if (name) return name;

  const id = typeof user?.id === "string" ? user.id.trim() : "";
  return id || null;
}

export function resolveAuthenticatedDenUserLabel(
  auth?: Pick<DenAuthState, "user"> | null,
): string | null {
  const label = resolvePreferredDenUserLabel(auth?.user);
  if (label) return label;
  return auth ? __vesloIndirectT("ui.indirect.signed_in_15swka", __vesloIndirectLocale()) : null;
}

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

function isAutomatedBrowserSession(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.webdriver === true;
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
    return { ok: false, error: __vesloIndirectT("ui.indirect.local_storage_is_unavailable_in_this_environme_125e8t", __vesloIndirectLocale()) };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    try {
      store.removeItem(DEN_API_BASE_OVERRIDE_STORAGE_KEY);
      return { ok: true, value: null };
    } catch {
      return { ok: false, error: __vesloIndirectT("ui.indirect.failed_to_clear_endpoint_override_1853v4", __vesloIndirectLocale()) };
    }
  }

  const normalized = normalizeDenApiBase(trimmed);
  if (!normalized) {
    return { ok: false, error: __vesloIndirectT("ui.indirect.enter_a_valid_http_s_url_4spp7x", __vesloIndirectLocale()) };
  }

  try {
    store.setItem(DEN_API_BASE_OVERRIDE_STORAGE_KEY, normalized);
    return { ok: true, value: normalized };
  } catch {
    return { ok: false, error: __vesloIndirectT("ui.indirect.failed_to_save_endpoint_override_12wxta", __vesloIndirectLocale()) };
  }
}

export function getDenApiBase(): string {
  return readDenApiBaseOverride() ?? getDefaultDenApiBase();
}

function parseDenAuthCandidate(candidate: unknown): DenAuthState | null {
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "denApiBase" in candidate &&
    "token" in candidate &&
    "orgId" in candidate
  ) {
    return candidate as DenAuthState;
  }
  return null;
}

function readDenAuthFromStorage(store: Storage | null): DenAuthState | null {
  if (!store) return null;
  try {
    const raw = store.getItem(DEN_AUTH_STORAGE_KEY);
    if (!raw) return null;
    return parseDenAuthCandidate(JSON.parse(raw));
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

function readPersistedText(store: Storage | null, key: string): string | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    const trimmed = raw?.trim() ?? "";
    return trimmed || null;
  } catch {
    return null;
  }
}

function readPersistedBoolean(store: Storage | null, key: string): boolean | null {
  const raw = readPersistedText(store, key)?.toLowerCase();
  if (!raw) return null;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return null;
}

function writePersistedText(store: Storage | null, key: string, value: string | null): void {
  if (!store) return;
  try {
    if (!value) {
      store.removeItem(key);
      return;
    }
    store.setItem(key, value);
  } catch {
    // ignore
  }
}

function writePersistedBoolean(store: Storage | null, key: string, value: boolean | null): void {
  if (!store) return;
  try {
    if (value == null) {
      store.removeItem(key);
      return;
    }
    store.setItem(key, value ? "1" : "0");
  } catch {
    // ignore
  }
}

function normalizePersistedLanguage(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "en" || normalized === "zh" || normalized === "cs") {
    return normalized;
  }
  return null;
}

function runtimeTauriInvoke(): TauriInvoke | null {
  return (typeof window !== "undefined"
    ? (window as unknown as { __TAURI_INTERNALS__?: { invoke?: TauriInvoke } }).__TAURI_INTERNALS__
        ?.invoke
    : null) as TauriInvoke | null;
}

async function invokeDesktopCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const runtimeInvoke = runtimeTauriInvoke();
  if (runtimeInvoke) {
    return runtimeInvoke<T>(command, args);
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

function queueDesktopSnapshotWrite(
  auth: DenAuthState | null,
  keepSignedIn: boolean,
  language: string | null,
  onboardingComplete: boolean | null,
): void {
  if (!isTauriRuntime() || isAutomatedBrowserSession()) return;
  const payloadAuth = auth ? JSON.stringify(auth) : null;
  const invokeAtQueueTime = runtimeTauriInvoke();
  const payload = {
    authJson: payloadAuth,
    keepSignedIn,
    language,
    onboardingComplete,
  };
  desktopSnapshotWriteQueue = desktopSnapshotWriteQueue
    .catch(() => {})
    .then(async () => {
      try {
        if (invokeAtQueueTime) {
          await invokeAtQueueTime(DEN_AUTH_SNAPSHOT_WRITE_COMMAND, payload);
          return;
        }
        await invokeDesktopCommand(DEN_AUTH_SNAPSHOT_WRITE_COMMAND, payload);
      } catch {
        // ignore desktop snapshot write failures
      }
    });
}

export function flushPendingDesktopSnapshotWrite(): Promise<void> {
  return desktopSnapshotWriteQueue.catch(() => {});
}

function emitDenAuthChanged(): void {
  for (const listener of denAuthChangeListeners) {
    try {
      listener();
    } catch {
      // ignore listener failures
    }
  }
}

export function subscribeDenAuthChanges(listener: DenAuthChangeListener): () => void {
  denAuthChangeListeners.add(listener);
  return () => {
    denAuthChangeListeners.delete(listener);
  };
}

function syncDesktopSnapshotFromCurrentState(): void {
  if (!isTauriRuntime()) return;
  const localStore = localStorageAccess();
  queueDesktopSnapshotWrite(
    readDenAuth(),
    readDenKeepSignedIn(),
    readPersistedText(localStore, LANGUAGE_PREF_KEY),
    readPersistedBoolean(localStore, ONBOARDING_COMPLETE_STORAGE_KEY),
  );
}

function parseSnapshotAuth(snapshot?: DenDesktopSnapshot | null): DenAuthState | null {
  const raw = typeof snapshot?.authJson === "string" ? snapshot.authJson.trim() : "";
  if (!raw) return null;
  try {
    return parseDenAuthCandidate(JSON.parse(raw));
  } catch {
    return null;
  }
}

function normalizeAuthIdentityId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeAuthIdentityEmail(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function compareDenAuthIdentity(
  current: DenAuthState | null,
  snapshot: DenAuthState | null,
): DenAuthIdentityComparison {
  const currentId = normalizeAuthIdentityId(current?.user?.id);
  const snapshotId = normalizeAuthIdentityId(snapshot?.user?.id);
  if (currentId && snapshotId) {
    return currentId === snapshotId ? "same" : "different";
  }

  const currentEmail = normalizeAuthIdentityEmail(current?.user?.email);
  const snapshotEmail = normalizeAuthIdentityEmail(snapshot?.user?.email);
  if (currentEmail && snapshotEmail) {
    return currentEmail === snapshotEmail ? "same" : "different";
  }

  return "unknown";
}

function restoreDesktopSnapshotUiState(
  localStore: Storage | null,
  snapshot: DenDesktopSnapshot | null,
): void {
  const currentLanguage = normalizePersistedLanguage(readPersistedText(localStore, LANGUAGE_PREF_KEY));
  if (!currentLanguage) {
    writePersistedText(
      localStore,
      LANGUAGE_PREF_KEY,
      normalizePersistedLanguage(snapshot?.language),
    );
  }

  if (readPersistedBoolean(localStore, ONBOARDING_COMPLETE_STORAGE_KEY) == null) {
    writePersistedBoolean(
      localStore,
      ONBOARDING_COMPLETE_STORAGE_KEY,
      typeof snapshot?.onboardingComplete === "boolean" ? snapshot.onboardingComplete : null,
    );
  }
}

function applySignedOutDesktopSnapshot(localStore: Storage | null, sessionStore: Storage | null): void {
  writePersistedBoolean(localStore, DEN_KEEP_SIGNED_IN_STORAGE_KEY, false);
  clearDenAuthFromStorage(localStore);
  clearDenAuthFromStorage(sessionStore);
  syncDesktopSnapshotFromCurrentState();
  emitDenAuthChanged();
}

export async function hydrateDenAuthFromDesktopSnapshot(): Promise<boolean> {
  if (!isTauriRuntime()) return false;

  const localStore = localStorageAccess();
  const sessionStore = sessionStorageAccess();
  if (!localStore) return false;

  let snapshot: DenDesktopSnapshot | null = null;
  try {
    snapshot = await invokeDesktopCommand<DenDesktopSnapshot | null>(DEN_AUTH_SNAPSHOT_READ_COMMAND);
  } catch {
    return false;
  }

  const currentAuth = readDenAuth();
  if (!snapshot) {
    if (currentAuth) {
      syncDesktopSnapshotFromCurrentState();
    }
    return false;
  }

  const snapshotKeepSignedIn = snapshot.keepSignedIn !== false;
  const state = parseSnapshotAuth(snapshot);

  if (!state && snapshot.keepSignedIn === false) {
    applySignedOutDesktopSnapshot(localStore, sessionStore);
    return false;
  }

  if (!state) {
    if (currentAuth) {
      syncDesktopSnapshotFromCurrentState();
    }
    return false;
  }

  if (currentAuth) {
    const identityComparison = compareDenAuthIdentity(currentAuth, state);
    if (identityComparison !== "different") {
      const currentKeepSignedIn = readDenKeepSignedIn();
      syncDesktopSnapshotFromCurrentState();
      restoreDesktopSnapshotUiState(localStore, snapshot);
      if (currentKeepSignedIn !== snapshotKeepSignedIn) {
        writeDenKeepSignedIn(snapshotKeepSignedIn);
        return true;
      }
      return false;
    }
  }

  restoreDesktopSnapshotUiState(localStore, snapshot);
  writeDenKeepSignedIn(snapshotKeepSignedIn);
  writeDenAuth(state);
  return true;
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
  if (existingAuth) {
    if (keepSignedIn) {
      if (writeDenAuthToStorage(localStore, existingAuth)) {
        clearDenAuthFromStorage(sessionStore);
      }
    } else {
      const wroteSession = writeDenAuthToStorage(sessionStore, existingAuth);
      if (wroteSession) {
        clearDenAuthFromStorage(localStore);
      } else {
        writeDenAuthToStorage(localStore, existingAuth);
      }
    }
  }
  syncDesktopSnapshotFromCurrentState();
  emitDenAuthChanged();
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
    } else {
      writeDenAuthToStorage(sessionStore, state);
    }
  } else {
    const wroteSession = writeDenAuthToStorage(sessionStore, state);
    if (wroteSession) {
      clearDenAuthFromStorage(localStore);
    } else {
      writeDenAuthToStorage(localStore, state);
    }
  }

  syncDesktopSnapshotFromCurrentState();
  emitDenAuthChanged();
}

export function clearDenAuth(): void {
  clearDenAuthFromStorage(localStorageAccess());
  clearDenAuthFromStorage(sessionStorageAccess());
  syncDesktopSnapshotFromCurrentState();
  emitDenAuthChanged();
}

async function readDenSessionUser(
  denApiBase: string,
  token: string,
): Promise<DenAuthState["user"] | null> {
  const response = await fetchWithTimeout(
    resolveFetch(),
    `${denApiBase.replace(/\/+$/, "")}/v1/me`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    },
    DEN_VALIDATE_TIMEOUT_MS,
  );

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    user?: { id?: unknown; name?: unknown; email?: unknown };
  };
  const userId = typeof payload?.user?.id === "string" ? payload.user.id.trim() : "";
  if (!userId) {
    return null;
  }

  const userName = typeof payload?.user?.name === "string" ? payload.user.name.trim() : "";
  const userEmail = typeof payload?.user?.email === "string" ? payload.user.email.trim() : "";
  return {
    id: userId,
    name: userName || undefined,
    email: userEmail || undefined,
  };
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
      authorizeUrl:
        typeof candidate.authorizeUrl === "string" && candidate.authorizeUrl.trim()
          ? candidate.authorizeUrl.trim()
          : undefined,
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

export function readPendingDesktopAuthSession(sessionId?: string | null): PendingDesktopAuthSession | null {
  const pending = readPendingDesktopAuth();
  if (!pending) return null;
  if (sessionId && pending.sessionId !== sessionId) return null;
  return {
    sessionId: pending.sessionId,
    authorizeUrl: pending.authorizeUrl?.trim() || null,
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
      `${denApiBase}/v2/desktop-auth/start`,
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
    const sessionId =
      typeof payload?.transactionId === "string"
        ? payload.transactionId.trim()
        : typeof payload?.sessionId === "string"
          ? payload.sessionId.trim()
          : "";
    const expiresAtRaw = typeof payload?.expiresAt === "string" ? payload.expiresAt : "";
    if (!authorizeUrl || !sessionId) {
      return { ok: false, error: __vesloIndirectT("ui.indirect.invalid_start_response_8i4ysj", __vesloIndirectLocale()) };
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
      authorizeUrl,
    });

    return { ok: true, authorizeUrl, sessionId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : __vesloIndirectT("ui.indirect.network_error_1a8yxz", __vesloIndirectLocale()) };
  }
}

export async function getDesktopBrowserAuthStatus(
  sessionId: string,
  signal?: AbortSignal,
): Promise<DesktopAuthStatusResult> {
  const denApiBase = getDenApiBase();
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId) {
    return { ok: false, error: __vesloIndirectT("ui.indirect.missing_desktop_auth_transaction_id_1jb169", __vesloIndirectLocale()), statusCode: null };
  }

  try {
    const response = await fetchWithTimeout(
      resolveFetch(),
      `${denApiBase}/v2/desktop-auth/status?transactionId=${encodeURIComponent(trimmedSessionId)}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        signal,
      },
      DEN_STATUS_TIMEOUT_MS,
    );

    const text = await response.text().catch(() => "");
    let payload: Record<string, unknown> | null = null;
    try {
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message = typeof payload?.error === "string" ? payload.error : `Status failed (${response.status})`;
      return { ok: false, error: message, statusCode: response.status };
    }

    const status = typeof payload?.status === "string" ? payload.status.trim().toLowerCase() : "";
    if (
      status !== "pending" &&
      status !== "authorized" &&
      status !== "expired" &&
      status !== "cancelled" &&
      status !== "exchanged"
    ) {
      return { ok: false, error: __vesloIndirectT("ui.indirect.invalid_status_response_j5gau1", __vesloIndirectLocale()), statusCode: response.status };
    }

    return {
      ok: true,
      status,
      sessionId:
        typeof payload?.transactionId === "string" && payload.transactionId.trim()
          ? payload.transactionId.trim()
          : trimmedSessionId,
      code: typeof payload?.code === "string" && payload.code.trim() ? payload.code.trim() : null,
      expiresAt: typeof payload?.expiresAt === "string" && payload.expiresAt.trim() ? payload.expiresAt.trim() : null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : __vesloIndirectT("ui.indirect.network_error_1a8yxz", __vesloIndirectLocale()),
      statusCode: null,
    };
  }
}

export async function exchangeHandoffCode(
  code: string,
  exchangeProof?: DesktopAuthExchangeProof | null,
): Promise<DenExchangeResult> {
  const denApiBase = getDenApiBase();
  try {
    const body: Record<string, string> = { code };
    let exchangePath = "/v1/desktop-auth/exchange";
    if (exchangeProof?.sessionId && exchangeProof.state && exchangeProof.codeVerifier) {
      exchangePath = "/v2/desktop-auth/exchange";
      body.transactionId = exchangeProof.sessionId;
      body.state = exchangeProof.state;
      body.codeVerifier = exchangeProof.codeVerifier;
    }

    const response = await fetchWithTimeout(
      resolveFetch(),
      `${denApiBase}${exchangePath}`,
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
      accessToken?: string;
      user?: { id?: string; name?: string; email?: string };
      org?: { id?: string; name?: string; slug?: string; role?: string };
    };

    const userId = payload?.user?.id;
    const orgId = payload?.org?.id;
    if (!userId || !orgId) {
      return { ok: false, error: __vesloIndirectT("ui.indirect.invalid_exchange_response_qah76s", __vesloIndirectLocale()) };
    }

    const state: DenAuthState = {
      denApiBase,
      token: payload.accessToken ?? payload.token ?? code,
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

    if (!state.user.email) {
      try {
        const resolvedUser = await readDenSessionUser(denApiBase, state.token);
        if (resolvedUser) {
          state.user = resolvedUser;
        }
      } catch {
        // keep exchange payload fallback
      }
    }

    return { ok: true, state };
  } catch (err) {
    if (err instanceof Error && err.message === "Failed to fetch") {
      return {
        ok: false,
        error: __vesloIndirectT("ui.indirect.failed_to_reach_the_openwork_auth_api_check_yo_ldn4z4", __vesloIndirectLocale()),
      };
    }
    return { ok: false, error: err instanceof Error ? err.message : __vesloIndirectT("ui.indirect.network_error_1a8yxz", __vesloIndirectLocale()) };
  }
}

export type DenAuthValidationResult = "valid" | "invalid" | "unreachable";

export async function validateDenAuth(state: DenAuthState): Promise<DenAuthValidationResult> {
  try {
    const response = await fetchWithTimeout(
      resolveFetch(),
      `${state.denApiBase}/v1/me`,
      {
        headers: { Authorization: `Bearer ${state.token}` },
      },
      DEN_VALIDATE_TIMEOUT_MS,
    );
    if (response.ok) return "valid";
    if (response.status === 401 || response.status === 403) return "invalid";
    // Server error (5xx etc.) — token may still be valid
    return "unreachable";
  } catch {
    // Network error / timeout — don't treat as invalid token
    return "unreachable";
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

  const sessionId =
    url.searchParams.get("transactionId")?.trim() ??
    url.searchParams.get("sessionId")?.trim() ??
    "";
  return { code, sessionId: sessionId || null };
}
