import assert from "node:assert/strict";
import test from "node:test";

import {
  applyVesloServerStatusProbe,
  createInitialVesloServerStatusStabilityState,
} from "../../lib/veslo-server/status-stability.js";

test("Veslo status stability keeps a recent connected state through transient failures", () => {
  const initial = createInitialVesloServerStatusStabilityState();
  const connected = applyVesloServerStatusProbe(
    initial,
    { status: "connected", capabilities: { mcp: { read: true, write: true } } as any },
    { nowMs: 1000, previousDelayMs: 1000 },
  );

  const firstFailure = applyVesloServerStatusProbe(
    connected.state,
    { status: "disconnected", capabilities: null },
    { nowMs: 2000, previousDelayMs: connected.nextDelayMs },
  );
  const secondFailure = applyVesloServerStatusProbe(
    firstFailure.state,
    { status: "disconnected", capabilities: null },
    { nowMs: 3000, previousDelayMs: firstFailure.nextDelayMs },
  );

  assert.equal(firstFailure.visibleStatus, "connected");
  assert.equal(firstFailure.transientFailure, true);
  assert.equal(firstFailure.nextDelayMs, 10_000);
  assert.equal(secondFailure.visibleStatus, "connected");
  assert.equal(secondFailure.transientFailure, true);
});

test("Veslo status stability disconnects after repeated failures and backs off", () => {
  const initial = createInitialVesloServerStatusStabilityState();
  const connected = applyVesloServerStatusProbe(
    initial,
    { status: "limited", capabilities: null },
    { nowMs: 1000, previousDelayMs: 1000 },
  );
  const firstFailure = applyVesloServerStatusProbe(
    connected.state,
    { status: "disconnected", capabilities: null },
    { nowMs: 2000, previousDelayMs: connected.nextDelayMs },
  );
  const secondFailure = applyVesloServerStatusProbe(
    firstFailure.state,
    { status: "disconnected", capabilities: null },
    { nowMs: 3000, previousDelayMs: firstFailure.nextDelayMs },
  );
  const thirdFailure = applyVesloServerStatusProbe(
    secondFailure.state,
    { status: "disconnected", capabilities: null },
    { nowMs: 4000, previousDelayMs: secondFailure.nextDelayMs },
  );

  assert.equal(thirdFailure.visibleStatus, "disconnected");
  assert.equal(thirdFailure.transientFailure, false);
  assert.equal(thirdFailure.nextDelayMs, 20_000);
});

test("Veslo status stability keeps cold-start retry cadence before any success", () => {
  const initial = createInitialVesloServerStatusStabilityState();
  const failure = applyVesloServerStatusProbe(
    initial,
    { status: "disconnected", capabilities: null },
    { nowMs: 1000, previousDelayMs: 1000 },
  );

  assert.equal(failure.visibleStatus, "disconnected");
  assert.equal(failure.nextDelayMs, 5000);
});

test("Veslo status stability surfaces auth desync without transient grace", () => {
  const initial = createInitialVesloServerStatusStabilityState();
  const connected = applyVesloServerStatusProbe(
    initial,
    { status: "connected", capabilities: { mcp: { read: true, write: true } } as any },
    { nowMs: 1000, previousDelayMs: 1000 },
  );
  const authFailure = applyVesloServerStatusProbe(
    connected.state,
    { status: "auth_desync", capabilities: null },
    { nowMs: 2000, previousDelayMs: connected.nextDelayMs },
  );

  assert.equal(authFailure.visibleStatus, "auth_desync");
  assert.equal(authFailure.transientFailure, false);
  assert.equal(authFailure.nextDelayMs, 10_000);
});
