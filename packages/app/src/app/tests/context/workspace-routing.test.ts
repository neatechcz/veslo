import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "solid-js";

import { createWorkspaceRouting, WorkspaceClientStaleError } from "../../context/workspace-routing.js";

const makeClient = (id: string, calls: string[] = []) => ({
  id,
  session: {
    async messages() {
      calls.push(id);
      return [];
    },
  },
}) as any;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function tick(count = 1) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function createTestRouting() {
  const fallbackClient = { marker: "fallback", health: () => "fallback" };
  let activeWorkspaceId = "";
  const routing = createWorkspaceRouting({
    clientSource: () => fallbackClient as any,
    activeWorkspaceId: () => activeWorkspaceId,
    createClient: (baseUrl) => ({ marker: baseUrl, health: () => baseUrl } as any),
    waitForHealthy: async () => ({ healthy: true }),
  });
  return {
    routing,
    setActiveWorkspaceId: (id: string) => {
      activeWorkspaceId = id;
    },
  };
}

test("workspace routing does not fall back to a stale global client when active workspace has no route", async () => {
  await createRoot(async (dispose) => {
    try {
      const { routing, setActiveWorkspaceId } = createTestRouting();

      setActiveWorkspaceId("ws-old");
      await routing.ensure("ws-old", "old-base-url");
      assert.equal((routing.active() as any)?.marker, "old-base-url");

      setActiveWorkspaceId("ws-new");

      assert.equal(routing.active(), null);
      assert.equal(routing.client(), null);
      assert.equal(routing.client("ws-new"), null);
    } finally {
      dispose();
    }
  });
});

test("workspace routing keeps fallback client only for pre-workspace bootstrap", () => {
  createRoot((dispose) => {
    try {
      const { routing } = createTestRouting();
      assert.equal((routing.active() as any)?.marker, "fallback");
      assert.equal((routing.client() as any)?.marker, "fallback");
    } finally {
      dispose();
    }
  });
});

test("explicit workspace client lookup does not fall back to the active client", () => {
  createRoot((dispose) => {
    try {
      const fallbackClient = makeClient("active-fallback");
      const routing = createWorkspaceRouting({
        clientSource: () => fallbackClient,
        activeWorkspaceId: () => "ws-active",
        createClient: () => makeClient("created"),
        waitForHealthy: async () => ({ healthy: true }),
      });

      assert.equal(routing.client(), null);
      assert.equal(routing.client("ws-missing"), null);
    } finally {
      dispose();
    }
  });
});

test("workspace routing release invalidates pending ensure before it can republish a stale route", async () => {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      void (async () => {
        const healthGates: Array<ReturnType<typeof deferred<{ healthy: boolean }>>> = [];
        let createCalls = 0;
        try {
          const routing = createWorkspaceRouting({
            clientSource: () => null,
            activeWorkspaceId: () => "ws-active",
            createClient: () => {
              createCalls += 1;
              return makeClient(`client-${createCalls}`);
            },
            waitForHealthy: async () => {
              const gate = deferred<{ healthy: boolean }>();
              healthGates.push(gate);
              return await gate.promise;
            },
          });

          const first = routing.ensure("ws-active", "http://engine", { directory: "/workspace" });
          await tick();
          assert.equal(healthGates.length, 1);

          routing.release("ws-active");
          const second = routing.ensure("ws-active", "http://engine", { directory: "/workspace" });
          await tick();

          assert.equal(createCalls, 2, "new ensure after release must not join the released pending ensure");
          assert.equal(healthGates.length, 2);

          healthGates[0]?.resolve({ healthy: true });
          assert.equal(await first, null);
          assert.equal(routing.entry("ws-active"), null);

          healthGates[1]?.resolve({ healthy: true });
          const secondEntry = await second;
          assert.equal((secondEntry?.client as any)?.id, "client-2");
          assert.equal((routing.entry("ws-active")?.client as any)?.id, "client-2");
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          dispose();
        }
      })();
    });
  });
});

test("explicit workspace client lookup can call a non-active workspace client", async () => {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      void (async () => {
        const calls: string[] = [];
        try {
          const routing = createWorkspaceRouting({
            clientSource: () => null,
            activeWorkspaceId: () => "ws-active",
            createClient: (_baseUrl, directory) => makeClient(directory ?? "missing", calls),
            waitForHealthy: async () => ({ healthy: true }),
          });

          await routing.ensure("ws-active", "http://active", { directory: "active-client" });
          await routing.ensure("ws-background", "http://background", { directory: "background-client" });

          const background = routing.client("ws-background");
          assert.ok(background);
          await (background as any).session.messages();

          assert.deepEqual(calls, ["background-client"]);
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          dispose();
        }
      })();
    });
  });
});

test("workspace routing can skip eager health checks for quiet workspace proxy refreshes", async () => {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      void (async () => {
        let healthChecks = 0;
        try {
          const routing = createWorkspaceRouting({
            clientSource: () => null,
            activeWorkspaceId: () => "ws-active",
            createClient: (_baseUrl, directory) => makeClient(directory ?? "missing"),
            waitForHealthy: async () => {
              healthChecks += 1;
              throw new Error("engine not running");
            },
          });

          const skipped = await routing.ensure("ws-active", "http://active", {
            directory: "active-client",
            skipHealth: true,
          });
          assert.ok(skipped);
          assert.equal(healthChecks, 0);

          const checked = await routing.ensure("ws-other", "http://other", {
            directory: "other-client",
          });
          assert.equal(checked, null);
          assert.equal(healthChecks, 1);
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          dispose();
        }
      })();
    });
  });
});

test("implicit active client lookup still rejects calls after an active workspace switch", async () => {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      void (async () => {
        let activeWorkspaceId = "ws-active";
        try {
          const routing = createWorkspaceRouting({
            clientSource: () => null,
            activeWorkspaceId: () => activeWorkspaceId,
            createClient: (_baseUrl, directory) => makeClient(directory ?? "missing"),
            waitForHealthy: async () => ({ healthy: true }),
          });

          await routing.ensure("ws-active", "http://active", { directory: "active-client" });

          const active = routing.client();
          assert.ok(active);
          activeWorkspaceId = "ws-other";

          assert.throws(() => (active as any).session.messages(), WorkspaceClientStaleError);
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          dispose();
        }
      })();
    });
  });
});

test("workspace routing preserves auth for runtime SSE callers", async () => {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      void (async () => {
        try {
          const routing = createWorkspaceRouting({
            clientSource: () => null,
            activeWorkspaceId: () => "ws-active",
            createClient: (_baseUrl, _directory, auth) => ({ auth } as any),
            waitForHealthy: async () => ({ healthy: true }),
          });

          const auth = { username: "opencode", password: "secret" };
          const entry = await routing.ensure("ws-active", "http://engine", {
            directory: "/workspace",
            auth,
          });

          assert.deepEqual(entry?.auth, auth);
          assert.notEqual(entry?.auth, auth);
          assert.deepEqual(routing.entry("ws-active")?.auth, auth);
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          dispose();
        }
      })();
    });
  });
});

test("workspace routing refreshes cached clients when auth changes", async () => {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      void (async () => {
        let createCalls = 0;
        try {
          const routing = createWorkspaceRouting({
            clientSource: () => null,
            activeWorkspaceId: () => "ws-active",
            createClient: (_baseUrl, _directory, auth) => {
              createCalls += 1;
              return { password: auth?.password ?? "" } as any;
            },
            waitForHealthy: async () => ({ healthy: true }),
          });

          await routing.ensure("ws-active", "http://engine", {
            auth: { username: "opencode", password: "one" },
          });
          await routing.ensure("ws-active", "http://engine", {
            auth: { username: "opencode", password: "one" },
          });
          assert.equal(createCalls, 1);

          const refreshed = await routing.ensure("ws-active", "http://engine", {
            auth: { username: "opencode", password: "two" },
          });
          assert.equal(createCalls, 2);
          assert.equal((refreshed?.client as any)?.password, "two");
          assert.equal(refreshed?.auth?.password, "two");
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          dispose();
        }
      })();
    });
  });
});
