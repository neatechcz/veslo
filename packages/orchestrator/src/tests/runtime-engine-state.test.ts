import { describe, expect, test } from "bun:test";

import {
  RUNTIME_ENGINE_STATES,
  runtimeEngineStateFromEngineState,
} from "../runtime-engine-state.js";

describe("runtimeEngineStateFromEngineState", () => {
  test("exposes the canonical public runtime state vocabulary", () => {
    expect(RUNTIME_ENGINE_STATES).toEqual([
      "absent",
      "starting",
      "process_ready",
      "workspace_api_waiting",
      "ready",
      "stopped",
      "failed",
    ]);
  });

  test("maps internal engine states to canonical public runtime states", () => {
    expect(runtimeEngineStateFromEngineState(undefined)).toBe("absent");
    expect(runtimeEngineStateFromEngineState("spawning")).toBe("starting");
    expect(runtimeEngineStateFromEngineState("ready")).toBe("ready");
    expect(runtimeEngineStateFromEngineState("idle")).toBe("ready");
    expect(runtimeEngineStateFromEngineState("suspended")).toBe("stopped");
    expect(runtimeEngineStateFromEngineState("crashed")).toBe("failed");
  });
});
