import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerConversationSessionRoutes } from "../routes/conversations.js";

describe("Conversation and session routes", () => {
  test("registers the conversation runtime contract", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerConversationSessionRoutes>[1];

    registerConversationSessionRoutes(routes, dependencies);

    const expectedRoutes: Array<[string, string]> = [
      ["DELETE", "/workspace/demo/sessions/session-1"],
      ["GET", "/workspace/demo/conversations"],
      ["POST", "/workspace/demo/conversations"],
      ["POST", "/workspace/demo/conversations/import"],
      ["GET", "/workspace/demo/conversations/conv-1/transcript"],
      ["POST", "/workspace/demo/conversations/conv-1/runs"],
      ["POST", "/workspace/demo/conversations/conv-1/abort"],
      ["GET", "/workspace/demo/conversations/conv-1/runs/run-1"],
      ["POST", "/workspace/demo/sessions/transcript-prefetch"],
      ["POST", "/workspace/demo/sessions/session-1/transcript"],
      ["GET", "/workspace/demo/sessions/session-1/transcript"],
      ["GET", "/workspace/demo/sessions/session-1/artifacts/latest-run"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [method, path] of expectedRoutes) {
      expect(matchRoute(routes, method, path)).not.toBeNull();
    }

    expect(matchRoute(routes, "GET", "/workspace/demo/conversation")).toBeNull();
  });
});
