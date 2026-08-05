import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { classifySharedProxyUpstreamError } from "../proxy-upstream-health-policy.js";

const cliSource = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");

describe("proxy upstream shared-engine health policy", () => {
  test("treats transient GET /event upstream socket close as non-fatal", () => {
    const policy = classifySharedProxyUpstreamError({
      method: "GET",
      targetPath: "/event",
      requestPath: "/workspace/ws-a/opencode/event",
      errorMessage: "The socket connection was closed unexpectedly",
    });

    expect(policy).toEqual({
      eventStream: true,
      shutdown: false,
      nonFatalEngineError: true,
      markSharedEngineUnhealthy: false,
    });
  });

  test("keeps non-event upstream socket failures fatal for the shared engine", () => {
    const policy = classifySharedProxyUpstreamError({
      method: "POST",
      targetPath: "/session",
      requestPath: "/workspace/ws-a/opencode/session",
      errorMessage: "The socket connection was closed unexpectedly",
    });

    expect(policy).toEqual({
      eventStream: false,
      shutdown: false,
      nonFatalEngineError: false,
      markSharedEngineUnhealthy: true,
    });
  });

  test("treats transient non-event upstream socket close as non-fatal during shutdown", () => {
    const policy = classifySharedProxyUpstreamError({
      method: "POST",
      targetPath: "/session/sess-a/command",
      requestPath: "/workspace/ws-a/opencode/session/sess-a/command",
      errorMessage: "The socket connection was closed unexpectedly",
      isShuttingDown: true,
    });

    expect(policy).toEqual({
      eventStream: false,
      shutdown: true,
      nonFatalEngineError: true,
      markSharedEngineUnhealthy: false,
    });
  });

  test("keeps non-transient event stream errors fatal", () => {
    const policy = classifySharedProxyUpstreamError({
      method: "GET",
      targetPath: "/event",
      requestPath: "/workspace/ws-a/opencode/event",
      errorMessage: "upstream returned malformed response",
    });

    expect(policy).toEqual({
      eventStream: true,
      shutdown: false,
      nonFatalEngineError: false,
      markSharedEngineUnhealthy: true,
    });
  });

  test("daemon proxy wrapper applies the policy before marking shared engine unhealthy", () => {
    expect(cliSource).toContain('import { classifySharedProxyUpstreamError } from "./proxy-upstream-health-policy.js";');
    expect(cliSource).toContain("const healthPolicy = classifySharedProxyUpstreamError({");
    expect(cliSource).toContain("isShuttingDown: routerShutdownStarted");
    expect(cliSource).toContain("shutdown: healthPolicy.shutdown");
    expect(cliSource).toContain("nonFatalEngineError: healthPolicy.nonFatalEngineError");
    expect(cliSource).toContain("const expectedEventStreamClose = healthPolicy.eventStream && healthPolicy.nonFatalEngineError;");
    expect(cliSource).toContain('"orchestrator:event-stream:closed"');
    expect(cliSource).toContain("engineOwnerId: engine.engineOwnerId");
    expect(cliSource).toContain("enginePid: engine.pid");
    expect(cliSource).toContain('traceRuntime("orchestrator:engine-generation-exit", payload)');
    expect(cliSource).toContain("usesSharedOpenCodeEngine(workspaceTopology) && healthPolicy.markSharedEngineUnhealthy");
  });

  test("records a safe engine-child exit correlation record", () => {
    expect(cliSource).toContain('writeSendWorkflowTrace("orchestrator:engine-child-exit"');
    expect(cliSource).toContain("engineOwnerId: options.engineOwnerId ?? null");
    expect(cliSource).toContain('exitKind: code === 0 && signal === null ? "clean" : "unexpected"');
    expect(cliSource).toContain("runtimeMs: Date.now() - childStartedAt");
    expect(cliSource).toContain('exitTrigger: reason === "child_exit" ? "unplanned_child_exit" : "managed_stop"');
  });
});
