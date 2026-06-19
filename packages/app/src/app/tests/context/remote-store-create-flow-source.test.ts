import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const storeSource = readFileSync(
  new URL("../../stores/remote-store.ts", import.meta.url),
  "utf8",
);

test("first remote workspace flow creates a workspace id before connecting", () => {
  const createIdx = storeSource.indexOf("await invokeWorkspaceCreateRemote({");
  const syncIdx = storeSource.indexOf("deps.syncActiveWorkspaceId(ws.activeId);", createIdx);
  const connectIdx = storeSource.indexOf("const ok = await deps.connectToServer(", syncIdx);

  assert.notStrictEqual(createIdx, -1, "remote workspace creation call is missing");
  assert.notStrictEqual(syncIdx, -1, "remote workspace id should be synced after creation");
  assert.notStrictEqual(connectIdx, -1, "remote connect call is missing");
  assert.ok(createIdx < connectIdx, "remote workspace must be created before connectToServer");
  assert.ok(syncIdx < connectIdx, "active remote workspace id must be synced before connectToServer");

  const connectBlock = storeSource.slice(connectIdx, storeSource.indexOf(");", connectIdx) + 2);
  assert.match(
    connectBlock,
    /workspaceId:\s*remoteWorkspaceId/,
    "first remote connect must pass the created workspace id",
  );
  assert.match(
    connectBlock,
    /workspaceType:\s*"remote"/,
    "first remote connect should keep remote workspace scope",
  );
});
