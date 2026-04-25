import assert from "node:assert/strict";
import test from "node:test";

import {
  hasExplicitLiveFeedbackDenAuth,
  isLoopbackDenApiBase,
  parseSafeDenAuthSummary,
  shouldRepairDenAuthForLiveFeedback,
} from "./live-feedback-den-auth.js";

test("isLoopbackDenApiBase detects local Den endpoints", () => {
  assert.equal(isLoopbackDenApiBase("http://127.0.0.1:65258"), true);
  assert.equal(isLoopbackDenApiBase("https://localhost:8788"), true);
  assert.equal(isLoopbackDenApiBase("http://[::1]:8788"), true);
  assert.equal(isLoopbackDenApiBase("https://den-control-plane-veslo.onrender.com"), false);
});

test("parseSafeDenAuthSummary returns non-sensitive auth metadata", () => {
  const summary = parseSafeDenAuthSummary(JSON.stringify({
    denApiBase: "https://den.example",
    token: "secret-token",
    orgId: "org-1",
    user: { email: "user@example.com" },
  }));

  assert.deepEqual(summary, {
    denApiBase: "https://den.example",
    orgId: "org-1",
    userEmail: "user@example.com",
    hasToken: true,
  });
});

test("shouldRepairDenAuthForLiveFeedback requires a usable non-loopback replacement", () => {
  assert.equal(
    shouldRepairDenAuthForLiveFeedback(
      { denApiBase: "http://127.0.0.1:65258", orgId: "org-e2e", userEmail: "feedback@example.com", hasToken: true },
      { denApiBase: "https://den.example", orgId: "org-1", userEmail: "user@example.com", hasToken: true },
    ),
    true,
  );

  assert.equal(
    shouldRepairDenAuthForLiveFeedback(
      { denApiBase: "http://127.0.0.1:65258", orgId: "org-e2e", userEmail: "feedback@example.com", hasToken: true },
      { denApiBase: "http://127.0.0.1:8788", orgId: "org-1", userEmail: "user@example.com", hasToken: true },
    ),
    false,
  );
});

test("hasExplicitLiveFeedbackDenAuth treats provided E2E auth as authoritative", () => {
  assert.equal(hasExplicitLiveFeedbackDenAuth({ E2E_DEN_AUTH_JSON: "{\"token\":\"secret\"}" }), true);
  assert.equal(hasExplicitLiveFeedbackDenAuth({ E2E_DEN_AUTH_JSON: "   " }), false);
  assert.equal(hasExplicitLiveFeedbackDenAuth({}), false);
});
