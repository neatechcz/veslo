import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectDiagnosticLogManifest } from "./diagnostic-log-manifest.mjs";

test("diagnostic manifest records configured trace channels without copying their contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "veslo-webdriver-log-manifest-"));
  const uiTrace = join(directory, "send-workflow-trace.ui.ndjson");
  await writeFile(uiTrace, "{\"event\":\"private content stays in source file\"}\n", "utf8");

  const manifest = await collectDiagnosticLogManifest({
    traces: {
      sendWorkflowTraceFiles: { ui: uiTrace, server: join(directory, "missing-server.ndjson") },
    },
  });

  const ui = manifest.files.find((file) => file.channel === "ui");
  assert.equal(ui?.configured, true);
  assert.equal(ui?.fileName, "send-workflow-trace.ui.ndjson");
  assert.equal(ui?.present, true);
  assert.ok((ui?.sizeBytes ?? 0) > 0);
  assert.match(ui?.modifiedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(JSON.stringify(manifest).includes("private content"), false);
  assert.deepEqual(manifest.files.find((file) => file.channel === "server"), {
    channel: "server",
    configured: true,
    fileName: "missing-server.ndjson",
    present: false,
  });
});
