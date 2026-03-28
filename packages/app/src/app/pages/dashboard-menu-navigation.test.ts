import assert from "node:assert/strict";
import test from "node:test";

import { resolveLeftMenuAction } from "./dashboard-menu-navigation.js";

test("returns to selected session on narrow screens for automations tab", () => {
  const result = resolveLeftMenuAction({
    tab: "scheduled",
    selectedSessionId: "sess-123",
    isNarrowViewport: true,
  });

  assert.deepEqual(result, { kind: "return-to-session", sessionId: "sess-123" });
});

test("keeps sidebar toggle behavior on wide screens", () => {
  const result = resolveLeftMenuAction({
    tab: "skills",
    selectedSessionId: "sess-123",
    isNarrowViewport: false,
  });

  assert.deepEqual(result, { kind: "toggle-left-sidebar" });
});

test("keeps sidebar toggle behavior when no session is selected", () => {
  const result = resolveLeftMenuAction({
    tab: "mcp",
    selectedSessionId: null,
    isNarrowViewport: true,
  });

  assert.deepEqual(result, { kind: "toggle-left-sidebar" });
});
