import assert from "node:assert/strict";
import test from "node:test";

import {
  getVesloRequestBrokerSnapshot,
  isLocalVesloTransportError,
  resetVesloRequestBrokerForTests,
  runVesloJsonRequestWithBroker,
} from "../../lib/veslo-server/request-broker.js";

test("Veslo request broker single-flights identical in-flight GETs", async () => {
  resetVesloRequestBrokerForTests();
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const run = () =>
    runVesloJsonRequestWithBroker({
      method: "GET",
      url: "http://127.0.0.1:8787/health",
      headers: { Authorization: "Bearer token-a" },
      timeoutMs: 3000,
      shareable: true,
      run: async () => {
        calls += 1;
        await gate;
        return { ok: true, calls };
      },
    });

  const first = run();
  const second = run();
  assert.equal(calls, 1);

  release?.();
  assert.deepEqual(await first, { ok: true, calls: 1 });
  assert.deepEqual(await second, { ok: true, calls: 1 });

  const snapshot = getVesloRequestBrokerSnapshot();
  assert.equal(snapshot.started, 1);
  assert.equal(snapshot.completed, 1);
  assert.equal(snapshot.failed, 0);
  assert.equal(snapshot.coalesced, 1);
  assert.equal(snapshot.inFlight, 0);
});

test("Veslo request broker keeps coalesced JSON results isolated per caller", async () => {
  resetVesloRequestBrokerForTests();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const run = () =>
    runVesloJsonRequestWithBroker<{ nested: { count: number } }>({
      method: "GET",
      url: "http://127.0.0.1:8787/workspace/ws-a/config",
      shareable: true,
      run: async () => {
        await gate;
        return { nested: { count: 1 } };
      },
    });

  const firstPromise = run();
  const secondPromise = run();
  release?.();

  const first = await firstPromise;
  const second = await secondPromise;

  assert.notEqual(first, second);
  assert.notEqual(first.nested, second.nested);
  first.nested.count = 10;
  assert.equal(second.nested.count, 1);
});

test("Veslo request broker separates auth contexts and non-GET requests", async () => {
  resetVesloRequestBrokerForTests();
  let calls = 0;
  const execute = async () => {
    calls += 1;
    return calls;
  };

  const [first, second] = await Promise.all([
    runVesloJsonRequestWithBroker({
      method: "GET",
      url: "http://127.0.0.1:8787/health",
      headers: { Authorization: "Bearer token-a" },
      shareable: true,
      run: execute,
    }),
    runVesloJsonRequestWithBroker({
      method: "GET",
      url: "http://127.0.0.1:8787/health",
      headers: { Authorization: "Bearer token-b" },
      shareable: true,
      run: execute,
    }),
  ]);

  assert.deepEqual([first, second], [1, 2]);

  await Promise.all([
    runVesloJsonRequestWithBroker({
      method: "POST",
      url: "http://127.0.0.1:8787/workspaces/local",
      shareable: false,
      run: execute,
    }),
    runVesloJsonRequestWithBroker({
      method: "POST",
      url: "http://127.0.0.1:8787/workspaces/local",
      shareable: false,
      run: execute,
    }),
  ]);

  const snapshot = getVesloRequestBrokerSnapshot();
  assert.equal(calls, 4);
  assert.equal(snapshot.started, 4);
  assert.equal(snapshot.coalesced, 0);
});

test("Veslo transport error classifier catches local socket failures only", () => {
  assert.equal(
    isLocalVesloTransportError(
      new Error("error sending request for url (http://127.0.0.1:8787/workspace/ws-a/config)"),
    ),
    true,
  );
  assert.equal(
    isLocalVesloTransportError(
      new Error("Only one usage of each socket address (protocol/network address/port) is normally permitted"),
    ),
    true,
  );
  assert.equal(isLocalVesloTransportError(new Error("Workspace is not authorized")), false);
});
