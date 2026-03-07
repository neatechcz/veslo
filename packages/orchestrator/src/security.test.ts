import { describe, expect, test } from "bun:test";

import { REDACTED_SECRET_VALUE, sanitizeRuntimePayloadForLogs } from "./security.js";

describe("sanitizeRuntimePayloadForLogs", () => {
  test("redacts OpenCode password and Veslo tokens", () => {
    const input = {
      opencode: {
        baseUrl: "http://127.0.0.1:4096",
        username: "veslo",
        password: "very-secret-password",
      },
      veslo: {
        baseUrl: "http://127.0.0.1:8787",
        token: "client-token",
        hostToken: "host-token",
      },
    };

    const sanitized = sanitizeRuntimePayloadForLogs(input);

    expect(sanitized.opencode.password).toBe(REDACTED_SECRET_VALUE);
    expect(sanitized.veslo.token).toBe(REDACTED_SECRET_VALUE);
    expect(sanitized.veslo.hostToken).toBe(REDACTED_SECRET_VALUE);
    expect(input.opencode.password).toBe("very-secret-password");
    expect(input.veslo.token).toBe("client-token");
    expect(input.veslo.hostToken).toBe("host-token");
  });
});
