import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { workspaceIdForLocal } from "../workspace-id.js";

type WorkspaceIdFixture = {
  vectors: Array<{
    name: string;
    inputs: { orchestratorPath: string };
    expected: { orchestrator: { win32: string; posix: string } };
  }>;
};

function loadWorkspaceIdFixture(): WorkspaceIdFixture {
  return JSON.parse(
    readFileSync(new URL("../../../../docs/fixtures/workspace-id-golden-vectors.json", import.meta.url), "utf8"),
  ) as WorkspaceIdFixture;
}

function expectedForCurrentPlatform(vector: WorkspaceIdFixture["vectors"][number]): string {
  return process.platform === "win32"
    ? vector.expected.orchestrator.win32
    : vector.expected.orchestrator.posix;
}

describe("workspaceIdForLocal golden vectors", () => {
  test("matches shared golden vectors", () => {
    for (const vector of loadWorkspaceIdFixture().vectors) {
      expect(workspaceIdForLocal(vector.inputs.orchestratorPath), vector.name).toBe(
        expectedForCurrentPlatform(vector),
      );
    }
  });
});
