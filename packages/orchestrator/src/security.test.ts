import { describe, expect, test } from "bun:test";

import { REDACTED_SECRET_VALUE, sanitizeRuntimePayloadForLogs } from "./security.js";

describe("sanitizeRuntimePayloadForLogs", () => {
  test("redacts OpenCode password and OpenWork tokens", () => {
    const input = {
      opencode: {
        baseUrl: "http://127.0.0.1:4096",
        username: "openwork",
        password: "very-secret-password",
      },
      openwork: {
        baseUrl: "http://127.0.0.1:8787",
        token: "client-token",
        hostToken: "host-token",
      },
    };

    const sanitized = sanitizeRuntimePayloadForLogs(input);

    expect(sanitized.opencode.password).toBe(REDACTED_SECRET_VALUE);
    expect(sanitized.openwork.token).toBe(REDACTED_SECRET_VALUE);
    expect(sanitized.openwork.hostToken).toBe(REDACTED_SECRET_VALUE);
    expect(input.opencode.password).toBe("very-secret-password");
    expect(input.openwork.token).toBe("client-token");
    expect(input.openwork.hostToken).toBe("host-token");
  });
});
