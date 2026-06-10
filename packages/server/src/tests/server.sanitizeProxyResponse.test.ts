import { describe, expect, test } from "bun:test";
import { sanitizeProxyResponse } from "../server.js";

describe("sanitizeProxyResponse", () => {
  test("strips content-encoding, transfer-encoding, content-length", () => {
    const upstream = new Response("hello", {
      status: 200,
      headers: {
        "content-encoding": "gzip",
        "transfer-encoding": "chunked",
        "content-length": "5",
        "content-type": "text/plain",
      },
    });
    const sanitized = sanitizeProxyResponse(upstream);
    expect(sanitized.headers.get("content-encoding")).toBeNull();
    expect(sanitized.headers.get("transfer-encoding")).toBeNull();
    expect(sanitized.headers.get("content-length")).toBeNull();
    expect(sanitized.headers.get("content-type")).toBe("text/plain");
  });

  test("preserves status and statusText", () => {
    const upstream = new Response("not found body", {
      status: 404,
      statusText: "Not Found",
    });
    const sanitized = sanitizeProxyResponse(upstream);
    expect(sanitized.status).toBe(404);
    expect(sanitized.statusText).toBe("Not Found");
  });

  test("preserves body content (no header → no body decode mismatch)", async () => {
    const upstream = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
    const sanitized = sanitizeProxyResponse(upstream);
    const text = await sanitized.text();
    expect(text).toBe('{"ok":true}');
  });

  test("preserves arbitrary custom headers", () => {
    const upstream = new Response("", {
      headers: { "x-veslo-trace": "abc123", "content-encoding": "gzip" },
    });
    const sanitized = sanitizeProxyResponse(upstream);
    expect(sanitized.headers.get("x-veslo-trace")).toBe("abc123");
    expect(sanitized.headers.get("content-encoding")).toBeNull();
  });

  test("handles response without any of the stripped headers", () => {
    const upstream = new Response("payload", {
      status: 201,
      headers: { "content-type": "text/plain" },
    });
    const sanitized = sanitizeProxyResponse(upstream);
    expect(sanitized.status).toBe(201);
    expect(sanitized.headers.get("content-type")).toBe("text/plain");
  });
});
