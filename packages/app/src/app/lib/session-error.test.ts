import assert from "node:assert/strict";
import test from "node:test";

import { formatSessionError } from "./session-error.js";

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
