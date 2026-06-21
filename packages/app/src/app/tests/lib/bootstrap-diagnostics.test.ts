import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyNewSessionDisabledReason,
  normalizeBootstrapDiagnosticsCloudContext,
  sanitizeBootstrapDiagnosticPayload,
} from "../../lib/bootstrap-diagnostics.js";

test("classifyNewSessionDisabledReason distinguishes runtime and quick-chat availability", () => {
  assert.equal(
    classifyNewSessionDisabledReason({
      runtimeUnreachable: true,
      hasRuntimeClient: true,
      workspaceRoot: "/Users/alice/project",
      hasQuickChatHandler: true,
    }),
    "runtimeUnreachable",
  );

  assert.equal(
    classifyNewSessionDisabledReason({
      runtimeUnreachable: false,
      hasRuntimeClient: true,
      hasWorkspaceRoot: true,
      hasQuickChatHandler: false,
    }),
    "missingQuickChatHandler",
  );

  assert.equal(
    classifyNewSessionDisabledReason({
      runtimeConnecting: true,
      runtimeUnreachable: true,
      hasRuntimeClient: false,
      hasWorkspaceRoot: false,
      hasQuickChatHandler: false,
    }),
    "runtimeConnecting",
  );

  assert.equal(
    classifyNewSessionDisabledReason({
      runtimeUnreachable: false,
      hasRuntimeClient: true,
      workspaceRoot: "/Users/alice/project",
      hasQuickChatHandler: true,
    }),
    "available",
  );
});

test("sanitizeBootstrapDiagnosticPayload redacts secrets, paths, URL queries, and long process output", () => {
  const payload = sanitizeBootstrapDiagnosticPayload({
    token: "secret-token",
    nested: {
      apiKey: "secret-api-key",
      codeVerifier: "oauth-verifier",
      normal: "keep-me",
      message: "Request failed with Authorization: Bearer secret-token-value",
      url: "https://veslo.test/bootstrap?token=abc&workspace=/Users/alice/project",
      homePath: "/Users/alice/project/.opencode/auth.json",
    },
    stdout: "x".repeat(5_000),
    stderr: "y".repeat(5_000),
    tail: "z".repeat(5_000),
  });

  assert.deepEqual(payload.token, "[redacted]");
  assert.deepEqual(payload.nested.apiKey, "[redacted]");
  assert.deepEqual(payload.nested.codeVerifier, "[redacted]");
  assert.equal(payload.nested.normal, "keep-me");
  assert.equal(payload.nested.message, "Request failed with Authorization: Bearer [redacted]");
  assert.equal(payload.nested.url, "https://veslo.test/bootstrap?");
  assert.equal(payload.nested.homePath, "[redacted-home]/project/.opencode/auth.json");
  assert.equal(typeof payload.stdout, "string");
  assert.equal(typeof payload.stderr, "string");
  assert.equal(typeof payload.tail, "string");
  assert.ok(payload.stdout.length < 2_100);
  assert.ok(payload.stderr.length < 2_100);
  assert.ok(payload.tail.length < 2_100);
});

test("normalizeBootstrapDiagnosticsCloudContext trims required native cloud context fields", () => {
  assert.deepEqual(
    normalizeBootstrapDiagnosticsCloudContext({
      denApiBase: " https://den.example.test/ ",
      token: " token-value ",
      userId: " user-1 ",
      orgId: " org-1 ",
      workspaceId: " workspace-1 ",
    }),
    {
      denApiBase: "https://den.example.test/",
      token: "token-value",
      userId: "user-1",
      orgId: "org-1",
      workspaceId: "workspace-1",
    },
  );

  assert.deepEqual(
    normalizeBootstrapDiagnosticsCloudContext({
      denApiBase: "https://den.example.test",
      token: "token-value",
      userId: "user-1",
      orgId: "org-1",
      workspaceId: " ",
    }),
    {
      denApiBase: "https://den.example.test",
      token: "token-value",
      userId: "user-1",
      orgId: "org-1",
    },
  );

  assert.equal(
    normalizeBootstrapDiagnosticsCloudContext({
      denApiBase: "https://den.example.test",
      token: " ",
      userId: "user-1",
      orgId: "org-1",
    }),
    null,
  );
});
