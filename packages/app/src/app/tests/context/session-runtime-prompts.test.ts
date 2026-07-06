import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import {
  createSessionRuntimePrompts,
  shouldReleaseStaleWorkspaceRoute,
} from "../../context/session-runtime-prompts.js";
import type { PendingPermission, PendingQuestion } from "../../types";

function ok<T>(data: T) {
  return {
    data,
    request: new Request("http://localhost.test"),
    response: new Response(),
  };
}

const permission = (id: string, sessionID: string, workspaceId?: string): PendingPermission =>
  ({
    id,
    sessionID,
    workspaceId,
    permission: "bash",
    patterns: ["*"],
    metadata: {},
    receivedAt: 0,
  }) as PendingPermission;

const question = (id: string, sessionID: string, workspaceId?: string): PendingQuestion =>
  ({
    id,
    sessionID,
    workspaceId,
    questions: [],
    receivedAt: 0,
  }) as PendingQuestion;

function makeClient(input: {
  permissions?: PendingPermission[];
  questions?: PendingQuestion[];
  permissionList?: () => Promise<unknown>;
  questionList?: () => Promise<unknown>;
  permissionReply?: (input: { requestID: string; reply: string }) => Promise<unknown>;
  questionReply?: (input: { requestID: string; answers?: string[][] }) => Promise<unknown>;
  questionReject?: (input: { requestID: string }) => Promise<unknown>;
  v2PermissionReply?: (input: { sessionID: string; requestID: string; reply: string }) => Promise<unknown>;
  v2QuestionReply?: (input: {
    sessionID: string;
    requestID: string;
    questionV2Reply: { answers: string[][] };
  }) => Promise<unknown>;
  v2QuestionReject?: (input: { sessionID: string; requestID: string }) => Promise<unknown>;
  calls?: string[];
  workspaceId: string;
}) {
  return {
    permission: {
      list: input.permissionList ?? (async () => ok(input.permissions ?? [])),
      reply:
        input.permissionReply ??
        (async ({ requestID, reply }: { requestID: string; reply: string }) => {
          input.calls?.push(`${input.workspaceId}:permission:${requestID}:${reply}`);
          return ok(null);
        }),
    },
    question: {
      list: input.questionList ?? (async () => ok(input.questions ?? [])),
      reply:
        input.questionReply ??
        (async ({ requestID }: { requestID: string }) => {
          input.calls?.push(`${input.workspaceId}:question-reply:${requestID}`);
          return ok(null);
        }),
      reject:
        input.questionReject ??
        (async ({ requestID }: { requestID: string }) => {
          input.calls?.push(`${input.workspaceId}:question-reject:${requestID}`);
          return ok(null);
        }),
    },
    v2: {
      session: {
        permission: {
          reply: input.v2PermissionReply,
        },
        question: {
          reply: input.v2QuestionReply,
          reject: input.v2QuestionReject,
        },
      },
    },
  };
}

function makeController(options: {
  activeWorkspaceId?: string;
  selectedSessionId?: string | null;
  clients: Record<string, any>;
  readyWorkspaces?: Set<string>;
  release?: (workspaceId: string) => void;
}): ReturnType<typeof createSessionRuntimePrompts> & {
  setSelectedSessionId: (id: string | null) => void;
  store: {
    pendingPermissions: PendingPermission[];
    pendingQuestions: PendingQuestion[];
  };
} {
  const [store, setStore] = createStore({
    pendingPermissions: [] as PendingPermission[],
    pendingQuestions: [] as PendingQuestion[],
  });
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(
    options.selectedSessionId === undefined ? "sess-a" : options.selectedSessionId,
  );
  const activeWorkspaceId = options.activeWorkspaceId ?? "ws-a";
  const readyWorkspaces = options.readyWorkspaces ?? new Set(Object.keys(options.clients));
  const routing = {
    active: () => options.clients[activeWorkspaceId] ?? null,
    client: (workspaceId?: string) => options.clients[workspaceId ?? activeWorkspaceId] ?? null,
    activeWorkspaceId: () => activeWorkspaceId,
    entry: () => null,
    entryIds: () => Object.keys(options.clients),
    forEach: (cb: (workspaceId: string, client: any) => void) => {
      for (const [workspaceId, client] of Object.entries(options.clients)) cb(workspaceId, client);
    },
    release: options.release ?? (() => {}),
  };

  const controller = createSessionRuntimePrompts({
    store,
    setStore: setStore as any,
    routing: routing as any,
    selectedSessionId,
    isWorkspaceRuntimeReady: (workspaceId) => readyWorkspaces.has(workspaceId ?? activeWorkspaceId),
    hasAnyRefreshableRuntime: () => readyWorkspaces.size > 0,
    activeSendTraceId: () => null,
    sessionDebug: () => {},
    sessionWarn: () => {},
    setError: () => {},
    addError: (error) => {
      throw error;
    },
  });

  return Object.assign(controller, { setSelectedSessionId, store });
}

test("stale route helper only releases background runtime route failures", () => {
  assert.equal(
    shouldReleaseStaleWorkspaceRoute("ws-stale", "ws-active", '{"error":"engine_not_running"}'),
    true,
  );
  assert.equal(
    shouldReleaseStaleWorkspaceRoute("ws-active", "ws-active", '{"error":"engine_not_running"}'),
    false,
  );
  assert.equal(shouldReleaseStaleWorkspaceRoute("ws-stale", "ws-active", "validation failed"), false);
});

test("refresh aggregates permissions and questions per ready workspace", async () => {
  await createRoot(async (dispose) => {
    try {
      const clients = {
        "ws-a": makeClient({
          workspaceId: "ws-a",
          permissions: [permission("perm-a", "sess-a")],
          questions: [question("question-a", "sess-a")],
        }),
        "ws-b": makeClient({
          workspaceId: "ws-b",
          permissions: [permission("perm-b", "sess-b")],
          questions: [question("question-b", "sess-b")],
        }),
      };
      const prompts = makeController({ activeWorkspaceId: "ws-a", clients });

      await prompts.refreshPendingPermissions();
      await prompts.refreshPendingQuestions();
      const firstReceivedAt = prompts.pendingPermissionsByWs()["ws-a"][0].receivedAt;

      assert.deepEqual(Object.keys(prompts.pendingPermissionsByWs()).sort(), ["ws-a", "ws-b"]);
      assert.deepEqual(prompts.pendingPermissionCountByWs(), { "ws-a": 1, "ws-b": 1 });
      assert.deepEqual(prompts.allPendingPermissions().map((item) => item.id).sort(), ["perm-a", "perm-b"]);
      assert.deepEqual(prompts.pendingPermissions().map((item) => item.id), ["perm-a"]);
      assert.deepEqual(prompts.allPendingQuestions().map((item) => item.id).sort(), [
        "question-a",
        "question-b",
      ]);
      assert.deepEqual(prompts.pendingQuestions().map((item) => item.id), ["question-a"]);

      await prompts.refreshPendingPermissions();
      assert.equal(prompts.pendingPermissionsByWs()["ws-a"][0].receivedAt, firstReceivedAt);
    } finally {
      dispose();
    }
  });
});

test("refresh releases stale non-active runtime routes and keeps active failures visible", async () => {
  await createRoot(async (dispose) => {
    try {
      const released: string[] = [];
      const clients = {
        "ws-active": makeClient({ workspaceId: "ws-active", permissions: [], questions: [] }),
        "ws-stale": makeClient({
          workspaceId: "ws-stale",
          permissionList: async () => {
            throw new Error("engine_not_running");
          },
          questionList: async () => {
            throw new Error("engine_not_running");
          },
        }),
      };
      const prompts = makeController({
        activeWorkspaceId: "ws-active",
        clients,
        release: (workspaceId) => released.push(workspaceId),
      });

      await prompts.refreshPendingPermissions();
      assert.deepEqual(released, ["ws-stale"]);
      assert.deepEqual(Object.keys(prompts.pendingPermissionsByWs()), ["ws-active"]);

      released.length = 0;
      await prompts.refreshPendingQuestions();
      assert.deepEqual(released, ["ws-stale"]);
      assert.deepEqual(Object.keys(prompts.pendingQuestionsByWs()), ["ws-active"]);

      released.length = 0;
      const activeFailurePrompts = makeController({
        activeWorkspaceId: "ws-active",
        clients: {
          "ws-active": makeClient({
            workspaceId: "ws-active",
            permissionList: async () => {
              throw new Error("engine_not_running");
            },
          }),
        },
        release: (workspaceId) => released.push(workspaceId),
      });
      await activeFailurePrompts.refreshPendingPermissions();
      assert.deepEqual(released, []);
      assert.deepEqual(Object.keys(activeFailurePrompts.pendingPermissionsByWs()), ["ws-active"]);
    } finally {
      dispose();
    }
  });
});

test("workspace-level permission can become active without a selected session", async () => {
  await createRoot(async (dispose) => {
    try {
      const prompts = makeController({
        activeWorkspaceId: "ws-a",
        selectedSessionId: null,
        clients: {},
      });
      const workspacePermission = {
        ...permission("workspace-perm", "workspace-access", "ws-a"),
        permission: "folder_access",
        metadata: {
          requestedPath: "/Users/example/Documents/Project",
          source: "workspace-runtime-access-denied",
        },
      };

      prompts.setPendingPermissions([workspacePermission]);

      assert.equal(prompts.activePermission()?.id, "workspace-perm");
    } finally {
      dispose();
    }
  });
});

test("active prompts do not surface background prompts without a real selected session", async () => {
  await createRoot(async (dispose) => {
    try {
      const prompts = makeController({
        activeWorkspaceId: "ws-b",
        selectedSessionId: null,
        clients: {
          "ws-a": makeClient({
            workspaceId: "ws-a",
            permissions: [permission("perm-a", "sess-a")],
            questions: [question("question-a", "sess-a")],
          }),
          "ws-b": makeClient({
            workspaceId: "ws-b",
            permissions: [permission("perm-b", "sess-b")],
            questions: [question("question-b", "sess-b")],
          }),
        },
      });
      await prompts.refreshPendingPermissions();
      await prompts.refreshPendingQuestions();

      assert.equal(prompts.activePermission(), null);
      assert.equal(prompts.activeQuestion(), null);

      prompts.setSelectedSessionId("sess-a");
      assert.equal(prompts.activeQuestion()?.id, "question-a");
      assert.equal(prompts.activePermission()?.id, "perm-a");
    } finally {
      dispose();
    }
  });
});

test("permission replies do not fall back to the active workspace when owner client is missing", async () => {
  await createRoot(async (dispose) => {
    try {
      const calls: string[] = [];
      const clients = {
        "ws-a": makeClient({
          workspaceId: "ws-a",
          calls,
          permissions: [permission("perm-active", "sess-active")],
        }),
        "ws-b": makeClient({
          workspaceId: "ws-b",
          calls,
          permissions: [permission("perm-b", "sess-b")],
        }),
      };
      const prompts = makeController({
        activeWorkspaceId: "ws-a",
        clients,
      });
      await prompts.refreshPendingPermissions();
      delete (clients as Record<string, unknown>)["ws-b"];

      await prompts.respondPermission("perm-b", "once");

      assert.deepEqual(calls, []);
    } finally {
      dispose();
    }
  });
});

test("permission and question replies route to the workspace that owns the prompt", async () => {
  await createRoot(async (dispose) => {
    try {
      const calls: string[] = [];
      const prompts = makeController({
        activeWorkspaceId: "ws-a",
        clients: {
          "ws-a": makeClient({
            workspaceId: "ws-a",
            calls,
            permissions: [permission("perm-a", "sess-a")],
            questions: [question("question-a", "sess-a")],
          }),
          "ws-b": makeClient({
            workspaceId: "ws-b",
            calls,
            permissions: [permission("perm-b", "sess-b")],
            questions: [question("question-b", "sess-b")],
          }),
        },
      });
      await prompts.refreshPendingPermissions();
      await prompts.refreshPendingQuestions();

      await prompts.respondPermission("perm-b", "once");
      await prompts.respondQuestion("question-b", [["yes"]]);
      await prompts.rejectQuestion("question-b");

      assert.deepEqual(calls, [
        "ws-b:permission:perm-b:once",
        "ws-b:question-reply:question-b",
        "ws-b:question-reject:question-b",
      ]);
    } finally {
      dispose();
    }
  });
});

test("session-scoped v2 permission and question replies are used when top-level replies cannot find the request", async () => {
  await createRoot(async (dispose) => {
    try {
      const calls: string[] = [];
      const notFound = new Error('{"_tag":"QuestionNotFoundError","message":"not found"}');
      const permissionNotFound = new Error('{"_tag":"PermissionNotFoundError","message":"not found"}');
      const prompts = makeController({
        activeWorkspaceId: "ws-a",
        clients: {
          "ws-a": makeClient({ workspaceId: "ws-a", calls }),
          "ws-b": makeClient({
            workspaceId: "ws-b",
            calls,
            permissions: [permission("perm-v2", "sess-v2")],
            questions: [question("question-v2", "sess-v2")],
            permissionReply: async ({ requestID, reply }) => {
              calls.push(`ws-b:permission-top:${requestID}:${reply}`);
              throw permissionNotFound;
            },
            questionReply: async ({ requestID, answers }) => {
              calls.push(`ws-b:question-top:${requestID}:${JSON.stringify(answers)}`);
              throw notFound;
            },
            questionReject: async ({ requestID }) => {
              calls.push(`ws-b:question-reject-top:${requestID}`);
              throw notFound;
            },
            v2PermissionReply: async ({ sessionID, requestID, reply }) => {
              calls.push(`ws-b:v2-permission:${sessionID}:${requestID}:${reply}`);
              return ok(null);
            },
            v2QuestionReply: async ({ sessionID, requestID, questionV2Reply }) => {
              calls.push(`ws-b:v2-question:${sessionID}:${requestID}:${JSON.stringify(questionV2Reply.answers)}`);
              return ok(null);
            },
            v2QuestionReject: async ({ sessionID, requestID }) => {
              calls.push(`ws-b:v2-question-reject:${sessionID}:${requestID}`);
              return ok(null);
            },
          }),
        },
      });
      await prompts.refreshPendingPermissions();
      await prompts.refreshPendingQuestions();

      await prompts.respondPermission("perm-v2", "once");
      await prompts.respondQuestion("question-v2", [["yes"]]);
      await prompts.rejectQuestion("question-v2");

      assert.deepEqual(calls, [
        "ws-b:permission-top:perm-v2:once",
        "ws-b:v2-permission:sess-v2:perm-v2:once",
        'ws-b:question-top:question-v2:[["yes"]]',
        'ws-b:v2-question:sess-v2:question-v2:[["yes"]]',
        "ws-b:question-reject-top:question-v2",
        "ws-b:v2-question-reject:sess-v2:question-v2",
      ]);
    } finally {
      dispose();
    }
  });
});
