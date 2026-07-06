import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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

describe("opencode health SDK timeout", () => {
  test("aborts the bounded SDK health request instead of leaving it alive", () => {
    const source = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function fetchOpencodeHealthViaSdk(");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("async function fetchOpencodeHealthRaw(", start);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);

    expect(block).toContain("const controller = new AbortController();");
    expect(block).toContain("setTimeout(() => controller.abort(), requestTimeoutMs)");
    expect(block).toContain("client.global.health({ signal: controller.signal })");
    expect(block).toContain("clearTimeout(timer)");
    expect(block).not.toContain("Promise.race");
  });
});
