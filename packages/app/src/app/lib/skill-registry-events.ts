type Awaitable<T> = T | Promise<T>;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type SkillRegistryEvent = {
  id: string;
  action: string;
  orgId?: string | null;
  workspaceId?: string | null;
  skillId?: string | null;
  versionId?: string | null;
  installationId?: string | null;
  actorUserId?: string | null;
  payload?: unknown;
  createdAt: string;
};

type SkillRegistryWorkspaceUpdate = {
  workspaceId: string;
  event: SkillRegistryEvent;
};

type SkillRegistryPendingWorkspaceUpdate = SkillRegistryWorkspaceUpdate & {
  status: "pending";
  reloadRequired: true;
};

type SkillRegistryGlobalUpdate = {
  event: SkillRegistryEvent;
};

type SkillRegistryEventListenerState = {
  running: boolean;
  cursor: string | null;
  revision: string | null;
  inFlight: boolean;
};

export class SkillRegistryEventsAuthError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "SkillRegistryEventsAuthError";
    this.status = status;
  }
}

export type SkillRegistryEventScheduler<TTimer = ReturnType<typeof setTimeout>> = {
  setTimeout: (callback: () => void, delayMs: number) => TTimer;
  clearTimeout: (timer: TTimer) => void;
};

export type SkillRegistryEventsListenerOptions<TTimer = ReturnType<typeof setTimeout>> = {
  registryBaseUrl: string;
  token?: string | null;
  extraHeaders?: Record<string, string> | null;
  orgId?: string | null;
  workspaceId?: string | null;
  initialCursor?: string | null;
  initialRevision?: string | null;
  limit?: number;
  pollIntervalMs?: number;
  fetchImpl?: FetchLike;
  scheduler?: SkillRegistryEventScheduler<TTimer>;
  getActiveWorkspaceId?: () => string | null | undefined;
  onEvent?: (event: SkillRegistryEvent) => Awaitable<void>;
  onInventoryInvalidated?: (event: SkillRegistryEvent) => Awaitable<void>;
  onGlobalUpdate?: (update: SkillRegistryGlobalUpdate) => Awaitable<void>;
  onWorkspaceUpdatePending?: (update: SkillRegistryPendingWorkspaceUpdate) => Awaitable<void>;
  onIdleWorkspaceUpdate?: (update: SkillRegistryWorkspaceUpdate) => Awaitable<void>;
  onUnauthorized?: (error: SkillRegistryEventsAuthError) => Awaitable<void>;
  onError?: (error: Error) => Awaitable<void>;
};

export type SkillRegistryEventsListener = {
  start: () => void;
  stop: () => void;
  pollNow: () => Promise<void>;
  getState: () => SkillRegistryEventListenerState;
};

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_LIMIT = 100;

const defaultScheduler: SkillRegistryEventScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

export function createSkillRegistryEventsListener<TTimer = ReturnType<typeof setTimeout>>(
  options: SkillRegistryEventsListenerOptions<TTimer>,
): SkillRegistryEventsListener {
  const scheduler = options.scheduler ?? (defaultScheduler as unknown as SkillRegistryEventScheduler<TTimer>);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const pollIntervalMs = normalizePositiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const limit = normalizePositiveInteger(options.limit, DEFAULT_LIMIT);
  let cursor = normalizeNullableString(options.initialCursor);
  let revision = normalizeNullableString(options.initialRevision);
  let running = false;
  let timer: TTimer | null = null;
  let inFlight: Promise<void> | null = null;
  let authInvalid = false;

  const clearScheduledTimer = () => {
    if (timer === null) return;
    scheduler.clearTimeout(timer);
    timer = null;
  };

  const schedulePoll = (delayMs: number) => {
    if (!running || authInvalid || timer !== null) return;
    timer = scheduler.setTimeout(() => {
      timer = null;
      void pollNow().finally(() => {
        if (running) schedulePoll(pollIntervalMs);
      });
    }, delayMs);
  };

  const pollNow = async (): Promise<void> => {
    if (authInvalid) return;
    if (inFlight) return inFlight;
    inFlight = pollOnce().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const pollOnce = async () => {
    try {
      const response = await fetchImpl(buildRegistryEventsUrl(options, { cursor, limit }), {
        method: "GET",
        headers: buildHeaders(options.token, options.extraHeaders),
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          const error = new SkillRegistryEventsAuthError(response.status);
          authInvalid = true;
          running = false;
          clearScheduledTimer();
          await options.onUnauthorized?.(error);
          return;
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const body = parseEventsResponse(await response.json());
      for (const event of body.events) {
        await dispatchEvent(options, event);
      }
      if (body.nextCursor) cursor = body.nextCursor;
      if (body.revision) revision = body.revision;
    } catch (error) {
      await options.onError?.(toError(error));
    }
  };

  return {
    start() {
      if (running || authInvalid) return;
      running = true;
      schedulePoll(0);
    },
    stop() {
      running = false;
      clearScheduledTimer();
    },
    pollNow,
    getState() {
      return {
        running,
        cursor,
        revision,
        inFlight: inFlight !== null,
      };
    },
  };
}

function buildRegistryEventsUrl(
  options: Pick<SkillRegistryEventsListenerOptions, "registryBaseUrl" | "orgId" | "workspaceId">,
  state: { cursor: string | null; limit: number },
): string {
  const base = normalizeBaseUrl(options.registryBaseUrl);
  const endpoint = base.pathname.replace(/\/+$/, "").endsWith("/v1")
    ? `${base.origin}${base.pathname.replace(/\/+$/, "")}/skill-registry-events`
    : `${base.origin}${base.pathname.replace(/\/+$/, "")}/v1/skill-registry-events`;
  const url = new URL(endpoint);
  url.searchParams.set("limit", String(state.limit));
  if (state.cursor) url.searchParams.set("cursor", state.cursor);
  const orgId = normalizeNullableString(options.orgId);
  const workspaceId = normalizeNullableString(options.workspaceId);
  if (orgId) url.searchParams.set("orgId", orgId);
  if (workspaceId) url.searchParams.set("workspaceId", workspaceId);
  return url.toString();
}

function buildHeaders(
  token: string | null | undefined,
  extraHeaders?: Record<string, string> | null,
): Headers {
  const headers = new Headers({ Accept: "application/json" });
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    const normalizedName = name.trim();
    const normalizedValue = value.trim();
    if (normalizedName && normalizedValue) headers.set(normalizedName, normalizedValue);
  }
  const normalizedToken = normalizeNullableString(token);
  if (normalizedToken) headers.set("Authorization", `Bearer ${normalizedToken}`);
  return headers;
}

async function dispatchEvent(
  options: Pick<
    SkillRegistryEventsListenerOptions,
    | "getActiveWorkspaceId"
    | "onEvent"
    | "onGlobalUpdate"
    | "onIdleWorkspaceUpdate"
    | "onInventoryInvalidated"
    | "onWorkspaceUpdatePending"
  >,
  event: SkillRegistryEvent,
) {
  await options.onEvent?.(event);
  await options.onInventoryInvalidated?.(event);

  const workspaceId = normalizeNullableString(event.workspaceId);
  if (!workspaceId) {
    await options.onGlobalUpdate?.({ event });
    return;
  }

  const activeWorkspaceId = normalizeNullableString(options.getActiveWorkspaceId?.() ?? null);
  if (workspaceId === activeWorkspaceId) {
    await options.onWorkspaceUpdatePending?.({
      workspaceId,
      event,
      status: "pending",
      reloadRequired: true,
    });
    return;
  }

  await options.onIdleWorkspaceUpdate?.({ workspaceId, event });
}

function parseEventsResponse(value: unknown): { events: SkillRegistryEvent[]; nextCursor: string | null; revision: string | null } {
  const body = requireRecord(value, "skill registry events response");
  const rawEvents = body.events;
  if (!Array.isArray(rawEvents)) {
    throw new Error("Skill registry events response requires events array");
  }

  const nextCursor = normalizeNullableString(body.nextCursor);
  const revision = normalizeNullableString(body.revision) ?? normalizeNullableString(body.registryRevision);
  return {
    events: rawEvents.map(parseEvent),
    nextCursor,
    revision,
  };
}

function parseEvent(value: unknown): SkillRegistryEvent {
  const event = requireRecord(value, "skill registry event");
  return {
    id: requireString(event.id, "skill registry event id"),
    action: requireString(event.action, "skill registry event action"),
    orgId: normalizeNullableString(event.orgId),
    workspaceId: normalizeNullableString(event.workspaceId),
    skillId: normalizeNullableString(event.skillId),
    versionId: normalizeNullableString(event.versionId),
    installationId: normalizeNullableString(event.installationId),
    actorUserId: normalizeNullableString(event.actorUserId),
    payload: event.payload,
    createdAt: requireString(event.createdAt, "skill registry event createdAt"),
  };
}

function normalizeBaseUrl(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Skill registry base URL is required");
  }
  return new URL(trimmed);
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function requireString(value: unknown, field: string): string {
  const normalized = normalizeNullableString(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
