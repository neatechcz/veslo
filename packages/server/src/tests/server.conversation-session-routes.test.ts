import { describe, expect, test } from "bun:test";
import { matchRoute, type RequestContext, type Route } from "../routing.js";
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
      ["GET", "/workspace/demo/conversations/conv-1/runs/run-1/delivery", "client"],
      ["POST", "/workspace/demo/conversations/conv-1/runs/run-1/delivery/app-report", "client"],
      ["GET", "/workspace/demo/conversations/conv-1/queue", "client"],
      ["GET", "/workspace/demo/conversations/conv-1/queue/queue-1", "client"],
      ["POST", "/workspace/demo/conversations/conv-1/abort", "client"],
      ["POST", "/workspace/demo/conversations/conv-1/runs/run-1/retry-terminal-handoff", "client"],
      ["GET", "/workspace/demo/conversations/conv-1/runs/run-1", "client"],
      ["POST", "/workspace/demo/sessions/transcript-prefetch", "client"],
      ["POST", "/workspace/demo/sessions/session-1/transcript", "client"],
      ["POST", "/workspace/demo/sessions/session-1/transcript/recover", "client"],
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

  test("transcript recovery validates an expected run by exact id even after a successor becomes latest", async () => {
    const routes: Route[] = [];
    const lifecycleReads: string[] = [];
    const ingestRuns: Array<string | null | undefined> = [];
    const workspaceRoot = process.cwd();
    const dependencies = {
      conversationService: {
        resolveOpenCodeSessionForRead: async () => ({
          workspaceId: "demo",
          conversationId: "conv-a",
          engine: "opencode",
          engineSessionId: "ses-a",
          directory: workspaceRoot,
          branchId: null,
          parentConversationId: null,
          parentEngineSessionId: null,
          title: "Conversation",
          createdAt: 1,
          updatedAt: 1,
          firstSeenAt: 1,
          lastSeenAt: 1,
        }),
      },
      lifecycleClient: {
        status: async (_workspaceId: string, _conversationId: string, runId: string) => {
          lifecycleReads.push(runId);
          if (runId === "latest") {
            throw new Error("recovery must not validate against the successor run");
          }
          return { runId, status: "completed", stale: false };
        },
      },
      resolveConversationReadDirectory: async () => workspaceRoot,
      transcriptIngestCoordinator: {
        request: async (input: { runId?: string | null }) => {
          ingestRuns.push(input.runId);
          return { kind: "persisted" as const, generation: 1 };
        },
      },
    } as unknown as Parameters<typeof registerConversationSessionRoutes>[1];
    registerConversationSessionRoutes(routes, dependencies);

    const route = matchRoute(routes, "POST", "/workspace/demo/sessions/ses-a/transcript/recover");
    const request = new Request("http://127.0.0.1/workspace/demo/sessions/ses-a/transcript/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory: workspaceRoot, expectedRunId: "run-old" }),
    });
    const response = await route!.handler({
      request,
      url: new URL(request.url),
      params: route!.params,
      actor: { type: "remote", scope: "collaborator" },
      config: {
        readOnly: false,
        workspaces: [{
          id: "demo",
          name: "Demo",
          path: workspaceRoot,
          workspaceType: "local",
        }],
        authorizedRoots: [workspaceRoot],
      },
    } as RequestContext);

    expect(response.status).toBe(200);
    expect(lifecycleReads).toEqual(["run-old"]);
    expect(ingestRuns).toEqual(["run-old"]);
  });
});
