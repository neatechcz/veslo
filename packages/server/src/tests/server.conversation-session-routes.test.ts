import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerConversationSessionRoutes } from "../routes/conversations.js";

describe("Conversation and session routes", () => {
  test("registers the conversation runtime contract", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerConversationSessionRoutes>[1];

    registerConversationSessionRoutes(routes, dependencies);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["DELETE", "/workspace/demo/sessions/session-1", "client"],
      ["GET", "/workspace/demo/conversations", "client"],
      ["POST", "/workspace/demo/conversations", "client"],
      ["POST", "/workspace/demo/conversations/submit", "client"],
      ["POST", "/workspace/demo/conversations/import", "client"],
      ["GET", "/workspace/demo/conversations/conv-1/transcript", "client"],
      ["POST", "/workspace/demo/conversations/conv-1/runs", "client"],
      ["GET", "/workspace/demo/conversations/conv-1/queue", "client"],
      ["GET", "/workspace/demo/conversations/conv-1/queue/queue-1", "client"],
      ["POST", "/workspace/demo/conversations/conv-1/abort", "client"],
      ["GET", "/workspace/demo/conversations/conv-1/runs/run-1", "client"],
      ["POST", "/workspace/demo/sessions/transcript-prefetch", "client"],
      ["POST", "/workspace/demo/sessions/session-1/transcript", "client"],
      ["GET", "/workspace/demo/sessions/session-1/transcript", "client"],
      ["GET", "/workspace/demo/sessions/session-1/artifacts/latest-run", "client"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [index, [method, path, auth]] of expectedRoutes.entries()) {
      const route = matchRoute([routes[index]!], method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
    }

    expect(matchRoute(routes, "GET", "/workspace/demo/conversation")).toBeNull();
  });
});
