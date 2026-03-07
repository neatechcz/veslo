import { describe, expect, test } from "bun:test";

import { REDACTED_SECRET_VALUE, redactSensitiveConfig, serializeWorkspace } from "./server.js";

describe("redactSensitiveConfig", () => {
  test("redacts nested secret-looking fields and keeps non-secret keys", () => {
    const input = {
      opencode: {
        model: "openai/gpt-5",
        apiKey: "top-secret-key",
      },
      oauth: {
        access_token: "access-token",
        refreshToken: "refresh-token",
      },
      nested: [{ token: "abc123" }, { keep: "ok" }],
      tokenSource: "generated",
    };

    const result = redactSensitiveConfig(input) as typeof input;

    expect(result.opencode.apiKey).toBe(REDACTED_SECRET_VALUE);
    expect(result.oauth.access_token).toBe(REDACTED_SECRET_VALUE);
    expect(result.oauth.refreshToken).toBe(REDACTED_SECRET_VALUE);
    expect(result.nested[0]?.token).toBe(REDACTED_SECRET_VALUE);
    expect(result.nested[1]?.keep).toBe("ok");
    expect(result.tokenSource).toBe("generated");

    expect(input.opencode.apiKey).toBe("top-secret-key");
    expect(input.oauth.access_token).toBe("access-token");
  });
});

describe("serializeWorkspace", () => {
  test("does not expose OpenCode password in serialized workspace payload", () => {
    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: "/tmp/workspace",
      workspaceType: "local",
      baseUrl: "http://127.0.0.1:4096",
      directory: "/tmp/workspace",
      opencodeUsername: "veslo",
      opencodePassword: "super-secret-password",
    } as const;

    const result = serializeWorkspace(workspace as any) as {
      opencode?: { username?: string; password?: string };
    };

    expect(result.opencode?.username).toBe("veslo");
    expect(result.opencode?.password).toBeUndefined();
  });
});
