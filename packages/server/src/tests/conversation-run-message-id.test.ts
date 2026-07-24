import { describe, expect, test } from "bun:test";

import { createConversationRunOpenCodeMessageId } from "../conversation-run-message-id.js";

const MASK_48 = 0xffffffffffffn;

const opencodeAscendingId = (timestamp: number, counter: number, suffix: string) => {
  const encoded = (BigInt(timestamp) * 0x1000n + BigInt(counter)) & MASK_48;
  return `msg_${encoded.toString(16).padStart(12, "0")}${suffix}`;
};

describe("OpenCode conversation-run message ids", () => {
  test("sort between the preceding turn and OpenCode's next assistant id", () => {
    const timestamp = 1_784_901_699_705;
    const userId = createConversationRunOpenCodeMessageId({
      workspaceId: "ws-a",
      engineSessionId: "ses-a",
      clientMessageId: "client-a",
      runId: "run-a",
      timestamp,
    });
    const previousAssistantId = opencodeAscendingId(timestamp - 1, 1, "AAAAAAAAAAAAAA");
    const nextAssistantId = opencodeAscendingId(timestamp, 1, "AAAAAAAAAAAAAA");

    expect(userId).toMatch(/^msg_[0-9a-f]{26}$/);
    expect(previousAssistantId < userId).toBe(true);
    expect(userId < nextAssistantId).toBe(true);
  });

  test("is stable for one admitted run and distinct across run ids", () => {
    const input = {
      workspaceId: "ws-a",
      engineSessionId: "ses-a",
      clientMessageId: "client-a",
      timestamp: 1_784_901_699_705,
    };
    const first = createConversationRunOpenCodeMessageId({ ...input, runId: "run-a" });
    const replay = createConversationRunOpenCodeMessageId({ ...input, runId: "run-a" });
    const next = createConversationRunOpenCodeMessageId({ ...input, runId: "run-b" });

    expect(replay).toBe(first);
    expect(next).not.toBe(first);
  });
});
