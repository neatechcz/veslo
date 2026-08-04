import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readWorkflowTrace, waitForWorkflowTraceEvent } from "./workflow-trace-reader.mjs";

test("workflow trace reader ignores malformed rows and resolves an exact barrier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-workflow-trace-"));
  const path = join(dir, "trace.ndjson");
  await writeFile(path, [
    JSON.stringify({ ts: 10, event: "before", workspaceId: "ws-a" }),
    "not-json",
    JSON.stringify({ ts: 20, event: "target", workspaceId: "ws-a", runId: "run-a" }),
    "",
  ].join("\n"), "utf8");

  assert.equal((await readWorkflowTrace(path)).length, 2);
  assert.deepEqual(
    await waitForWorkflowTraceEvent({
      path,
      event: "target",
      afterTs: 15,
      matches: (entry) => entry.workspaceId === "ws-a",
      timeoutMs: 500,
    }),
    { ts: 20, event: "target", workspaceId: "ws-a", runId: "run-a" },
  );
});
