import assert from "node:assert/strict";
import test from "node:test";

import { getAuthErrorMessage } from "./auth-error-message";

const COMPANY_EMAIL_MESSAGE =
  "Use your company email to register. Personal email addresses are not supported. If your organization invited you, open the registration link from that invitation.";

test("maps domain_not_allowed from each supported object field", () => {
  for (const field of ["code", "error", "message"] as const) {
    assert.equal(
      getAuthErrorMessage({ [field]: "domain_not_allowed" }, "Fallback"),
      COMPANY_EMAIL_MESSAGE,
    );
  }
});

test("maps domain_not_allowed before returning another object message", () => {
  assert.equal(
    getAuthErrorMessage(
      { code: "domain_not_allowed", message: "Domain is not allowed" },
      "Fallback",
    ),
    COMPANY_EMAIL_MESSAGE,
  );
});

test("requires an exact domain_not_allowed field value", () => {
  assert.equal(
    getAuthErrorMessage({ message: "domain_not_allowed_extra" }, "Fallback"),
    "domain_not_allowed_extra",
  );
  assert.equal(
    getAuthErrorMessage({ error: " domain_not_allowed " }, "Fallback"),
    " domain_not_allowed ",
  );
  assert.equal(getAuthErrorMessage("domain_not_allowed", "Fallback"), "domain_not_allowed");
});

test("preserves ordinary object message and error precedence", () => {
  assert.equal(
    getAuthErrorMessage({ message: "  Message text  ", error: "Error text" }, "Fallback"),
    "  Message text  ",
  );
  assert.equal(
    getAuthErrorMessage({ message: "  ", error: "  Error text  " }, "Fallback"),
    "  Error text  ",
  );
});

test("preserves bounded string payloads", () => {
  assert.equal(getAuthErrorMessage("  Backend error  ", "Fallback"), "Backend error");
});

test("sanitizes HTML and long non-JSON payloads", () => {
  assert.equal(
    getAuthErrorMessage("  <!DOCTYPE html><body>failure</body>  ", "Fallback"),
    "Fallback Upstream returned an HTML error page.",
  );
  assert.equal(
    getAuthErrorMessage("x".repeat(241), "Fallback"),
    "Fallback Upstream returned a non-JSON error payload.",
  );
});

test("uses the fallback for empty or invalid payloads", () => {
  for (const payload of ["", "   ", null, undefined, 0, false, [], {}, { message: "", error: "" }]) {
    assert.equal(getAuthErrorMessage(payload, "Fallback"), "Fallback");
  }
});
