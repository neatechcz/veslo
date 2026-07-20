import assert from "node:assert/strict";
import test from "node:test";

import type { MessageWithParts, SessionErrorTurn } from "../../types";
import { createVisibleMessageProjection } from "../../context/session-visible-messages.js";

const message = (id: string): MessageWithParts => ({
  info: { id } as MessageWithParts["info"],
  parts: [],
});

const error = (id: string, afterMessageID: string | null = null): SessionErrorTurn => ({
  id,
  text: "The run failed",
  afterMessageID,
  time: 10,
});

test("visible projection is a no-op for unchanged canonical messages", () => {
  const project = createVisibleMessageProjection((sessionID, turn) => ({
    info: { id: turn.id, sessionID } as MessageWithParts["info"],
    parts: [],
  }));
  const source = [message("m1"), message("m2")];
  const first = project({ source, sessionID: "session-a", errorTurns: [], revertMessageID: null });
  const replay = project({ source, sessionID: "session-a", errorTurns: [], revertMessageID: null });

  assert.equal(first, source);
  assert.equal(replay, first);
});

test("synthetic error turns retain their wrapper until their stable content changes", () => {
  let syntheticCreations = 0;
  const project = createVisibleMessageProjection((sessionID, turn) => {
    syntheticCreations += 1;
    return {
      info: { id: turn.id, sessionID } as MessageWithParts["info"],
      parts: [],
    };
  });
  const source = [message("m1")];
  const first = project({ source, sessionID: "session-a", errorTurns: [error("error-1", "m1")], revertMessageID: null });
  const replay = project({ source, sessionID: "session-a", errorTurns: [{ ...error("error-1", "m1") }], revertMessageID: null });

  assert.equal(syntheticCreations, 1);
  assert.equal(replay, first);
  assert.equal(replay[1], first[1]);

  const changed = project({
    source,
    sessionID: "session-a",
    errorTurns: [{ ...error("error-1", "m1"), text: "A different failure" }],
    revertMessageID: null,
  });
  assert.equal(syntheticCreations, 2);
  assert.notEqual(changed, replay);
  assert.notEqual(changed[1], replay[1]);
});
