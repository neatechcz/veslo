import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import {
  createConversationRunLifecycleController,
  type ConversationRunLifecycleSubmitInput,
} from "../conversation-run-lifecycle-controller.js";
import { createConversationRunQueueStore } from "../conversation-run-queue-store.js";
import { ApiError } from "../errors.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

const submitInput = (): ConversationRunLifecycleSubmitInput => ({
  runTrace: {
    entries: [],
    traceId: "trace-identity",
    record() {},
    async step(_event, fn) {
      return await fn();
    },
  },
  workspace: {
    id: "ws_1",
    name: "Workspace",
    path: "/repo",
    workspaceType: "local",
  },
  target: {
    directory: "/repo",
    opencodeSessionId: "sess-a",
    conversationId: "conv-a",
  },
  runId: "run-reserved",
  kind: "prompt_async",
  body: { parts: [{ type: "text", text: "Hello" }] },
  clientMessageId: "client-a",
  origin: "composer",
  expectAiGatewayStart: false,
});

async function harness(persistPromptIdentity: (input: ConversationRunLifecycleSubmitInput) => void) {
  const dataDir = await mkdtemp(join(tmpdir(), "veslo-prompt-identity-controller-"));
  tempDirs.push(dataDir);
  const queueStore = createConversationRunQueueStore({ dataDir });
  const lifecycleCalls: string[] = [];
  const upstreamCalls: unknown[] = [];
  const controller = createConversationRunLifecycleController({
    queueStore,
    lifecycleClient: {
      active: async () => {
        lifecycleCalls.push("active");
        return null;
      },
      status: async () => {
        lifecycleCalls.push("status");
        return null;
      },
      register: async () => {
        lifecycleCalls.push("register");
        return null;
      },
    } as never,
    persistPromptIdentity,
    submitOpenCode: async (input) => {
      upstreamCalls.push(input);
      return { accepted: true };
    },
  });
  return { controller, queueStore, lifecycleCalls, upstreamCalls };
}

test("identity write failure is recoverable, releases the exact reservation, and dispatches nothing", async () => {
  const fixture = await harness(() => {
    throw new Error("snapshot writer unavailable");
  });

  await expect(fixture.controller.submitRun(submitInput())).rejects.toMatchObject({
    status: 503,
    code: "prompt_identity_persistence_failed",
    details: { recoverable: true },
  });
  expect(fixture.queueStore.listWorkspaceRunReservations()).toEqual([]);
  expect(fixture.lifecycleCalls).toEqual(["active", "status"]);
  expect(fixture.upstreamCalls).toEqual([]);
});

test("identity conflict is hard, releases the exact reservation, and dispatches nothing", async () => {
  const fixture = await harness(() => {
    throw new ApiError(409, "prompt_identity_conflict", "identity conflict", { recoverable: false });
  });

  await expect(fixture.controller.submitRun(submitInput())).rejects.toMatchObject({
    status: 409,
    code: "prompt_identity_conflict",
    details: { recoverable: false },
  });
  expect(fixture.queueStore.listWorkspaceRunReservations()).toEqual([]);
  expect(fixture.lifecycleCalls).toEqual(["active", "status"]);
  expect(fixture.upstreamCalls).toEqual([]);
});
