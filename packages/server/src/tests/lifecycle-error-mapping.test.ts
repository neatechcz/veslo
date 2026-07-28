import { describe, expect, test } from "bun:test";

import { formatError } from "../errors.js";
import {
  lifecycleRequestApiError,
  lifecycleRequestDiagnostic,
} from "../lifecycle-error-mapping.js";
import { OrchestratorLifecycleRequestError } from "../orchestrator-lifecycle-client.js";

const UPSTREAM_PATH = "/workspaces/ws-1/runs/run-1/status";

const upstreamError = (status: number, body: unknown = { internal: "detail" }) =>
  new OrchestratorLifecycleRequestError(UPSTREAM_PATH, status, body);

describe("lifecycle error mapping", () => {
  test("the client response carries no upstream body or orchestrator path", () => {
    const body = {
      engineOwnerId: "owner-1",
      workdir: "C:/Users/someone/private-project",
      trace: "internal stack",
    };
    const formatted = formatError(lifecycleRequestApiError(upstreamError(503, body)));

    const serialized = JSON.stringify(formatted);
    expect(serialized).not.toContain(UPSTREAM_PATH);
    expect(serialized).not.toContain("private-project");
    expect(serialized).not.toContain("internal stack");
    expect(serialized).not.toContain("engineOwnerId");

    // The one upstream fact an operator needs is still there.
    expect(formatted.details).toEqual({ upstreamStatus: 503 });
  });

  test("sanitized diagnostics retain status, path, and body shape without body content", () => {
    const diagnostic = lifecycleRequestDiagnostic(upstreamError(502, { a: "b" }));

    expect(diagnostic.upstreamStatus).toBe(502);
    expect(diagnostic.upstreamPath).toBe(UPSTREAM_PATH);
    expect(diagnostic.upstreamBody).toEqual({ kind: "object", fieldNames: ["a"] });
  });

  test("a large upstream body records only its shape", () => {
    const diagnostic = lifecycleRequestDiagnostic(
      upstreamError(503, { padding: "private prompt ".repeat(5_000) }),
    );

    expect(diagnostic.upstreamBody).toEqual({ kind: "object", fieldNames: ["padding"] });
    expect(JSON.stringify(diagnostic)).not.toContain("private prompt");
  });

  test("an unserializable body does not break the error path", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const diagnostic = lifecycleRequestDiagnostic(upstreamError(503, circular));
    expect(diagnostic.upstreamBody).toEqual({ kind: "object", fieldNames: ["self"] });
    // Mapping must still produce a usable API error.
    expect(lifecycleRequestApiError(upstreamError(503, circular)).status).toBe(503);
  });

  test("external status and code are unchanged by the consolidation", () => {
    const cases: Array<[number, number, string]> = [
      [401, 503, "lifecycle_unavailable"],
      [403, 503, "lifecycle_unavailable"],
      [404, 404, "lifecycle_not_found"],
      [501, 501, "lifecycle_unsupported"],
      [500, 503, "lifecycle_unavailable"],
      [502, 503, "lifecycle_unavailable"],
    ];

    for (const [upstreamStatus, expectedStatus, expectedCode] of cases) {
      const mapped = lifecycleRequestApiError(upstreamError(upstreamStatus));
      expect([upstreamStatus, mapped.status, mapped.code]).toEqual([
        upstreamStatus,
        expectedStatus,
        expectedCode,
      ]);
    }
  });
});
