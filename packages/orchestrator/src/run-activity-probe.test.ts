import { describe, expect, test } from "bun:test";

import {
  createRunActivityProbe,
  deriveRunActivityFromSessionMessages,
  deriveRunActivityFromSessionStatus,
} from "./run-activity-probe.js";
import { createRunRegistry } from "./run-registry.js";
import { isActiveRunStatus, type RunRecord, type RunStore } from "./run-store.js";

const record = {
  workspaceId: "ws-a",
  engineSessionId: "sess-a",
  directory: "/tmp/workspace-a",
};

const mockFetch = (
  fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch => fn as unknown as typeof fetch;

const assistant = (input: {
  id?: string;
  completed?: number | string;
  error?: unknown;
  finish?: string;
}) => ({
  info: {
    id: input.id ?? "msg-assistant",
    sessionID: "sess-a",
    role: "assistant",
    time: {
      created: 1_000,
      ...(input.completed === undefined ? {} : { completed: input.completed }),
    },
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.finish === undefined ? {} : { finish: input.finish }),
  },
  parts: [],
});

const user = (id = "msg-user") => ({
  info: {
    id,
    sessionID: "sess-a",
    role: "user",
    time: { created: 900 },
  },
  parts: [],
});

function createMemoryRunStore(): RunStore {
  const records = new Map<string, RunRecord>();
  const key = (workspaceId: string, runId: string) => `${workspaceId}:${runId}`;

  return {
    insert(record) {
      records.set(key(record.workspaceId, record.runId), { ...record });
    },

    update(workspaceId, runId, patch) {
      const current = records.get(key(workspaceId, runId));
      if (!current) return null;
      const next = { ...current, ...patch };
      records.set(key(workspaceId, runId), next);
      return next;
    },

    get(workspaceId, runId) {
      return records.get(key(workspaceId, runId)) ?? null;
    },

    latestForConversation(workspaceId, conversationId) {
      return [...records.values()]
        .filter((record) => record.workspaceId === workspaceId && record.conversationId === conversationId)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    },

    activeForConversation(workspaceId, conversationId) {
      return [...records.values()]
        .filter((record) =>
          record.workspaceId === workspaceId &&
          record.conversationId === conversationId &&
          isActiveRunStatus(record.status)
        )
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    },

    hasActiveForWorkspace(workspaceId, createdSince) {
      return [...records.values()].some((record) =>
        record.workspaceId === workspaceId &&
        isActiveRunStatus(record.status) &&
        record.createdAt >= createdSince
      );
    },
  };
}

describe("run activity probe payload parsing", () => {
  test("session status reports busy and retry as active", () => {
    expect(deriveRunActivityFromSessionStatus({ "sess-a": { type: "busy" } }, "sess-a"))
      .toEqual({ active: true });
    expect(deriveRunActivityFromSessionStatus({ "sess-a": { type: "retry" } }, "sess-a"))
      .toEqual({ active: true });
  });

  test("session status reports idle as inactive", () => {
    expect(deriveRunActivityFromSessionStatus({ "sess-a": { type: "idle" } }, "sess-a"))
      .toEqual({ active: false });
  });

  test("unknown session status shape falls back to message probing", () => {
    expect(deriveRunActivityFromSessionStatus({ "sess-a": { type: "paused" } }, "sess-a"))
      .toBeNull();
    expect(deriveRunActivityFromSessionStatus({ other: { type: "idle" } }, "sess-a"))
      .toBeNull();
  });

  test("completed assistant as latest message is inactive", () => {
    expect(deriveRunActivityFromSessionMessages([
      user(),
      assistant({ completed: 2_000 }),
    ])).toEqual({ active: false });
  });

  test("assistant error or finish is terminal even when completed time is missing", () => {
    expect(deriveRunActivityFromSessionMessages([
      user(),
      assistant({ error: { name: "MessageAbortedError" } }),
    ])).toEqual({ active: false });
    expect(deriveRunActivityFromSessionMessages([
      user(),
      assistant({ finish: "stop" }),
    ])).toEqual({ active: false });
  });

  test("assistant without terminal fields remains active", () => {
    expect(deriveRunActivityFromSessionMessages([
      user(),
      assistant({}),
    ])).toEqual({ active: true });
  });

  test("newer user message after a completed assistant means the current run is active", () => {
    expect(deriveRunActivityFromSessionMessages([
      assistant({ id: "msg-old-assistant", completed: 2_000 }),
      user("msg-new-user"),
    ])).toEqual({ active: true });
  });

  test("message parser accepts OpenCode wrapper and raw SQLite message shapes", () => {
    expect(deriveRunActivityFromSessionMessages({
      items: [
        {
          id: "msg-assistant",
          sessionID: "sess-a",
          role: "assistant",
          time: { created: 1_000, completed: 2_000 },
        },
      ],
    })).toEqual({ active: false });
  });
});

describe("run activity probe HTTP behavior", () => {
  test("missing engine cannot have an active run", async () => {
    const probe = createRunActivityProbe({
      getEngine: () => null,
      buildEngineRequest: () => {
        throw new Error("must not build request without an engine");
      },
    });

    await expect(probe(record)).resolves.toEqual({ active: false });
  });

  test("idle session status returns inactive without fetching messages", async () => {
    const urls: string[] = [];
    const probe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: (async (input) => {
        urls.push(String(input));
        return Response.json({ "sess-a": { type: "idle" } });
      }) as typeof fetch,
    });

    await expect(probe(record)).resolves.toEqual({ active: false });
    expect(urls).toEqual(["http://engine/session/status"]);
  });

  test("busy session status returns active without fetching messages", async () => {
    const urls: string[] = [];
    const probe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: (async (input) => {
        urls.push(String(input));
        return Response.json({ "sess-a": { type: "busy" } });
      }) as typeof fetch,
    });

    await expect(probe(record)).resolves.toEqual({ active: true });
    expect(urls).toEqual(["http://engine/session/status"]);
  });

  test("unknown status shape falls back to message transcript", async () => {
    const urls: string[] = [];
    const probe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: (async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/session/status")) return Response.json({});
        return Response.json([user(), assistant({ completed: 2_000 })]);
      }) as typeof fetch,
    });

    await expect(probe(record)).resolves.toEqual({ active: false });
    expect(urls).toEqual([
      "http://engine/session/status",
      "http://engine/session/sess-a/message",
    ]);
  });

  test("missing session transcript unblocks the stale run", async () => {
    const probe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: (async (input) => {
        const url = String(input);
        if (url.endsWith("/session/status")) return Response.json({});
        return Response.json({ error: "not_found" }, { status: 404 });
      }) as typeof fetch,
    });

    await expect(probe(record)).resolves.toEqual({ active: false });
  });

  test("non-404 engine failures remain unreachable", async () => {
    const probe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: mockFetch(async () => Response.json({ error: "bad gateway" }, { status: 502 })),
    });

    await expect(probe(record)).resolves.toEqual({ unreachable: true });
  });
});

describe("run activity probe with registry reconciliation", () => {
  test("idle OpenCode status releases a stale active DB row before registering the next run", async () => {
    const store = createMemoryRunStore();
    const probeRunActivity = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: mockFetch(async () => Response.json({ "sess-a": { type: "idle" } })),
    });
    const registry = createRunRegistry({
      store,
      probeRunActivity,
      now: (() => {
        let current = 10_000;
        return () => current += 100;
      })(),
    });

    store.insert({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: "run-stale",
      engineSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      kind: "prompt",
      status: "running",
      abortRequested: false,
      createdAt: 1_000,
      startedAt: 1_000,
      completedAt: null,
      error: null,
    });

    const next = await registry.register({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: "run-next",
      engineSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      kind: "prompt",
    });

    expect(next.runId).toBe("run-next");
    expect(store.get("ws-a", "run-stale")?.status).toBe("completed");
    expect(store.activeForConversation("ws-a", "conv-a")?.runId).toBe("run-next");
  });
});
