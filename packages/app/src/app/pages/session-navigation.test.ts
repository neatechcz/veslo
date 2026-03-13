import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionWithWorkspaceActivation,
  openSessionWithWorkspaceActivation,
} from "./session-navigation.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("opens immediately when session is in active workspace", async () => {
  const opened: string[] = [];
  const activated: string[] = [];

  const result = await openSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-active",
    sessionId: "sess-1",
    activateWorkspace: async (id) => {
      activated.push(id);
      return true;
    },
    openSession: (id) => opened.push(id),
  });

  assert.equal(result, true);
  assert.deepEqual(activated, []);
  assert.deepEqual(opened, ["sess-1"]);
});

test("does not open session when cross-workspace activation fails", async () => {
  const opened: string[] = [];
  const activated: string[] = [];

  const result = await openSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-other",
    sessionId: "sess-2",
    activateWorkspace: async (id) => {
      activated.push(id);
      return false;
    },
    openSession: (id) => opened.push(id),
  });

  assert.equal(result, false);
  assert.deepEqual(activated, ["ws-other"]);
  assert.deepEqual(opened, []);
});

test("opens session after successful cross-workspace activation", async () => {
  const opened: string[] = [];
  const activated: string[] = [];

  const result = await openSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-other",
    sessionId: "sess-3",
    activateWorkspace: async (id) => {
      activated.push(id);
      return true;
    },
    openSession: (id) => opened.push(id),
  });

  assert.equal(result, true);
  assert.deepEqual(activated, ["ws-other"]);
  assert.deepEqual(opened, ["sess-3"]);
});

test("serializes rapid cross-workspace session clicks and only opens the latest session", async () => {
  const opened: string[] = [];
  const activationEvents: string[] = [];
  const gate = deferred<void>();
  let concurrent = 0;
  let maxConcurrent = 0;
  const activateWorkspace = async (id: string) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    activationEvents.push(`start:${id}`);
    await gate.promise;
    concurrent -= 1;
    activationEvents.push(`end:${id}`);
    return true;
  };

  const first = openSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-one",
    sessionId: "sess-1",
    activateWorkspace,
    openSession: (id) => opened.push(id),
  });

  const second = openSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-two",
    sessionId: "sess-2",
    activateWorkspace,
    openSession: (id) => opened.push(id),
  });

  gate.resolve();
  const firstResult = await first;
  const secondResult = await second;

  assert.equal(firstResult, false);
  assert.equal(secondResult, true);
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(activationEvents, ["start:ws-two", "end:ws-two"]);
  assert.deepEqual(opened, ["sess-2"]);
});

test("does not create session when cross-workspace activation fails", async () => {
  const activated: string[] = [];
  const created: string[] = [];

  const result = await createSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-other",
    activateWorkspace: async (id) => {
      activated.push(id);
      return false;
    },
    createSession: async () => {
      created.push("created");
      return "sess-created";
    },
  });

  assert.equal(result, false);
  assert.deepEqual(activated, ["ws-other"]);
  assert.deepEqual(created, []);
});

test("creates session after successful cross-workspace activation", async () => {
  const activated: string[] = [];
  const created: string[] = [];

  const result = await createSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-other",
    activateWorkspace: async (id) => {
      activated.push(id);
      return true;
    },
    createSession: async () => {
      created.push("created");
      return "sess-created";
    },
  });

  assert.equal(result, true);
  assert.deepEqual(activated, ["ws-other"]);
  assert.deepEqual(created, ["created"]);
});
