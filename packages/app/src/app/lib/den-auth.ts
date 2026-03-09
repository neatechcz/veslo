import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "../utils";

export type DenAuthUserSummary = {
  id: string;
  email: string;
  name: string | null;
};

export type DenAuthOrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  role: string | null;
};

export type DenAuthState = {
  apiBaseUrl: string;
  token: string;
  organizationId: string;
  user: DenAuthUserSummary;
  organization: DenAuthOrganizationSummary;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type FetchLike = typeof fetch;

const DEN_AUTH_STORAGE_KEY = "veslo.den.auth";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function defaultFetch(): FetchLike {
  return isTauriRuntime() ? tauriFetch : fetch;
}

function getStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) {
    return storage;
  }

  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage;
}

function parseUserSummary(payload: unknown): DenAuthUserSummary | null {
  const user = isRecord(payload) && isRecord(payload.user) ? payload.user : null;
  if (!user || typeof user.id !== "string" || typeof user.email !== "string") {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: typeof user.name === "string" ? user.name : null,
  };
}

function parseOrganizationSummary(payload: unknown): DenAuthOrganizationSummary | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (
    typeof payload.id !== "string" ||
    typeof payload.name !== "string" ||
    typeof payload.slug !== "string"
  ) {
    return null;
  }

  return {
    id: payload.id,
    name: payload.name,
    slug: payload.slug,
    role: typeof payload.role === "string" ? payload.role : null,
  };
}

function parseDenAuthState(payload: unknown): DenAuthState | null {
  if (!isRecord(payload)) {
    return null;
  }

  const apiBaseUrl = typeof payload.apiBaseUrl === "string" ? normalizeUrl(payload.apiBaseUrl) : null;
  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  const organization = parseOrganizationSummary(payload.organization);
  const user = parseUserSummary({ user: payload.user });

  if (!apiBaseUrl || !token || !organization || !user) {
    return null;
  }

  return {
    apiBaseUrl,
    token,
    organizationId: organization.id,
    user,
    organization,
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function getExchangeUrl(loginUrl: string): string | null {
  const base = normalizeUrl(loginUrl);
  if (!base) {
    return null;
  }

  try {
    return new URL("/api/den/v1/desktop-auth/exchange", `${base}/`).toString();
  } catch {
    return null;
  }
}

function resolveOrganizationFromDirectory(
  payload: unknown,
  organizationId: string,
): DenAuthOrganizationSummary | null {
  if (!isRecord(payload) || !Array.isArray(payload.organizations)) {
    return null;
  }

  return payload.organizations
    .map((entry) => parseOrganizationSummary(entry))
    .find((entry): entry is DenAuthOrganizationSummary => Boolean(entry && entry.id === organizationId)) ?? null;
}

export function buildDesktopOnboardingLoginUrl(loginUrl: string): string | null {
  const base = normalizeUrl(loginUrl);
  if (!base) {
    return null;
  }

  try {
    const url = new URL("/", `${base}/`);
    url.searchParams.set("desktopOnboarding", "1");
    return url.toString();
  } catch {
    return null;
  }
}

export function readDenAuthState(storage?: StorageLike | null): DenAuthState | null {
  const target = getStorage(storage);
  if (!target) {
    return null;
  }

  try {
    return parseDenAuthState(JSON.parse(target.getItem(DEN_AUTH_STORAGE_KEY) ?? "null"));
  } catch {
    return null;
  }
}

export function writeDenAuthState(
  state: DenAuthState,
  storage?: StorageLike | null,
): DenAuthState {
  const parsed = parseDenAuthState(state);
  if (!parsed) {
    throw new Error("Invalid Den auth state.");
  }

  const target = getStorage(storage);
  target?.setItem(DEN_AUTH_STORAGE_KEY, JSON.stringify(parsed));
  return parsed;
}

export function clearDenAuthState(storage?: StorageLike | null) {
  const target = getStorage(storage);
  target?.removeItem(DEN_AUTH_STORAGE_KEY);
}

export async function exchangeDesktopAuthCode(
  loginUrl: string,
  code: string,
  fetchImpl: FetchLike = defaultFetch(),
): Promise<DenAuthState> {
  const exchangeUrl = getExchangeUrl(loginUrl);
  if (!exchangeUrl) {
    throw new Error("Veslo login URL is not configured.");
  }

  const response = await fetchImpl(exchangeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code: code.trim() }),
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(
      typeof payload === "string" && payload.trim()
        ? payload
        : `Desktop auth exchange failed with ${response.status}.`,
    );
  }

  const state = parseDenAuthState(payload);
  if (!state) {
    throw new Error("Desktop auth exchange response was invalid.");
  }

  return state;
}

export async function validateDenAuthState(
  state: DenAuthState,
  fetchImpl: FetchLike = defaultFetch(),
): Promise<DenAuthState | null> {
  const parsed = parseDenAuthState(state);
  if (!parsed) {
    return null;
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${parsed.token}`,
  };

  const meResponse = await fetchImpl(`${parsed.apiBaseUrl}/v1/me`, {
    method: "GET",
    headers,
  });
  if (!meResponse.ok) {
    return null;
  }

  const mePayload = await readJson(meResponse);
  const user = parseUserSummary(mePayload);
  if (!user) {
    return null;
  }

  const orgsResponse = await fetchImpl(`${parsed.apiBaseUrl}/v1/orgs`, {
    method: "GET",
    headers,
  });
  if (!orgsResponse.ok) {
    return null;
  }

  const orgsPayload = await readJson(orgsResponse);
  const organization = resolveOrganizationFromDirectory(orgsPayload, parsed.organizationId);
  if (!organization) {
    return null;
  }

  return {
    ...parsed,
    user,
    organization,
    organizationId: organization.id,
  };
}
