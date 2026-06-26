import { describe, expect, test } from "bun:test";

import { registerOpenCodeRouterRoutes } from "../routes/opencode-router.js";
import { matchRoute, type Route } from "../routing.js";

describe("OpenCode Router workspace routes", () => {
  test("registers the workspace OpenCode Router contract under /opencode-router", () => {
    const routes: Route[] = [];
    registerOpenCodeRouterRoutes(routes);

    expect(routes).toHaveLength(13);

    const expectedRoutes = [
      ["POST", "/workspace/demo/opencode-router/telegram-token"],
      ["GET", "/workspace/demo/opencode-router/telegram"],
      ["POST", "/workspace/demo/opencode-router/telegram-enabled"],
      ["POST", "/workspace/demo/opencode-router/slack-tokens"],
      ["GET", "/workspace/demo/opencode-router/identities/telegram"],
      ["POST", "/workspace/demo/opencode-router/identities/telegram"],
      ["DELETE", "/workspace/demo/opencode-router/identities/telegram/alice"],
      ["GET", "/workspace/demo/opencode-router/identities/slack"],
      ["POST", "/workspace/demo/opencode-router/identities/slack"],
      ["DELETE", "/workspace/demo/opencode-router/identities/slack/bob"],
      ["GET", "/workspace/demo/opencode-router/bindings"],
      ["POST", "/workspace/demo/opencode-router/bindings"],
      ["POST", "/workspace/demo/opencode-router/send"],
    ] as const;

    for (const [method, path] of expectedRoutes) {
      const route = matchRoute(routes, method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe("client");
      expect(route?.params.id).toBe("demo");
    }

    expect(matchRoute(routes, "GET", "/workspace/demo/veslo-code-router/identities/telegram")).toBeNull();
    expect(matchRoute(routes, "POST", "/workspace/demo/veslo-code-router/send")).toBeNull();
  });
});
