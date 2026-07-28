import assert from "node:assert/strict";
import test from "node:test";

import { createEngineInfoLoader } from "../../lib/engine-info-loader.js";

test("engine-info loader joins concurrent normalized workspace reads", async () => {
  let calls = 0;
  let resolve: ((value: { generation: number }) => void) | undefined;
  const inputs: Array<Record<string, string | null>> = [];
  const load = createEngineInfoLoader(async (input) => {
    calls += 1;
    inputs.push(input);
    return new Promise<{ generation: number }>((done) => {
      resolve = done;
    });
  });

  const first = load(" workspace-a ", " C:/workspace-a ");
  const second = load("workspace-a", "C:/workspace-a");
  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.deepEqual(inputs, [
    { workspaceId: "workspace-a", workspacePath: "C:/workspace-a" },
  ]);

  resolve?.({ generation: 1 });
  assert.deepEqual(await first, { generation: 1 });
});

test("engine-info loader does not cache a settled generation", async () => {
  let generation = 0;
  const load = createEngineInfoLoader(async () => ({ generation: ++generation }));

  assert.deepEqual(await load("workspace-a"), { generation: 1 });
  assert.deepEqual(await load("workspace-a"), { generation: 2 });
});
