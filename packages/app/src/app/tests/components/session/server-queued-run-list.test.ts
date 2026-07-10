import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../../components/session/server-queued-run-list.tsx", import.meta.url), "utf8");

test("server queued run list uses generic typed labels and exposes no local mutation controls", () => {
  assert.match(source, /case "shell":\s*return tr\("session\.server_queue_shell_label"\);/);
  assert.match(source, /case "command":\s*return tr\("session\.server_queue_command_label"\);/);
  assert.match(source, /case "summarize":\s*return tr\("session\.server_queue_summary_label"\);/);
  assert.match(source, /return tr\("session\.server_queue_prompt_label"\);/);
  assert.match(source, /aria-label=\{tr\("session\.server_queue_readonly_label"\)\}/);
  assert.match(source, /item\.status === "failed" && item\.error/);
  assert.match(source, /role="list"[\s\S]*role="listitem"[\s\S]*rounded-xl border bg-gray-1/);
  assert.match(source, /text-\[10px\] font-medium text-blue-11/);
  assert.doesNotMatch(source, /<button\b|onRetry|onEdit|onCancel|onMove|draggable|RotateCcw|Pencil|GripVertical/);
});
