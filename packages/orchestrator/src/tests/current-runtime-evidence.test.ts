import { describe, expect, test } from "bun:test";

import {
  classifyCurrentRuntimeEvidence,
  runningEngineFromCurrentRuntimeEvidence,
} from "../current-runtime-evidence.js";
import { createRunActivityProbe } from "../run-activity-probe.js";

const record = {
  workspaceId: "ws-a",
  conversationId: "conv-a",
  runId: "run-a",
  engineSessionId: "session-a",
  engineOwnerId: "owner-a",
  directory: "C:/repo",
  kind: "prompt" as const,
};

describe("current runtime evidence", () => {
  test("classifies each pool snapshot state explicitly", () => {
    expect(classifyCurrentRuntimeEvidence({ snapshot: null }).kind).toBe("absent");
    expect(classifyCurrentRuntimeEvidence({
      snapshot: { state: "spawning", childKind: "direct" },
    }).kind).toBe("starting");
    expect(classifyCurrentRuntimeEvidence({
      snapshot: null,
      sharedPendingStart: true,
    }).kind).toBe("starting");
    expect(classifyCurrentRuntimeEvidence({
      snapshot: { state: "suspended", childKind: "direct" },
    }).kind).toBe("stopped_snapshot");
    expect(classifyCurrentRuntimeEvidence({
      snapshot: { state: "crashed", childKind: "wsl" },
    }).kind).toBe("unsupported_wrapper_snapshot");
  });

  test("treats a stopped snapshot without a recorded child kind as unsupported", () => {
    for (const state of ["suspended", "crashed"] as const) {
      expect(classifyCurrentRuntimeEvidence({ snapshot: { state } }).kind).toBe(
        "unsupported_wrapper_snapshot",
      );
    }
  });

  test("keeps ready and idle WSL snapshots available as running engines", () => {
    for (const state of ["ready", "idle"] as const) {
      const engine = { state, childKind: "wsl" as const, engineOwnerId: "owner-a" };
      const evidence = classifyCurrentRuntimeEvidence({ snapshot: engine });

      expect(evidence.kind).toBe("running");
      expect(runningEngineFromCurrentRuntimeEvidence(evidence)).toBe(engine);
    }
  });

  test("stopped and starting snapshots produce no_current_engine before request construction", async () => {
    const snapshots: Array<{
      state: "suspended" | "spawning";
      childKind: "direct";
    }> = [
      { state: "suspended", childKind: "direct" },
      { state: "spawning", childKind: "direct" },
    ];
    for (const snapshot of snapshots) {
      const evidence = classifyCurrentRuntimeEvidence({ snapshot });
      const probe = createRunActivityProbe({
        getEngine: () => runningEngineFromCurrentRuntimeEvidence(evidence),
        buildEngineRequest: () => {
          throw new Error("must not build a request without a running engine");
        },
      });

      await expect(probe(record)).resolves.toEqual({
        unreachable: true,
        unavailableReason: "no_current_engine",
      });
    }
  });
});
