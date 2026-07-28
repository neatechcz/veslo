import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const cliSource = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");

describe("orchestrator diagnostic trace redaction", () => {
  test("send-workflow mirrors use the shared sanitizer for paths and directory queries", () => {
    const start = cliSource.indexOf("function writeSendWorkflowTrace(");
    const end = cliSource.indexOf("function runtimeTraceEventName(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = cliSource.slice(start, end);
    expect(block).toContain("...(sanitizeTracePayload(payload) as LogAttributes)");
    expect(cliSource).toContain('"workspace"');
    expect(cliSource).toContain('key === "search" || key === "targetSearch"');
    expect(cliSource).toContain('directory=[redacted]');
    expect(cliSource).toContain('return "[redacted]";');
    expect(cliSource).toContain("TRACE_ENDPOINT_KEYS");
    expect(cliSource).toContain("TRACE_PRIVATE_TEXT_KEYS");
    expect(cliSource).toContain('"engineBaseUrl"');
    expect(cliSource).toContain('"daemonPort"');
    expect(cliSource).toContain('"upstreamBody"');
    expect(cliSource).not.toContain("<local>/${tail || basename(value)}");
  });
});
