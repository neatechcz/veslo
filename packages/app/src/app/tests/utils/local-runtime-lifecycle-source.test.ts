import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../utils/local-runtime-lifecycle.ts", import.meta.url), "utf8");

test("local runtime lifecycle traces engine_info poll failures and timeouts", () => {
  assert.match(
    source,
    /import \{ recordSendWorkflowTrace \} from "\.\.\/\.\.\/lib\/send-workflow-trace";|import \{ recordSendWorkflowTrace \} from "\.\.\/lib\/send-workflow-trace";/,
    "local runtime lifecycle should use the shared send workflow trace sink",
  );
  assert.match(
    source,
    /recordSendWorkflowTrace\("local-runtime-lifecycle", event,/,
    "poll diagnostics should keep a stable trace source",
  );
  assert.match(
    source,
    /catch \(error\) \{[\s\S]*recordEngineInfoPollTrace\("engine-info-poll:error"[\s\S]*phase: "base-url"/,
    "base-url polling failures should be traceable instead of swallowed",
  );
  assert.match(
    source,
    /phase: "base-url"[\s\S]*recordEngineInfoPollTrace\("engine-info-poll:timeout"/,
    "base-url polling timeout should include a summary trace",
  );
  assert.match(
    source,
    /catch \(error\) \{[\s\S]*recordEngineInfoPollTrace\("engine-info-poll:error"[\s\S]*phase: "starting"/,
    "engine-starting polling failures should be traceable instead of swallowed",
  );
  assert.match(
    source,
    /phase: "starting"[\s\S]*recordEngineInfoPollTrace\("engine-info-poll:timeout"/,
    "engine-starting polling timeout should include a summary trace",
  );
  assert.match(
    source,
    /prepareQueue: Promise<void>[\s\S]*prepare-runtime:queue-wait:start[\s\S]*label: "local runtime prepare queue"[\s\S]*prepare-runtime:queue-timeout[\s\S]*prepare-runtime:queue-wait:done[\s\S]*prepare-runtime:native-start[\s\S]*withTimeoutOrThrow\(nativePrepare,[\s\S]*label: "local runtime prepare"[\s\S]*prepare-runtime:native-timeout[\s\S]*releaseOnce\(\)/,
    "native runtime preparation should be serialized and bounded before UI sends wait forever",
  );
});
