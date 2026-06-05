import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace.ts", import.meta.url), "utf8");

test("quiet engine reconnect uses reason-aware health timeout", () => {
  const connectQuietStart = source.indexOf("async function connectToEngineQuiet(");
  assert.notEqual(connectQuietStart, -1, "connectToEngineQuiet should exist");

  const lifecycleStart = source.indexOf("const localRuntimeLifecycle = createLocalRuntimeLifecycle", connectQuietStart);
  const connectQuietSource = source.slice(connectQuietStart, lifecycleStart);

  assert.match(
    connectQuietSource,
    /context\?: \{ reason\?: string \}/,
    "quiet reconnect should accept the lifecycle reason",
  );
  assert.match(
    connectQuietSource,
    /timeoutMs: resolveConnectHealthTimeoutMs\(context\?\.reason\)/,
    "quiet reconnect should give browse cold starts the long local boot health timeout",
  );
});
