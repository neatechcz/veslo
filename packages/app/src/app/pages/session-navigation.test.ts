import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionFromDirectorySelection,
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

  assert.equal(result, "opened");
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

  assert.equal(result, "blocked");
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

  assert.equal(result, "opened");
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

  assert.equal(firstResult, "superseded");
  assert.equal(secondResult, "opened");
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

test("picker-driven directory session flow cancels cleanly when no folder is selected", async () => {
  const ensured: string[] = [];
  const activated: string[] = [];
  const created: string[] = [];

  const result = await createSessionFromDirectorySelection({
    activeWorkspaceId: "ws-active",
    pickDirectory: async () => null,
    ensureWorkspaceForFolder: async (folder) => {
      ensured.push(folder);
      return { id: "ws-folder" };
    },
    activateWorkspace: async (id) => {
      activated.push(id);
      return true;
    },
    createSession: async () => {
      created.push("created");
      return "sess-created";
    },
  });

  assert.equal(result, "cancelled");
  assert.deepEqual(ensured, []);
  assert.deepEqual(activated, []);
  assert.deepEqual(created, []);
});

test("picker-driven directory session flow reuses the ensured workspace and creates a session", async () => {
  const ensured: string[] = [];
  const activated: string[] = [];
  const created: string[] = [];
  let currentActive = "ws-active";

  const result = await createSessionFromDirectorySelection({
    activeWorkspaceId: currentActive,
    getActiveWorkspaceId: () => currentActive,
    pickDirectory: async () => "/tmp/project-a",
    ensureWorkspaceForFolder: async (folder) => {
      ensured.push(folder);
      return { id: "ws-project", path: folder };
    },
    activateWorkspace: async (id) => {
      activated.push(id);
      currentActive = id;
      return true;
    },
    createSession: async () => {
      created.push("created");
      return "sess-new";
    },
  });

  assert.equal(result, "created");
  assert.deepEqual(ensured, ["/tmp/project-a"]);
  assert.deepEqual(activated, ["ws-project"]);
  assert.deepEqual(created, ["created"]);
});

test("picker-driven directory session flow stops when ensured workspace cannot activate", async () => {
  const ensured: string[] = [];
  const activated: string[] = [];
  const created: string[] = [];

  const result = await createSessionFromDirectorySelection({
    activeWorkspaceId: "ws-active",
    pickDirectory: async () => "/tmp/project-b",
    ensureWorkspaceForFolder: async (folder) => {
      ensured.push(folder);
      return { id: "ws-project-b", path: folder };
    },
    activateWorkspace: async (id) => {
      activated.push(id);
      return false;
    },
    createSession: async () => {
      created.push("created");
      return "sess-should-not-exist";
    },
  });

  assert.equal(result, "blocked");
  assert.deepEqual(ensured, ["/tmp/project-b"]);
  assert.deepEqual(activated, ["ws-project-b"]);
  assert.deepEqual(created, []);
});

test("picker-driven directory session flow forwards the selected path unchanged to workspace resolution", async () => {
  const ensured: string[] = [];

  const result = await createSessionFromDirectorySelection({
    activeWorkspaceId: "ws-active",
    pickDirectory: async () => "  /tmp/project with spaces  ",
    ensureWorkspaceForFolder: async (folder) => {
      ensured.push(folder);
      return null;
    },
    activateWorkspace: async () => true,
    createSession: async () => "sess-should-not-exist",
  });

  assert.equal(result, "blocked");
  assert.deepEqual(ensured, ["  /tmp/project with spaces  "]);
});

// ---------------------------------------------------------------------------
// Rapid back-and-forth switching stress tests
//
// These reproduce the freeze that occurs when users click back and forth
// between sessions/projects several times in quick succession.
// ---------------------------------------------------------------------------

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

test("rapid back-and-forth between two workspaces completes without hanging", async () => {
  const TIMEOUT_MS = 3_000;
  const opened: string[] = [];
  const activations: string[] = [];
  let currentActive = "ws-A";

  const activateWorkspace = async (id: string) => {
    activations.push(id);
    // Simulate real-world activation latency (engine restart, connect, etc.)
    await delay(50);
    currentActive = id;
    return true;
  };

  const clicks: Promise<"opened" | "blocked" | "superseded">[] = [];

  // Simulate 10 rapid back-and-forth clicks between ws-A and ws-B
  for (let i = 0; i < 10; i++) {
    const targetWs = i % 2 === 0 ? "ws-B" : "ws-A";
    const sessionId = `sess-${i}`;
    clicks.push(
      openSessionWithWorkspaceActivation({
        activeWorkspaceId: currentActive,
        getActiveWorkspaceId: () => currentActive,
        workspaceId: targetWs,
        sessionId,
        activateWorkspace,
        openSession: (id) => opened.push(id),
      }),
    );
  }

  // Must settle within the timeout — if it hangs, the test fails
  const results = await Promise.race([
    Promise.all(clicks),
    delay(TIMEOUT_MS).then(() => {
      throw new Error(
        `Rapid back-and-forth switching did not settle within ${TIMEOUT_MS}ms — system froze`,
      );
    }),
  ]);

  // Only the last click should have actually opened a session
  assert.equal(results[results.length - 1], "opened", "last click should succeed");
  assert.ok(opened.length >= 1, "at least one session must be opened");
  assert.equal(opened[opened.length - 1], "sess-9", "the last opened session should be the final click");
});

test("rapid back-and-forth with slow activations does not deadlock", async () => {
  const TIMEOUT_MS = 5_000;
  const opened: string[] = [];
  const activationStarts: string[] = [];
  const activationEnds: string[] = [];
  let currentActive = "ws-A";
  let concurrentActivations = 0;
  let maxConcurrent = 0;

  const activateWorkspace = async (id: string) => {
    concurrentActivations++;
    maxConcurrent = Math.max(maxConcurrent, concurrentActivations);
    activationStarts.push(id);
    // Simulate a slow activation (engine restart, veslo host resolution, etc.)
    await delay(200);
    activationEnds.push(id);
    concurrentActivations--;
    currentActive = id;
    return true;
  };

  const clicks: Promise<"opened" | "blocked" | "superseded">[] = [];

  // 7 rapid back-and-forth clicks (odd count so last click ends on ws-B,
  // which differs from the starting ws-A and requires activation)
  for (let i = 0; i < 7; i++) {
    const targetWs = i % 2 === 0 ? "ws-B" : "ws-A";
    clicks.push(
      openSessionWithWorkspaceActivation({
        activeWorkspaceId: currentActive,
        getActiveWorkspaceId: () => currentActive,
        workspaceId: targetWs,
        sessionId: `sess-${i}`,
        activateWorkspace,
        openSession: (id) => opened.push(id),
      }),
    );
  }

  const results = await Promise.race([
    Promise.all(clicks),
    delay(TIMEOUT_MS).then(() => {
      throw new Error(
        `Slow-activation back-and-forth switching did not settle within ${TIMEOUT_MS}ms — system froze`,
      );
    }),
  ]);

  // Serialization must prevent concurrent activateWorkspace calls
  assert.equal(maxConcurrent, 1, "activateWorkspace must never run concurrently");

  // Only the final (winning) click should trigger activation
  assert.ok(activationStarts.length >= 1, "at least one activation must run");

  // Last click must succeed
  assert.equal(results[results.length - 1], "opened");
  assert.ok(opened.length >= 1);
  assert.equal(opened[opened.length - 1], "sess-6");
});

test("rapid switching among three workspaces (regular + temp folder) settles", async () => {
  const TIMEOUT_MS = 3_000;
  const opened: string[] = [];
  let currentActive = "ws-regular-1";

  const workspaceIds = ["ws-regular-1", "ws-regular-2", "ws-temp-folder"];

  const activateWorkspace = async (id: string) => {
    await delay(30);
    currentActive = id;
    return true;
  };

  const clicks: Promise<"opened" | "blocked" | "superseded">[] = [];

  // 12 rapid clicks cycling through 3 workspaces
  for (let i = 0; i < 12; i++) {
    const targetWs = workspaceIds[i % workspaceIds.length];
    clicks.push(
      openSessionWithWorkspaceActivation({
        activeWorkspaceId: currentActive,
        getActiveWorkspaceId: () => currentActive,
        workspaceId: targetWs,
        sessionId: `sess-${i}`,
        activateWorkspace,
        openSession: (id) => opened.push(id),
      }),
    );
  }

  const results = await Promise.race([
    Promise.all(clicks),
    delay(TIMEOUT_MS).then(() => {
      throw new Error(
        `Three-workspace rapid switching did not settle within ${TIMEOUT_MS}ms — system froze`,
      );
    }),
  ]);

  assert.equal(results[results.length - 1], "opened");
  assert.ok(opened.length >= 1);
  assert.equal(opened[opened.length - 1], "sess-11");
});

test("rapid back-and-forth createSession does not hang", async () => {
  const TIMEOUT_MS = 3_000;
  const created: string[] = [];
  let currentActive = "ws-A";
  let sessionCounter = 0;

  const activateWorkspace = async (id: string) => {
    await delay(40);
    currentActive = id;
    return true;
  };

  const clicks: Promise<boolean>[] = [];

  for (let i = 0; i < 8; i++) {
    const targetWs = i % 2 === 0 ? "ws-B" : "ws-A";
    clicks.push(
      createSessionWithWorkspaceActivation({
        activeWorkspaceId: currentActive,
        getActiveWorkspaceId: () => currentActive,
        workspaceId: targetWs,
        activateWorkspace,
        createSession: async () => {
          const id = `created-${++sessionCounter}`;
          created.push(id);
          return id;
        },
      }),
    );
  }

  const results = await Promise.race([
    Promise.all(clicks),
    delay(TIMEOUT_MS).then(() => {
      throw new Error(
        `Rapid createSession back-and-forth did not settle within ${TIMEOUT_MS}ms — system froze`,
      );
    }),
  ]);

  assert.equal(results[results.length - 1], true);
  assert.ok(created.length >= 1);
});

test("activation failure during rapid switching does not leave queue stuck", async () => {
  const TIMEOUT_MS = 3_000;
  const opened: string[] = [];
  let currentActive = "ws-A";
  let callCount = 0;

  const activateWorkspace = async (id: string) => {
    callCount++;
    await delay(30);
    // Fail every other activation to simulate flaky connections
    if (callCount % 2 === 0) return false;
    currentActive = id;
    return true;
  };

  const clicks: Promise<"opened" | "blocked" | "superseded">[] = [];

  for (let i = 0; i < 8; i++) {
    const targetWs = i % 2 === 0 ? "ws-B" : "ws-A";
    clicks.push(
      openSessionWithWorkspaceActivation({
        activeWorkspaceId: currentActive,
        getActiveWorkspaceId: () => currentActive,
        workspaceId: targetWs,
        sessionId: `sess-${i}`,
        activateWorkspace,
        openSession: (id) => opened.push(id),
      }),
    );
  }

  // Key assertion: even with failures, the queue must drain
  const results = await Promise.race([
    Promise.all(clicks),
    delay(TIMEOUT_MS).then(() => {
      throw new Error(
        `Queue did not drain after activation failures within ${TIMEOUT_MS}ms — system froze`,
      );
    }),
  ]);

  assert.ok(Array.isArray(results), "all promises must settle");
});

test("activation throwing error during rapid switching does not leave queue stuck", async () => {
  const TIMEOUT_MS = 3_000;
  const opened: string[] = [];
  let currentActive = "ws-A";
  let callCount = 0;

  const activateWorkspace = async (id: string) => {
    callCount++;
    await delay(20);
    // Throw on every 3rd activation to simulate crashes
    if (callCount % 3 === 0) throw new Error("Connection lost");
    currentActive = id;
    return true;
  };

  const clicks: Promise<"opened" | "blocked" | "superseded">[] = [];

  for (let i = 0; i < 10; i++) {
    const targetWs = i % 2 === 0 ? "ws-B" : "ws-A";
    clicks.push(
      openSessionWithWorkspaceActivation({
        activeWorkspaceId: currentActive,
        getActiveWorkspaceId: () => currentActive,
        workspaceId: targetWs,
        sessionId: `sess-${i}`,
        activateWorkspace,
        openSession: (id) => opened.push(id),
      }).catch(() => "blocked"),
    );
  }

  // Queue must drain even when activateWorkspace throws
  const results = await Promise.race([
    Promise.all(clicks),
    delay(TIMEOUT_MS).then(() => {
      throw new Error(
        `Queue did not drain after activation errors within ${TIMEOUT_MS}ms — system froze`,
      );
    }),
  ]);

  assert.ok(Array.isArray(results), "all promises must settle");
});
