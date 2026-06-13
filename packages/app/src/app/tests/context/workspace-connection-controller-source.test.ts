import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";

test("connectToServer lives in routing-only connection controller", () => {
  const controllerSource = readContextSource("workspace-connection-controller.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(
    controllerSource,
    /export function createWorkspaceConnectionController\(/,
    "connection controller factory should own connectToServer",
  );
  assert.match(
    controllerSource,
    /routing\.ensure\(/,
    "connectToServer must use WorkspaceRouting.ensure",
  );
  assert.doesNotMatch(
    controllerSource,
    /const run = \(async \(\) => \{/,
    "old single-active connect fallback must not move into the controller",
  );
  assert.doesNotMatch(
    facadeSource,
    /async function connectToServer\(/,
    "workspace.ts should receive connectToServer from the controller",
  );
});
