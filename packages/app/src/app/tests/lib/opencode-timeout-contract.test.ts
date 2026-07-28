import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../lib/opencode.ts", import.meta.url), "utf8");

function sourceBetween(startNeedle: string, endNeedle: string) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `${startNeedle} should exist`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `${endNeedle} should exist after ${startNeedle}`);
  return source.slice(start, end);
}

test("Tauri OpenCode fetch uses endpoint-aware timeout resolver for Request inputs", () => {
  const createTauriFetchSource = sourceBetween("const createTauriFetch", "export function unwrap");

  assert.match(
    createTauriFetchSource,
    /resolveRequestTimeoutMs\(\s*request,\s*DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS\s*\)/,
  );
});

test("Tauri OpenCode fetch uses endpoint-aware timeout resolver for URL inputs", () => {
  const createTauriFetchSource = sourceBetween("const createTauriFetch", "export function unwrap");

  assert.match(
    createTauriFetchSource,
    /resolveRequestTimeoutMs\(\s*input,\s*DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS\s*\)/,
  );
});

test("proxied OpenCode requests carry the active send trace id", () => {
  // The orchestrator records this header on every proxy event. Without it a
  // proxy failure cannot be tied back to the send that caused it.
  assert.match(source, /const SEND_TRACE_ID_HEADER = "X-Veslo-Send-Trace-Id";/);

  const tauriFetch = sourceBetween("const createTauriFetch", "export function createClient");
  assert.match(tauriFetch, /const addSendTrace = \(headers: Headers\) => \{/);
  // Both branches of the fetch wrapper must attach it: Request inputs and
  // plain URL inputs take different paths.
  assert.equal(tauriFetch.match(/addSendTrace\(headers\);/g)?.length, 2);
  // An explicit header from the caller wins over the ambient id.
  assert.match(tauriFetch, /if \(headers\.has\(SEND_TRACE_ID_HEADER\)\) return;/);
});
