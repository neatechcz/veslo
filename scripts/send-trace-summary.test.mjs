import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseTraceLine,
  resolveTraceInputFiles,
  summarizeTraceFiles,
} from "./send-trace-summary.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "veslo-send-trace-summary-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveTraceInputFiles reads all split send workflow trace files in a directory", () => {
  withTempDir((dir) => {
    const uiFile = join(dir, "send-workflow-trace.ui.ndjson");
    const serverFile = join(dir, "send-workflow-trace.server.ndjson");
    const unrelatedFile = join(dir, "runtime-trace.ndjson");
    writeFileSync(uiFile, "", "utf8");
    writeFileSync(serverFile, "", "utf8");
    writeFileSync(unrelatedFile, "", "utf8");

    assert.deepEqual(resolveTraceInputFiles(dir), [serverFile, uiFile].sort());
  });
});

test("resolveTraceInputFiles can expand the default legacy file path into a split trace set", () => {
  withTempDir((dir) => {
    const uiFile = join(dir, "send-workflow-trace.ui.ndjson");
    const serverFile = join(dir, "send-workflow-trace.server.ndjson");
    writeFileSync(uiFile, "", "utf8");
    writeFileSync(serverFile, "", "utf8");

    const files = resolveTraceInputFiles(join(dir, "send-workflow-trace.ndjson"), {
      includeSiblingTraceSet: true,
    });
    assert.deepEqual(files, [serverFile, uiFile].sort());
  });
});

test("summarizeTraceFiles recovers glued JSON objects from older corrupted NDJSON rows", () => {
  withTempDir((dir) => {
    const uiFile = join(dir, "send-workflow-trace.ui.ndjson");
    const serverFile = join(dir, "send-workflow-trace.server.ndjson");
    writeFileSync(
      uiFile,
      [
        JSON.stringify({ at: "2026-07-08T21:00:00.000Z", traceId: "send_a", event: "sendPrompt:start", workspaceId: "ws_1" })
          + JSON.stringify({ at: "2026-07-08T21:00:01.000Z", traceId: "send_a", event: "sendPrompt:server-submit-existing-success", status: "submitted" }),
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      serverFile,
      `${JSON.stringify({ at: "2026-07-08T21:00:02.000Z", traceId: "send_b", event: "server:conversation-run:submitted" })}\n`,
      "utf8",
    );

    const parsed = parseTraceLine(`${JSON.stringify({ event: "a" })}${JSON.stringify({ event: "b" })}`);
    assert.equal(parsed.entries.length, 2);

    const summary = summarizeTraceFiles([uiFile, serverFile]);
    assert.equal(summary.parsedLines, 3);
    assert.equal(summary.skippedLines, 0);
    assert.equal(summary.skippedFragments, 0);
    assert.equal(summary.traceCount, 2);
    assert.equal(summary.traces.find((trace) => trace.key === "send_a")?.count, 2);
    assert.equal(summary.traces.find((trace) => trace.key === "send_b")?.count, 1);
  });
});
