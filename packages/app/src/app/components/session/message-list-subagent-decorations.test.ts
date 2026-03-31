import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./message-list.tsx", import.meta.url), "utf8");

test("message list accepts subagent decoration map from session props", () => {
  assert.match(
    source,
    /subagentDecorationsBySessionId\?: Record<string, SidebarSubagentDecoration>;/,
    "MessageList props should include optional subagent decoration map",
  );
});

test("subagent timeline row prepends colored decoration label based on child session id", () => {
  assert.match(
    source,
    /const taskDecoration = \(task: TaskStepInfo\): SidebarSubagentDecoration \| null => \{/,
    "MessageList should resolve decoration data for subagent task rows",
  );

  assert.match(
    source,
    /const entry = props\.subagentDecorationsBySessionId\?\.\[sessionId\];/,
    "Decoration lookup should be keyed by subagent child session id",
  );

  assert.match(
    source,
    /style=\{\{\s*color: decoration\(\)\.color,\s*"border-color": `\$\{decoration\(\)\.color\}66`,\s*"background-color": `\$\{decoration\(\)\.color\}1a`,\s*\}\}/s,
    "Decoration chip should render with persisted color styling",
  );
});
