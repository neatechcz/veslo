import { describe, expect, test } from "bun:test";

import { FileSessionStore } from "../file-sessions.js";
import { registerFileSessionRoutes } from "../routes/file-sessions.js";
import { matchRoute, type Route } from "../routing.js";

describe("File session routes", () => {
  test("registers the filesystem workflow contract", () => {
    const routes: Route[] = [];
    const fileSessions = new FileSessionStore();
    registerFileSessionRoutes(routes, {
      fileSessions,
      recordWorkspaceFileEvent: (workspaceId, input) =>
        fileSessions.recordWorkspaceEvent({ workspaceId, ...input }),
    });

    expect(routes).toHaveLength(15);

    const expectedRoutes = [
      ["GET", "/workspace/demo/inbox"],
      ["GET", "/workspace/demo/inbox/aW5ib3gudHh0"],
      ["POST", "/workspace/demo/inbox"],
      ["GET", "/workspace/demo/artifacts"],
      ["GET", "/workspace/demo/artifacts/b3V0Ym94LnR4dA"],
      ["POST", "/workspace/demo/files/sessions"],
      ["POST", "/files/sessions/session-1/renew"],
      ["DELETE", "/files/sessions/session-1"],
      ["GET", "/files/sessions/session-1/catalog/snapshot"],
      ["GET", "/files/sessions/session-1/catalog/events"],
      ["POST", "/files/sessions/session-1/read-batch"],
      ["POST", "/files/sessions/session-1/write-batch"],
      ["POST", "/files/sessions/session-1/ops"],
      ["GET", "/workspace/demo/files/content"],
      ["POST", "/workspace/demo/files/content"],
    ] as const;

    for (const [method, path] of expectedRoutes) {
      const route = matchRoute(routes, method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe("client");
    }

    expect(matchRoute(routes, "GET", "/workspace/demo/files/session")).toBeNull();
  });
});
