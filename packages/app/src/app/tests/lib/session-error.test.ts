import assert from "node:assert/strict";
import test from "node:test";

import { formatSessionError } from "../../lib/session-error.js";

test("invalid_file API errors are mapped to actionable file validation guidance", () => {
  const text = formatSessionError({
    name: "APIError",
    message: "API error (400) The file you uploaded is badly formatted or corrupted. Please fix the file and try again.",
    data: {
      statusCode: 400,
      isRetryable: false,
      responseBody:
        '{"error":{"message":"The file you uploaded is badly formatted or corrupted. Please fix the file and try again.","type":"invalid_request_error","param":"input","code":"invalid_file"}}',
    },
  });

  assert.equal(
    text,
    "Invalid file\nOne of the uploaded files is invalid or corrupted. Replace it with a valid file and try again.",
  );
  assert.equal(text.includes("API error"), false);
  assert.equal(text.includes("Retryable:"), false);
  assert.equal(text.includes("Response:"), false);
});

test("non-file API errors retain standard API diagnostics", () => {
  const text = formatSessionError({
    name: "APIError",
    message: "Request failed with status 429",
    data: {
      statusCode: 429,
      isRetryable: true,
    },
  });

  assert.match(text, /^Rate limit exceeded/);
  assert.match(text, /Retryable: yes/);
});

test("managed Codex credential failures are mapped to actionable AI access guidance", () => {
  const text = formatSessionError({
    name: "APIError",
    message: "AI gateway upstream request failed",
    data: {
      statusCode: 502,
      responseBody: JSON.stringify({
        code: "ai_gateway_upstream_failed",
        message: "AI gateway upstream request failed",
        details: {
          provider: "codex_oauth",
          upstreamStatus: 503,
          upstreamResponse: JSON.stringify({
            error: "no_eligible_codex_credentials",
            reason: "no_eligible_binding",
            provider: "codex_oauth",
          }),
        },
      }),
    },
  });

  assert.equal(
    text,
    [
      "AI access unavailable",
      "No eligible Codex credential is available for your account. Ask an admin to assign or refresh Codex AI access, then retry.",
      "Provider: codex_oauth",
      "Reason: no_eligible_binding",
    ].join("\n"),
  );
  assert.equal(text.includes("Response:"), false);
});

test("managed AI no-endpoint failures use the existing AI access guidance", () => {
  const text = formatSessionError({
    name: "APIError",
    message: "AI gateway upstream request failed",
    data: {
      statusCode: 502,
      responseBody: JSON.stringify({
        code: "ai_gateway_upstream_failed",
        message: "AI gateway upstream request failed",
        details: {
          provider: "codex_oauth",
          upstreamStatus: 503,
          upstreamResponse: JSON.stringify({
            error: "no_eligible_bindings",
            reason: "no_eligible_binding",
            provider: "codex_oauth",
          }),
        },
      }),
    },
  });

  assert.equal(
    text,
    [
      "AI access unavailable",
      "No eligible Codex credential is available for your account. Ask an admin to assign or refresh Codex AI access, then retry.",
      "Provider: codex_oauth",
      "Reason: no_eligible_binding",
    ].join("\n"),
  );
  assert.equal(text.includes("Response:"), false);
});

test("plain assigned Codex credential session failures are mapped to actionable AI access guidance", () => {
  const text = formatSessionError({
    name: "APIError",
    message: "AI gateway upstream request failed",
    data: {
      statusCode: 502,
      responseBody: "assigned_credential_unavailable",
    },
  });

  assert.equal(
    text,
    [
      "AI access unavailable",
      "No eligible Codex credential is available for your account. Ask an admin to assign or refresh Codex AI access, then retry.",
    ].join("\n"),
  );
  assert.equal(text.includes("Response:"), false);
});

test("managed Codex no-binding failures are mapped to actionable AI access guidance", () => {
  const text = formatSessionError({
    name: "APIError",
    message: "AI gateway upstream request failed",
    data: {
      statusCode: 502,
      responseBody: JSON.stringify({
        error: "no_eligible_bindings",
        reason: "no_eligible_binding",
        provider: "codex_oauth",
      }),
    },
  });

  assert.equal(
    text,
    [
      "AI access unavailable",
      "No eligible Codex credential is available for your account. Ask an admin to assign or refresh Codex AI access, then retry.",
      "Provider: codex_oauth",
      "Reason: no_eligible_binding",
    ].join("\n"),
  );
  assert.equal(text.includes("Response:"), false);
});
