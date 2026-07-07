import assert from "node:assert/strict";
import test from "node:test";

import {
  createSkillRegistryEventsListener,
  SkillRegistryEventsAuthError,
  type SkillRegistryEvent,
  type SkillRegistryEventScheduler,
} from "../../lib/skill-registry-events.js";

const registryEvent = (overrides: Partial<SkillRegistryEvent> = {}): SkillRegistryEvent => ({
  id: "event_1",
  action: "skill.version.created",
  orgId: "org_1",
  workspaceId: null,
  skillId: "skill_1",
  versionId: "version_1",
  installationId: null,
  actorUserId: "user_1",
  payload: {},
  createdAt: "2026-05-27T12:00:00.000Z",
  ...overrides,
});

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("pollNow fetches from the current cursor, delivers events, and tracks cursor and revision", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const delivered: SkillRegistryEvent[] = [];
  const invalidated: string[] = [];

  const listener = createSkillRegistryEventsListener({
    registryBaseUrl: "https://registry.example/api",
    token: "token_1",
    orgId: "org_1",
    initialCursor: "cursor_0",
    initialRevision: "revision_0",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return jsonResponse({
        events: [registryEvent({ id: "event_1" })],
        nextCursor: "cursor_1",
        revision: "revision_1",
      });
    },
    onEvent: (event) => {
      delivered.push(event);
    },
    onInventoryInvalidated: (event) => {
      invalidated.push(event.id);
    },
  });

  await listener.pollNow();

  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/v1/skill-registry-events");
  assert.equal(url.searchParams.get("cursor"), "cursor_0");
  assert.equal(url.searchParams.get("orgId"), "org_1");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(calls[0]!.headers.get("authorization"), "Bearer token_1");
  assert.deepEqual(delivered.map((event) => event.id), ["event_1"]);
  assert.deepEqual(invalidated, ["event_1"]);
  assert.deepEqual(listener.getState(), {
    running: false,
    cursor: "cursor_1",
    revision: "revision_1",
    inFlight: false,
  });
});

test("workspace events for the active workspace are marked pending and idle workspace events are applied", async () => {
  const pending: Array<{ workspaceId: string; eventId: string; reloadRequired: boolean }> = [];
  const idle: Array<{ workspaceId: string; eventId: string }> = [];
  const global: string[] = [];

  const listener = createSkillRegistryEventsListener({
    registryBaseUrl: "https://registry.example",
    getActiveWorkspaceId: () => "workspace_active",
    fetchImpl: async () =>
      jsonResponse({
        events: [
          registryEvent({ id: "event_active", workspaceId: "workspace_active" }),
          registryEvent({ id: "event_idle", workspaceId: "workspace_idle" }),
          registryEvent({ id: "event_global", workspaceId: null }),
        ],
        nextCursor: "cursor_1",
      }),
    onWorkspaceUpdatePending: (update) => {
      pending.push({
        workspaceId: update.workspaceId,
        eventId: update.event.id,
        reloadRequired: update.reloadRequired,
      });
    },
    onIdleWorkspaceUpdate: (update) => {
      idle.push({
        workspaceId: update.workspaceId,
        eventId: update.event.id,
      });
    },
    onGlobalUpdate: (update) => {
      global.push(update.event.id);
    },
  });

  await listener.pollNow();

  assert.deepEqual(pending, [{ workspaceId: "workspace_active", eventId: "event_active", reloadRequired: true }]);
  assert.deepEqual(idle, [{ workspaceId: "workspace_idle", eventId: "event_idle" }]);
  assert.deepEqual(global, ["event_global"]);
});

test("failed polls report errors without advancing the cursor", async () => {
  const errors: string[] = [];
  const listener = createSkillRegistryEventsListener({
    registryBaseUrl: "https://registry.example",
    initialCursor: "cursor_0",
    fetchImpl: async () => new Response("nope", { status: 503 }),
    onError: (error) => {
      errors.push(error.message);
    },
  });

  await listener.pollNow();

  assert.match(errors[0] ?? "", /HTTP 503/);
  assert.equal(listener.getState().cursor, "cursor_0");
  assert.equal(listener.getState().inFlight, false);
});

test("concurrent pollNow calls share one in-flight request on slow networks", async () => {
  let fetchCalls = 0;
  let resolveFetch: ((response: Response) => void) | null = null;
  const delivered: string[] = [];
  const listener = createSkillRegistryEventsListener({
    registryBaseUrl: "https://registry.example",
    initialCursor: "cursor_0",
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    },
    onEvent: (event) => {
      delivered.push(event.id);
    },
  });

  const firstPoll = listener.pollNow();
  const secondPoll = listener.pollNow();
  await Promise.resolve();

  assert.equal(fetchCalls, 1);
  assert.equal(listener.getState().inFlight, true);
  const settleFetch = resolveFetch as ((response: Response) => void) | null;
  assert.ok(settleFetch);
  settleFetch(jsonResponse({
    events: [registryEvent({ id: "event_slow" })],
    nextCursor: "cursor_1",
    revision: "revision_1",
  }));
  await Promise.all([firstPoll, secondPoll]);

  assert.deepEqual(delivered, ["event_slow"]);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(listener.getState(), {
    running: false,
    cursor: "cursor_1",
    revision: "revision_1",
    inFlight: false,
  });
});

test("auth failures stop polling, preserve cursor, and do not reschedule", async () => {
  let nextTimerId = 1;
  const timers = new Map<number, () => void>();
  const scheduler: SkillRegistryEventScheduler<number> = {
    setTimeout: (callback) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
  };
  let fetchCalls = 0;
  const errors: string[] = [];
  const authFailures: number[] = [];
  const listener = createSkillRegistryEventsListener({
    registryBaseUrl: "https://registry.example",
    initialCursor: "cursor_0",
    pollIntervalMs: 25,
    scheduler,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 });
    },
    onUnauthorized: (error) => {
      assert.ok(error instanceof SkillRegistryEventsAuthError);
      authFailures.push(error.status);
    },
    onError: (error) => {
      errors.push(error.message);
    },
  });

  listener.start();
  assert.equal(timers.size, 1);
  await listener.pollNow();

  assert.deepEqual(authFailures, [401]);
  assert.deepEqual(errors, []);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(listener.getState(), {
    running: false,
    cursor: "cursor_0",
    revision: null,
    inFlight: false,
  });
  assert.equal(timers.size, 0);

  await listener.pollNow();
  listener.start();
  assert.equal(fetchCalls, 1);
  assert.equal(timers.size, 0);
});

test("start and stop are idempotent and do not leak scheduled polling timers", async () => {
  let nextTimerId = 1;
  const timers = new Map<number, () => void>();
  const pendingFetch: { resolve?: (response: Response) => void } = {};
  const scheduler: SkillRegistryEventScheduler<number> = {
    setTimeout: (callback) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
  };
  const listener = createSkillRegistryEventsListener({
    registryBaseUrl: "https://registry.example",
    pollIntervalMs: 25,
    scheduler,
    fetchImpl: async () =>
      new Promise<Response>((resolve) => {
        pendingFetch.resolve = resolve;
      }),
  });

  listener.start();
  listener.start();
  assert.equal(timers.size, 1);
  assert.equal(listener.getState().running, true);

  const [timerId, callback] = timers.entries().next().value!;
  timers.delete(timerId);
  callback();
  assert.equal(timers.size, 0);

  listener.stop();
  assert.equal(listener.getState().running, false);
  const settleFetch = pendingFetch.resolve;
  assert.ok(settleFetch);
  settleFetch(jsonResponse({ events: [], nextCursor: "cursor_1" }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(timers.size, 0);
  listener.stop();
  assert.equal(timers.size, 0);
});
