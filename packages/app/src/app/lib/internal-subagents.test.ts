import { test } from "node:test";
import assert from "node:assert/strict";
import type { Part } from "@opencode-ai/sdk/v2/client";

import {
  getTaskPartSubagentInfo,
  isVesloInternalSubagentType,
  sessionLooksLikeInternalSubagent,
} from "./internal-subagents";

test("isVesloInternalSubagentType detects internal prefixes", () => {
  assert.equal(isVesloInternalSubagentType("veslo-internal-docx"), true);
  assert.equal(isVesloInternalSubagentType(" Veslo-Internal-PDF "), true);
  assert.equal(isVesloInternalSubagentType("docx"), false);
});

test("getTaskPartSubagentInfo extracts internal child session ids", () => {
  const part = {
    type: "tool",
    id: "part-1",
    sessionID: "parent",
    messageID: "msg-1",
    tool: "task",
    state: {
      input: {
        subagent_type: "veslo-internal-pptx",
      },
      metadata: {
        sessionId: "child-1",
      },
    },
  } as unknown as Part;

  const info = getTaskPartSubagentInfo(part);
  assert.equal(info.isTask, true);
  assert.equal(info.internal, true);
  assert.equal(info.subagentType, "veslo-internal-pptx");
  assert.equal(info.sessionId, "child-1");
});

test("sessionLooksLikeInternalSubagent checks agent metadata", () => {
  assert.equal(
    sessionLooksLikeInternalSubagent({ id: "a", agent: "veslo-internal-xlsx" } as any),
    true,
  );
  assert.equal(
    sessionLooksLikeInternalSubagent({ id: "b", metadata: { subagent_type: "veslo-internal-pdf" } } as any),
    true,
  );
  assert.equal(sessionLooksLikeInternalSubagent({ id: "c", agent: "veslo" } as any), false);
});
