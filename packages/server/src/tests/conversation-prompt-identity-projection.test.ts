import { describe, expect, test } from "bun:test";

import { projectConversationPromptIdentities } from "../conversation-prompt-identity-projection.js";

const message = (id: string, role: string) => ({
  info: { id, role, sessionID: "ses_1" },
  parts: [],
});

describe("conversation prompt identity projection", () => {
  test("annotates only the scoped user row with one unique exact mapping", () => {
    const user = message("opencode-user", "user");
    const missing = message("opencode-missing", "user");
    const crossScope = message("opencode-cross-scope", "user");

    const projected = projectConversationPromptIdentities(
      [user, missing, crossScope],
      [{ opencodeMessageId: "opencode-user", clientMessageId: "client-user" }],
    ) as Array<{ info: Record<string, unknown> }>;

    expect(projected[0]?.info.clientMessageId).toBe("client-user");
    expect(projected[1]?.info).not.toHaveProperty("clientMessageId");
    expect(projected[2]?.info).not.toHaveProperty("clientMessageId");
    expect(user.info).not.toHaveProperty("clientMessageId");
  });

  test("fails closed for duplicate or conflicting mappings and non-user rows", () => {
    const duplicate = message("opencode-duplicate", "user");
    const conflicting = message("opencode-conflicting", "user");
    const assistant = message("opencode-assistant", "assistant");
    const tool = message("opencode-tool", "tool");

    const projected = projectConversationPromptIdentities(
      [duplicate, conflicting, assistant, tool],
      [
        { opencodeMessageId: "opencode-duplicate", clientMessageId: "client-duplicate" },
        { opencodeMessageId: "opencode-duplicate", clientMessageId: "client-duplicate" },
        { opencodeMessageId: "opencode-conflicting", clientMessageId: "client-a" },
        { opencodeMessageId: "opencode-conflicting", clientMessageId: "client-b" },
        { opencodeMessageId: "opencode-assistant", clientMessageId: "client-assistant" },
        { opencodeMessageId: "opencode-tool", clientMessageId: "client-tool" },
      ],
    ) as Array<{ info: Record<string, unknown> }>;

    for (const row of projected) {
      expect(row.info).not.toHaveProperty("clientMessageId");
    }
  });
});
