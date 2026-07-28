import { describe, expect, test } from "bun:test";

import {
  REDACTED_RUNTIME_TRACE_VALUE,
  sanitizeRuntimeTracePayload,
} from "../runtime-trace-sanitizer.js";

describe("sanitizeRuntimeTracePayload", () => {
  test("redacts direct and nested runtime-sensitive values", () => {
    expect(
      sanitizeRuntimeTracePayload({
        workspaceId: "workspace-1",
        directory: "C:\\Users\\person\\project",
        targetUrl: "http://127.0.0.1:4096/workspace/workspace-1",
        error: "request failed at /Users/person/project/.opencode/config.json",
        nested: {
          token: "secret-token",
          prompt: "private prompt",
        },
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      directory: REDACTED_RUNTIME_TRACE_VALUE,
      targetUrl: REDACTED_RUNTIME_TRACE_VALUE,
      error: REDACTED_RUNTIME_TRACE_VALUE,
      nested: {
        token: REDACTED_RUNTIME_TRACE_VALUE,
        prompt: REDACTED_RUNTIME_TRACE_VALUE,
      },
    });
  });

  test("keeps bounded correlation and protocol fields", () => {
    expect(
      sanitizeRuntimeTracePayload({
        traceId: "trace-1",
        workspaceId: "workspace-1",
        status: 503,
        path: "/workspace/workspace-1/conversations",
      }),
    ).toEqual({
      traceId: "trace-1",
      workspaceId: "workspace-1",
      status: 503,
      path: "/workspace/workspace-1/conversations",
    });
  });

  test("redacts free-form exception text while preserving typed diagnostics", () => {
    expect(
      sanitizeRuntimeTracePayload({
        message: "OpenCode rejected the private user prompt",
        error: "upstream body included private content",
        errorName: "UpstreamError",
        code: "upstream_failure",
        status: 502,
      }),
    ).toEqual({
      message: REDACTED_RUNTIME_TRACE_VALUE,
      error: REDACTED_RUNTIME_TRACE_VALUE,
      errorName: "UpstreamError",
      code: "upstream_failure",
      status: 502,
    });
  });
});
