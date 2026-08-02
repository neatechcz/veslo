import { describe, expect, test } from "bun:test";

import {
  createRunActivityProbe,
  deriveRunActivityFromSessionMessages,
  deriveRunActivityFromSessionStatus,
} from "../run-activity-probe.js";
import { deriveConversationRunOpenCodeMessageId } from "../conversation-run-message-id.js";
import { createRunRegistry, RunAlreadyActiveError } from "../run-registry.js";
import { isActiveRunStatus, type RunRecord, type RunStore } from "../run-store.js";

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
  created?: number;
  completed?: number | string;
  error?: unknown;
  finish?: string;
  parentID?: string;
  parts?: unknown[];
}) => ({
  info: {
    id: input.id ?? "msg-assistant",
    sessionID: "sess-a",
    role: "assistant",
    time: {
      created: input.created ?? 1_000,
      ...(input.completed === undefined ? {} : { completed: input.completed }),
    },
    ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.finish === undefined ? {} : { finish: input.finish }),
  },
  parts: input.parts ?? [],
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

    activeForEngineSession(input) {
      return [...records.values()]
        .filter((record) =>
          record.workspaceId === input.workspaceId &&
          record.engineSessionId === input.engineSessionId &&
          record.engineOwnerId === input.engineOwnerId &&
          record.enginePid === input.enginePid &&
          record.engineStartedAt === input.engineStartedAt &&
          record.engineBaseUrl === input.engineBaseUrl &&
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

    migrateWorkspaceId(sourceWorkspaceId, targetWorkspaceId) {
      return {
        migrated: false,
        sourceWorkspaceId,
        targetWorkspaceId,
        updated: 0,
        reason: "source_missing",
      };
    },

    activeForEngineOwner(engineOwnerId) {
      return [...records.values()]
        .filter((record) =>
          record.engineOwnerId === engineOwnerId &&
          isActiveRunStatus(record.status)
        )
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    activeCreatedBefore(createdBefore, limit = 200) {
      return [...records.values()]
        .filter((record) =>
          isActiveRunStatus(record.status) &&
          record.createdAt < createdBefore
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, limit);
    },
  };
}

describe("run activity probe payload parsing", () => {
  test("session status reports busy and retry as active", () => {
    expect(deriveRunActivityFromSessionStatus({ "sess-a": { type: "busy" } }, "sess-a"))
      .toMatchObject({ active: true, activityKind: "unknown", waitReason: "assistant_message_open" });
    expect(deriveRunActivityFromSessionStatus({ "sess-a": { type: "retry" } }, "sess-a"))
      .toMatchObject({ active: true, activityKind: "model_retry", waitReason: "model_retry_no_output" });
  });

  test("session status reports idle as inactive", () => {
    expect(deriveRunActivityFromSessionStatus({ "sess-a": { type: "idle" } }, "sess-a"))
      .toMatchObject({ active: false, activityKind: "idle", waitReason: "session_idle" });
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
      assistant({ completed: 2_000, parts: [{ type: "text", text: "Done" }] }),
    ])).toMatchObject({
      active: false,
      terminalStatus: "completed",
      activityKind: "idle",
      waitReason: "session_idle",
    });
  });

  test("assistant error or finish is terminal even when completed time is missing", () => {
    expect(deriveRunActivityFromSessionMessages([
      user(),
      assistant({ error: { name: "MessageAbortedError" } }),
    ])).toMatchObject({ active: false, activityKind: "idle", waitReason: "session_idle" });
    expect(deriveRunActivityFromSessionMessages([
      user(),
      assistant({ finish: "stop" }),
    ])).toMatchObject({
      active: false,
      terminalStatus: "failed",
      terminalError: "assistant_completed_without_visible_output",
      activityKind: "idle",
      waitReason: "session_idle",
    });
  });

  test("recognizes user-visible non-text assistant parts as output", () => {
    const parts = [
      { type: "file", url: "file:///workspace/result.txt" },
      { type: "agent", name: "build" },
      { type: "subtask", agent: "build", prompt: "implement", description: "Implement the change" },
      { type: "patch", hash: "patch-hash", files: ["src/result.ts"] },
    ];

    for (const part of parts) {
      expect(deriveRunActivityFromSessionMessages([
        user("msg-user"),
        assistant({ parentID: "msg-user", completed: 2_000, parts: [part] }),
      ], { expectedUserMessageId: "msg-user" })).toMatchObject({
        active: false,
        terminalStatus: "completed",
        terminalError: null,
      });
    }
  });

  test("idle session treats a visible patch as completion progress and keeps internal metadata empty", () => {
    const patch = { type: "patch", hash: "patch-hash", files: ["src/result.ts"] };
    const patchPending = deriveRunActivityFromSessionMessages([
      user("msg-user"),
      assistant({ parentID: "msg-user", parts: [patch] }),
    ], {
      expectedUserMessageId: "msg-user",
      sessionInactiveObserved: true,
      sessionExplicitlyIdle: true,
    });
    expect(patchPending).toMatchObject({
      active: false,
      terminalCandidate: true,
      terminalStatus: "completed",
    });

    const firstPatch = deriveRunActivityFromSessionMessages([
      user("msg-user"),
      assistant({ parentID: "msg-user", parts: [patch] }),
    ], { expectedUserMessageId: "msg-user" });
    const noPatch = deriveRunActivityFromSessionMessages([
      user("msg-user"),
      assistant({ parentID: "msg-user", parts: [] }),
    ], { expectedUserMessageId: "msg-user" });
    if ("unreachable" in firstPatch || "unreachable" in noPatch) {
      throw new Error("message-only probe must not be unreachable");
    }
    expect(firstPatch.progressSignature).not.toBe(noPatch.progressSignature);

    for (const part of [
      { type: "snapshot", snapshot: "snapshot-hash" },
      { type: "retry", attempt: 1, error: { message: "retry" } },
      { type: "compaction", auto: true },
      { type: "step-start" },
      { type: "step-finish" },
    ]) {
      expect(deriveRunActivityFromSessionMessages([
        user("msg-user"),
        assistant({ parentID: "msg-user", completed: 2_000, parts: [part] }),
      ], { expectedUserMessageId: "msg-user" })).toMatchObject({
        terminalStatus: "failed",
        terminalError: "assistant_completed_without_visible_output",
      });
    }
  });

  test("normalizes unsupported attachment errors and uses durable abort intent", () => {
    expect(deriveRunActivityFromSessionMessages([
      user(),
      assistant({ error: { name: "UnknownError", data: { message: "Unknown file type application/octet-stream" } } }),
    ])).toMatchObject({
      terminalStatus: "failed",
      terminalError: "attachment_runtime_rejected",
    });
    const abortedPayload = [
      user(),
      assistant({ error: { name: "MessageAbortedError", data: { message: "aborted" } } }),
    ];
    expect(deriveRunActivityFromSessionMessages(abortedPayload, { abortRequested: true }))
      .toMatchObject({ terminalStatus: "aborted" });
    expect(deriveRunActivityFromSessionMessages(abortedPayload, { abortRequested: false }))
      .toMatchObject({ terminalStatus: "failed", terminalError: "unexpected_message_abort" });
  });

  test("assistant without terminal fields remains active", () => {
    expect(deriveRunActivityFromSessionMessages([
      user(),
      assistant({}),
    ])).toMatchObject({ active: true, activityKind: "unknown", waitReason: "assistant_message_open" });
  });

  test("exact terminal assistant is definitive for the admitted run", () => {
    expect(deriveRunActivityFromSessionMessages([
      user("msg-admitted"),
      assistant({
        parentID: "msg-admitted",
        finish: "stop",
        parts: [{ type: "text", text: "Done" }],
      }),
    ], { expectedUserMessageId: "msg-admitted" })).toMatchObject({
      active: false,
      terminalCandidate: true,
      terminalConfirmed: true,
      terminalStatus: "completed",
    });
  });

  test("inactive OpenCode session keeps an unfinished exact run pending", () => {
    expect(deriveRunActivityFromSessionMessages([
      user("msg-admitted"),
      assistant({ parentID: "msg-admitted" }),
    ], {
      expectedUserMessageId: "msg-admitted",
      sessionInactiveObserved: true,
    })).toMatchObject({
      active: true,
      activityKind: "unknown",
      waitReason: "assistant_message_open",
    });
  });

  test("newer user message after a completed assistant means the current run is active", () => {
    expect(deriveRunActivityFromSessionMessages([
      assistant({ id: "msg-old-assistant", completed: 2_000 }),
      user("msg-new-user"),
    ])).toMatchObject({ active: true, activityKind: "unknown", waitReason: "assistant_message_open" });
  });

  test("open assistant tool part is active local tool progress", () => {
    expect(deriveRunActivityFromSessionMessages([
      user(),
      assistant({
        parts: [
          {
            type: "tool",
            tool: "bash",
            state: { status: "running" },
          },
        ],
      }),
    ])).toMatchObject({ active: true, activityKind: "local_tool", waitReason: "running_tool" });
  });

  test("assistant text after a tool error is a recovered result, not a run failure", () => {
    expect(deriveRunActivityFromSessionMessages([
      user(),
      assistant({
        parts: [
          {
            type: "tool",
            tool: "chrome-devtools_new_page",
            state: { status: "error", error: "navigation failed" },
          },
          {
            type: "text",
            text: "I could not open the page, but the session is still available.",
          },
        ],
      }),
    ])).toMatchObject({
      active: true,
      activityKind: "assistant_output",
      waitReason: "assistant_message_open",
    });
  });

  test("assistant text part is assistant output progress", () => {
    expect(deriveRunActivityFromSessionMessages([
      user(),
      assistant({
        parts: [
          {
            type: "text",
            text: "working through the result",
          },
        ],
      }),
    ])).toMatchObject({ active: true, activityKind: "assistant_output", waitReason: "assistant_message_open" });
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
    })).toMatchObject({ active: false, activityKind: "idle", waitReason: "session_idle" });
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

    await expect(probe(record)).resolves.toEqual({
      unreachable: true,
      unavailableReason: "no_current_engine",
    });
  });

  test("idle session status requires a terminal transcript candidate", async () => {
    const urls: string[] = [];
    const probe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: (async (input) => {
        urls.push(String(input));
        if (String(input).endsWith("/session/status")) {
          return Response.json({ "sess-a": { type: "idle" } });
        }
        return Response.json([user(), assistant({ completed: 2_000 })]);
      }) as typeof fetch,
    });

    await expect(probe(record)).resolves.toMatchObject({
      active: false,
      terminalCandidate: true,
      activityKind: "idle",
      sessionStatusObserved: "explicit_idle",
    });
    expect(urls).toEqual(["http://engine/session/status", "http://engine/session/sess-a/message"]);
  });

  test("busy session does not release a completed assistant transcript to a queued successor", async () => {
    const probe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: (async (input) => {
        if (String(input).endsWith("/session/status")) {
          return Response.json({ "sess-a": { type: "busy" } });
        }
        return Response.json([user(), assistant({ completed: 2_000 })]);
      }) as typeof fetch,
    });

    await expect(probe(record)).resolves.toMatchObject({
      active: true,
      activityKind: "unknown",
      waitReason: "assistant_message_open",
      sessionStatusObserved: "busy",
    });
  });

  test("does not treat a pre-admission terminal assistant as completion for a new run", async () => {
    const probe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: (async (input) => {
        if (String(input).endsWith("/session/status")) return Response.json({ "sess-a": { type: "idle" } });
        return Response.json([user(), assistant({ created: 1_000, completed: 2_000 })]);
      }) as typeof fetch,
    });

    await expect(probe({ ...record, createdAt: 1_500 })).resolves.toMatchObject({
      active: true,
      waitReason: "assistant_message_open",
    });
  });

  test("uses the persisted exact admission message id instead of a legacy-derived or older assistant", async () => {
    const clientMessageId = "client-current";
    const legacyAdmissionMessageId = deriveConversationRunOpenCodeMessageId({
      workspaceId: record.workspaceId,
      engineSessionId: record.engineSessionId,
      clientMessageId,
    });
    const admissionMessageId = "msg_f946e8a160003a693ab36fcd8e";
    expect(admissionMessageId).not.toBe(legacyAdmissionMessageId);
    const probe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: (async (input) => {
        if (String(input).endsWith("/session/status")) return Response.json({ "sess-a": { type: "idle" } });
        return Response.json([
          user("msg-old-user"),
          assistant({ id: "msg-old-assistant", completed: 2_000 }),
          user(admissionMessageId),
          assistant({ id: "msg-current-assistant", parentID: admissionMessageId, completed: 4_000 }),
        ]);
      }) as typeof fetch,
    });

    await expect(probe({
      ...record,
      kind: "prompt",
      clientMessageId,
      opencodeMessageId: admissionMessageId,
    })).resolves.toMatchObject({
      active: false,
      terminalCandidate: true,
      terminalConfirmed: true,
      progressSignature: expect.stringContaining("msg-current-assistant"),
    });
  });

  test("idle status with no exact admitted message becomes an orphan candidate", async () => {
    const clientMessageId = "client-after-stale-error";
    const probe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: (async (input) => {
        if (String(input).endsWith("/session/status")) return Response.json({ "sess-a": { type: "idle" } });
        return Response.json([
          user("msg-old-user"),
          assistant({
            id: "msg-old-assistant",
            parentID: "msg-old-user",
            error: { name: "UnknownError", data: { message: "Unknown file type application/octet-stream" } },
          }),
        ]);
      }) as typeof fetch,
    });

    await expect(probe({ ...record, kind: "prompt", clientMessageId })).resolves.toMatchObject({
      active: true,
      activityKind: "unknown",
      waitReason: "assistant_message_open",
    });
  });

  test("missing session status entry keeps an unfinished exact run pending", async () => {
    const admissionMessageId = "msg_f946e8a160003a693ab36fcd8e";
    const probe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: (async (input) => {
        if (String(input).endsWith("/session/status")) return Response.json({});
        return Response.json([
          user(admissionMessageId),
          assistant({ parentID: admissionMessageId }),
        ]);
      }) as typeof fetch,
    });

    await expect(probe({
      ...record,
      kind: "prompt",
      clientMessageId: "client-current",
      opencodeMessageId: admissionMessageId,
    })).resolves.toMatchObject({
      active: true,
      activityKind: "unknown",
      waitReason: "assistant_message_open",
    });
  });

  test("busy session keeps the same unfinished exact run active", async () => {
    const admissionMessageId = "msg_f946e8a160003a693ab36fcd8e";
    const probe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: (async (input) => {
        if (String(input).endsWith("/session/status")) {
          return Response.json({ "sess-a": { type: "busy" } });
        }
        return Response.json([
          user(admissionMessageId),
          assistant({ parentID: admissionMessageId }),
        ]);
      }) as typeof fetch,
    });

    await expect(probe({
      ...record,
      kind: "prompt",
      clientMessageId: "client-current",
      opencodeMessageId: admissionMessageId,
    })).resolves.toMatchObject({
      active: true,
      waitReason: "assistant_message_open",
    });
  });

  test("busy session status checks messages before returning a generic active state", async () => {
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
        if (url.endsWith("/session/status")) return Response.json({ "sess-a": { type: "busy" } });
        return Response.json([user(), assistant({})]);
      }) as typeof fetch,
    });

    await expect(probe(record)).resolves.toMatchObject({ active: true, activityKind: "unknown" });
    expect(urls).toEqual([
      "http://engine/session/status",
      "http://engine/session/sess-a/message",
    ]);
  });

  test("retry session status fetches messages and reports no-output model retry", async () => {
    // Incident fixture handles:
    // ws-d8520858f77f / conv-a193a04c3c367d41c275 /
    // f164e323-2196-4c37-98f8-bef1056c451b / ses_0d8eca46fffexqldAJbOl6gTLf.
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
        if (url.endsWith("/session/status")) return Response.json({ "sess-a": { type: "retry" } });
        return Response.json([user(), assistant({})]);
      }) as typeof fetch,
    });

    await expect(probe(record)).resolves.toMatchObject({
      active: true,
      activityKind: "model_retry",
      waitReason: "model_retry_no_output",
    });
    expect(urls).toEqual([
      "http://engine/session/status",
      "http://engine/session/sess-a/message",
    ]);
  });

  test("retry session status yields to a visible assistant response in the transcript", async () => {
    const probe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: (async (input) => {
        if (String(input).endsWith("/session/status")) {
          return Response.json({ "sess-a": { type: "retry" } });
        }
        return Response.json([
          user(),
          assistant({ parts: [{ type: "text", text: "Late, but usable answer." }] }),
        ]);
      }) as typeof fetch,
    });

    await expect(probe(record)).resolves.toMatchObject({
      active: true,
      activityKind: "assistant_output",
      waitReason: "assistant_message_open",
    });
  });

  test("retry session with running tool is still classified as local tool work", async () => {
    const probe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: (async (input) => {
        const url = String(input);
        if (url.endsWith("/session/status")) return Response.json({ "sess-a": { type: "retry" } });
        return Response.json([
          user(),
          assistant({
            parts: [
              {
                type: "tool",
                tool: "grep",
                state: { status: "running" },
              },
            ],
          }),
        ]);
      }) as typeof fetch,
    });

    await expect(probe(record)).resolves.toMatchObject({
      active: true,
      activityKind: "local_tool",
      waitReason: "running_tool",
    });
  });

  test("busy session with a running tool prefers transcript tool activity", async () => {
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
        if (url.endsWith("/session/status")) return Response.json({ "sess-a": { type: "busy" } });
        return Response.json([
          user(),
          assistant({
            parts: [
              {
                type: "tool",
                tool: "chrome-devtools_new_page",
                state: { status: "running" },
              },
            ],
          }),
        ]);
      }) as typeof fetch,
    });

    await expect(probe(record)).resolves.toMatchObject({
      active: true,
      activityKind: "local_tool",
      waitReason: "running_tool",
    });
    expect(urls).toEqual([
      "http://engine/session/status",
      "http://engine/session/sess-a/message",
    ]);
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

    await expect(probe(record)).resolves.toMatchObject({ active: false, activityKind: "idle" });
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

    await expect(probe(record)).resolves.toEqual({
      unreachable: true,
      unavailableReason: "session_messages_missing",
      unavailableHttpStatus: 404,
    });
  });

  test("non-404 transcript failures retain a distinct unavailable reason", async () => {
    const probe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: (async (input) => {
        const url = String(input);
        return url.endsWith("/session/status")
          ? Response.json({})
          : Response.json({ error: "unavailable" }, { status: 503 });
      }) as typeof fetch,
    });

    await expect(probe(record)).resolves.toEqual({
      unreachable: true,
      unavailableReason: "session_messages_http",
      unavailableHttpStatus: 503,
    });
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

    await expect(probe(record)).resolves.toEqual({
      unreachable: true,
      unavailableReason: "session_status_http",
      unavailableHttpStatus: 502,
    });
  });
});

describe("run activity probe with registry reconciliation", () => {
  test("completes a stable admitted answer after two explicit idle polls", async () => {
    const store = createMemoryRunStore();
    const admissionMessageId = "msg-admitted-long-answer";
    const probeRunActivity = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: mockFetch(async (input) => {
        if (String(input).endsWith("/session/status")) {
          return Response.json({ "sess-a": { type: "idle" } });
        }
        return Response.json([
          user(admissionMessageId),
          assistant({
            id: "msg-assistant-in-progress",
            parentID: admissionMessageId,
            parts: [{ type: "text", text: "A long answer is still being written." }],
          }),
        ]);
      }),
    });
    const registry = createRunRegistry({
      store,
      probeRunActivity: probeRunActivity,
      now: (() => {
        let current = 10_000;
        return () => current += 100;
      })(),
    });

    await registry.register({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: "run-idle-race",
      engineSessionId: "sess-a",
      clientMessageId: "client-long-answer",
      opencodeMessageId: admissionMessageId,
      directory: "/tmp/workspace-a",
      kind: "prompt",
    });

    const firstPoll = await registry.get("ws-a", "run-idle-race");
    const secondPoll = await registry.get("ws-a", "run-idle-race");

    expect(firstPoll?.record).toMatchObject({
      status: "running",
      activityKind: "idle",
      waitReason: "session_idle",
    });
    expect(secondPoll?.record).toMatchObject({
      status: "completed",
      error: null,
    });
  });

  test("idle OpenCode status releases a stale active DB row before registering the next run", async () => {
    const store = createMemoryRunStore();
    const probeRunActivity = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: mockFetch(async (input) =>
        String(input).endsWith("/session/status")
          ? Response.json({ "sess-a": { type: "idle" } })
          : Response.json([
              user(),
              assistant({
                created: 2_000,
                completed: 3_000,
                parts: [{ type: "text", text: "Done" }],
              }),
            ]),
      ),
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
      clientMessageId: null,
      origin: null,
      directory: "/tmp/workspace-a",
      kind: "prompt",
      status: "running",
      abortRequested: false,
      createdAt: 1_000,
      startedAt: 1_000,
      completedAt: null,
      error: null,
      engineSlotId: null,
      engineOwnerState: "pending",
      activityKind: null,
      waitReason: null,
      lastUsefulProgressAt: 1_000,
      retrySince: null,
      lastProgressSignature: null,
      engineOwnerId: null,
      enginePid: null,
      engineStartedAt: null,
      engineBaseUrl: null,
    });

    await registry.get("ws-a", "run-stale");
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

  test("busy OpenCode status keeps a completed transcript from admitting the next run", async () => {
    const store = createMemoryRunStore();
    const probeRunActivity = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({
        url: `http://engine${input.targetPath}`,
        headers: {},
      }),
      fetchImpl: mockFetch(async (input) =>
        String(input).endsWith("/session/status")
          ? Response.json({ "sess-a": { type: "busy" } })
          : Response.json([
              user(),
              assistant({
                completed: 3_000,
                parts: [{ type: "text", text: "Done" }],
              }),
            ]),
      ),
    });
    const registry = createRunRegistry({ store, probeRunActivity });
    store.insert({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: "run-still-busy",
      engineSessionId: "sess-a",
      clientMessageId: null,
      origin: null,
      directory: "/tmp/workspace-a",
      kind: "prompt",
      status: "running",
      abortRequested: false,
      createdAt: 1_000,
      startedAt: 1_000,
      completedAt: null,
      error: null,
      engineSlotId: null,
      engineOwnerState: "pending",
      activityKind: null,
      waitReason: null,
      lastUsefulProgressAt: 1_000,
      retrySince: null,
      lastProgressSignature: null,
      engineOwnerId: null,
      enginePid: null,
      engineStartedAt: null,
      engineBaseUrl: null,
    });

    await expect(registry.register({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: "run-next",
      engineSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      kind: "prompt",
    })).rejects.toBeInstanceOf(RunAlreadyActiveError);
    expect(store.get("ws-a", "run-still-busy")?.status).toBe("running");
  });

  test("timeout and transport failures retain different safe unavailable reasons", async () => {
    const timeoutProbe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({ url: `http://engine${input.targetPath}`, headers: {} }),
      fetchImpl: mockFetch(async () => { throw new DOMException("timed out", "TimeoutError"); }),
    });
    const transportProbe = createRunActivityProbe({
      getEngine: () => ({ baseUrl: "http://engine" }),
      buildEngineRequest: (_engine, input) => ({ url: `http://engine${input.targetPath}`, headers: {} }),
      fetchImpl: mockFetch(async () => { throw new TypeError("connection reset"); }),
    });

    await expect(timeoutProbe(record)).resolves.toEqual({
      unreachable: true,
      unavailableReason: "request_timeout",
    });
    await expect(transportProbe(record)).resolves.toEqual({
      unreachable: true,
      unavailableReason: "request_transport_error",
    });
  });
});
