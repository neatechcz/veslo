import { describe, expect, test } from "bun:test";

import {
  E2eEventStreamGate,
  E2eEventStreamGateError,
  type E2eEventStreamOwner,
} from "../e2e-event-stream-gate.js";

const owner = (workspaceId = "ws-a"): E2eEventStreamOwner => ({
  workspaceId,
  engineOwnerId: "owner-a",
  directoryInstanceEpoch: 3,
  enginePid: 1234,
  engineStartedAt: 100,
});

describe("E2eEventStreamGate", () => {
  test("auto-releases an abandoned gate so a dead scenario cannot wedge the workspace", async () => {
    const traces: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const ids = ["connection-a", "gate-a"];
    let scheduled: (() => void) | null = null;
    let cleared = 0;
    const gate = new E2eEventStreamGate({
      now: () => 200,
      createId: () => ids.shift()!,
      trace: (event, payload) => traces.push({ event, payload }),
      autoReleaseMs: 5_000,
      setTimeout: (callback) => {
        scheduled = callback;
        return "timer";
      },
      clearTimeout: () => {
        cleared += 1;
      },
    });

    gate.registerActiveConnection({ ...owner(), disconnect: () => {} });
    const armed = gate.arm("ws-a");
    const blocked = gate.waitIfArmed(owner());

    // The scenario dies here: nobody ever calls release.
    expect(scheduled).not.toBeNull();
    scheduled!();

    // The waiter must be able to tell an expired gate from a deliberate one.
    await expect(blocked).resolves.toMatchObject({ kind: "released", releaseKind: "auto" });
    expect(gate.status("ws-a").armed).toBeNull();
    const autoReleased = traces.find((entry) => entry.event.endsWith(":auto-released"));
    expect(autoReleased?.payload).toMatchObject({
      gateId: armed.gateId,
      autoReleasedAfterMs: 5_000,
    });
    // An auto-released gate must not also consume a clear on a later release.
    expect(cleared).toBe(0);
  });

  test("an exact release cancels the auto-release timer", async () => {
    const ids = ["connection-a", "gate-a"];
    let cleared = 0;
    const gate = new E2eEventStreamGate({
      now: () => 200,
      createId: () => ids.shift()!,
      setTimeout: () => "timer",
      clearTimeout: () => {
        cleared += 1;
      },
    });

    gate.registerActiveConnection({ ...owner(), disconnect: () => {} });
    const armed = gate.arm("ws-a");
    gate.release("ws-a", armed.gateId);

    expect(cleared).toBe(1);
  });

  test("disconnects one active stream, blocks reconnect, and self-clears on exact release", async () => {
    const traces: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const ids = ["connection-a", "gate-a", "connection-b"];
    let disconnects = 0;
    const gate = new E2eEventStreamGate({
      now: () => 200,
      createId: () => ids.shift()!,
      trace: (event, payload) => traces.push({ event, payload }),
    });

    gate.registerActiveConnection({
      ...owner(),
      disconnect: () => { disconnects += 1; },
    });
    const armed = gate.arm("ws-a");
    expect(armed).toMatchObject({ gateId: "gate-a", connectionId: "connection-a" });
    expect(disconnects).toBe(1);

    let released = false;
    const waiter = gate.waitIfArmed(owner()).then((result) => {
      released = true;
      return result;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(gate.status("ws-a").armed?.blockedReconnectAttempts).toBe(1);

    const release = gate.release("ws-a", "gate-a");
    expect(release.releasedAt).toBe(200);
    const waitResult = await waiter;
    expect(waitResult).toMatchObject({ kind: "released", ownerMatched: true, releaseKind: "explicit" });
    expect(gate.status("ws-a").armed).toBeNull();

    gate.registerActiveConnection({
      ...owner(),
      releasedGateId: "gate-a",
      disconnect: () => {},
    });
    expect(traces.map((entry) => entry.event)).toEqual([
      "orchestrator:e2e-event-stream-gate:armed",
      "orchestrator:e2e-event-stream-gate:active-disconnected",
      "orchestrator:e2e-event-stream-gate:reconnect-blocked",
      "orchestrator:e2e-event-stream-gate:released",
      "orchestrator:e2e-event-stream-gate:connection-resumed",
    ]);
  });

  test("fails closed for missing, ambiguous, and mismatched ownership", () => {
    const gate = new E2eEventStreamGate({ createId: (() => {
      let id = 0;
      return () => `id-${++id}`;
    })() });
    expect(() => gate.arm("ws-a")).toThrow(E2eEventStreamGateError);

    gate.registerActiveConnection({ ...owner(), disconnect: () => {} });
    gate.registerActiveConnection({ ...owner(), disconnect: () => {} });
    expect(() => gate.arm("ws-a")).toThrow(/2 active app-facing event streams/);
  });

  test("requires the exact gate id and reports an engine owner change", async () => {
    const gate = new E2eEventStreamGate({
      createId: (() => {
        const ids = ["connection-a", "gate-a"];
        return () => ids.shift()!;
      })(),
    });
    gate.registerActiveConnection({ ...owner(), disconnect: () => {} });
    gate.arm("ws-a");
    expect(() => gate.release("ws-a", "wrong")).toThrow(/did not match/);

    const wait = gate.waitIfArmed({ ...owner(), engineOwnerId: "owner-b" });
    gate.release("ws-a", "gate-a");
    expect(await wait).toMatchObject({ kind: "released", ownerMatched: false });
  });
});
