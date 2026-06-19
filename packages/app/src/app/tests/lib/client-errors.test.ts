import assert from "node:assert/strict";
import test from "node:test";

import { describeRequestError } from "../../lib/client-errors.js";

test("managed Codex credential request failures are mapped to actionable AI access guidance", () => {
  const text = describeRequestError(
    {
      message: "AI gateway upstream request failed",
      statusCode: 502,
      responseBody: JSON.stringify({
        code: "ai_gateway_upstream_failed",
        message: "AI gateway upstream request failed",
        details: {
          provider: "codex_oauth",
          upstreamStatus: 503,
          upstreamResponse: JSON.stringify({
            error: "no_eligible_codex_credentials",
            reason: "all_codex_credentials_exhausted",
            provider: "codex_oauth",
          }),
        },
      }),
    },
    "Request failed",
  );

  assert.equal(
    text,
    [
      "AI access unavailable",
      "All managed Codex credentials are currently exhausted. Wait for quota to reset or ask an admin to assign a healthy credential, then retry.",
      "Provider: codex_oauth",
      "Reason: all_codex_credentials_exhausted",
    ].join("\n"),
  );
});

test("plain assigned Codex credential request failures are mapped to actionable AI access guidance", () => {
  const text = describeRequestError(
    {
      message: "AI gateway upstream request failed",
      statusCode: 502,
      responseBody: "assigned_credential_unavailable",
    },
    "Request failed",
  );

  assert.equal(
    text,
    [
      "AI access unavailable",
      "No eligible Codex credential is available for your account. Ask an admin to assign or refresh Codex AI access, then retry.",
    ].join("\n"),
  );
});
