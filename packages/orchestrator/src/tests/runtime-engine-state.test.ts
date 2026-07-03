import { describe, expect, test } from "bun:test";

import { runtimeEngineStateFromEngineState } from "../runtime-engine-state.js";

describe("runtimeEngineStateFromEngineState", () => {
  test("maps internal engine states to canonical public runtime states", () => {
    expect(runtimeEngineStateFromEngineState(undefined)).toBe("absent");
    expect(runtimeEngineStateFromEngineState("spawning")).toBe("starting");
    expect(runtimeEngineStateFromEngineState("ready")).toBe("ready");
    expect(runtimeEngineStateFromEngineState("idle")).toBe("ready");
    expect(runtimeEngineStateFromEngineState("suspended")).toBe("stopped");
    expect(runtimeEngineStateFromEngineState("crashed")).toBe("failed");
  });
});
