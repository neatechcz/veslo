import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTodoItems } from "../../utils/todos.js";

test("normalizeTodoItems returns an empty list for non-array input", () => {
  assert.deepEqual(normalizeTodoItems(null), []);
  assert.deepEqual(normalizeTodoItems({ content: "Review" }), []);
});

test("normalizeTodoItems drops invalid entries, trims fields, and fills stable defaults", () => {
  assert.deepEqual(
    normalizeTodoItems([
      null,
      "not-a-todo",
      { content: "  " },
      { id: "  todo-1  ", content: "  Ship it  ", status: " done ", priority: " high " },
      { content: "Follow up" },
      { id: "empty", content: "   " },
    ]),
    [
      {
        id: "todo-1",
        content: "Ship it",
        status: "done",
        priority: "high",
      },
      {
        id: "4:pending:medium:Follow up",
        content: "Follow up",
        status: "pending",
        priority: "medium",
      },
    ],
  );
});
