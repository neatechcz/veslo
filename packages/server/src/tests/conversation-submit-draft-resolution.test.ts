import { describe, expect, test } from "bun:test";

import {
  resolveConversationSubmitDraft,
} from "../conversation-submit-draft-resolution.js";
import type { ConversationSubmitRequest } from "../conversation-submit-contract.js";

const request = (
  draft: ConversationSubmitRequest["draft"],
): ConversationSubmitRequest => ({
  clientMessageId: "msg_1",
  origin: "session:normal",
  draft,
});

describe("conversation submit draft resolution", () => {
  test("resolves shell drafts into shell run input", async () => {
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "shell",
        text: "npm test",
        resolvedText: " npm run test:unit ",
        parts: [{ type: "text", text: "npm test" }],
      }),
    });

    expect(result).toMatchObject({
      status: "ok",
      resolvedRunInput: {
        kind: "shell",
        command: "npm run test:unit",
      },
    });
  });

  test("resolves explicit command drafts into command run input", async () => {
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "prompt",
        text: "/deploy prod",
        parts: [{ type: "text", text: "/deploy prod" }],
        command: { name: "deploy", arguments: "prod" },
      }),
    });

    expect(result).toMatchObject({
      status: "ok",
      resolvedRunInput: {
        kind: "command",
        command: "deploy",
        arguments: "prod",
      },
    });
  });

  test("parses slash command text when the frontend command hint is missing", async () => {
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "prompt",
        text: " /review   src/app.ts ",
        parts: [{ type: "text", text: "/review src/app.ts" }],
      }),
    });

    expect(result).toMatchObject({
      status: "ok",
      resolvedRunInput: {
        kind: "command",
        command: "review",
        arguments: "src/app.ts",
      },
    });
  });

  test("resolves implicit skill prompts into command run input", async () => {
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "prompt",
        text: "use company research skill for this site",
        parts: [{ type: "text", text: "use company research skill for this site" }],
      }),
      resolveSkillCommand: async ({ text }) => {
        expect(text).toBe("use company research skill for this site");
        return "company-research-czech";
      },
    });

    expect(result).toMatchObject({
      status: "ok",
      resolvedRunInput: {
        kind: "command",
        command: "company-research-czech",
        arguments: "use company research skill for this site",
      },
    });
  });
});
