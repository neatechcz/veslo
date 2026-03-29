import assert from "node:assert/strict";
import test from "node:test";

import {
  createTimelineDetailState,
  toggleTimelineExpanded,
  toggleTimelineSection,
} from "./timeline-detail-state.js";

test("createTimelineDetailState starts collapsed and auto-opens the running section", () => {
  const state = createTimelineDetailState({
    sections: [
      { id: "explore-0", kind: "explore", status: "done" },
      { id: "action-1", kind: "action", status: "running" },
      { id: "verify-2", kind: "verify", status: "done" },
    ],
  });

  assert.equal(state.expanded, false);
  assert.deepEqual([...state.openSectionIds], ["action-1"]);
});

test("toggleTimelineExpanded flips only the outer timeline visibility", () => {
  const initial = createTimelineDetailState({
    sections: [{ id: "explore-0", kind: "explore", status: "done" }],
  });

  const expanded = toggleTimelineExpanded(initial);
  const collapsed = toggleTimelineExpanded(expanded);

  assert.equal(expanded.expanded, true);
  assert.equal(collapsed.expanded, false);
  assert.deepEqual([...collapsed.openSectionIds], []);
});

test("toggleTimelineSection allows multiple sections to stay open", () => {
  const initial = {
    expanded: true,
    openSectionIds: new Set<string>(),
  };

  const withExplore = toggleTimelineSection(initial, "explore-0");
  const withAction = toggleTimelineSection(withExplore, "action-1");
  const withExploreClosed = toggleTimelineSection(withAction, "explore-0");

  assert.deepEqual([...withExplore.openSectionIds], ["explore-0"]);
  assert.deepEqual([...withAction.openSectionIds].sort(), ["action-1", "explore-0"]);
  assert.deepEqual([...withExploreClosed.openSectionIds], ["action-1"]);
});
