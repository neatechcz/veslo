import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMissingDocumentRuntime,
  assertPackageInstallStarted,
  parseProbeArgs,
} from "./probe-veslo-server-document-runtime.mjs";

test("compiled document-runtime probe requires one explicit binary", () => {
  assert.throws(() => parseProbeArgs([]), /--binary is required/);
  assert.deepEqual(
    parseProbeArgs(["--binary", "dist/bin/veslo-server", "--timeout-ms", "1234", "--json"]),
    {
      binary: "dist/bin/veslo-server",
      json: true,
      timeoutMs: 1234,
      help: false,
    },
  );
});

test("compiled document-runtime probe rejects a provider import failure", () => {
  assert.throws(
    () => assertMissingDocumentRuntime({
      status: "blocked",
      ready: false,
      repair: {
        available: false,
        inProgress: false,
        blockedReason: "document_runtime_provider_unavailable",
        lastError: "Cannot find module B:\\document-runtime\\src\\index.mjs",
      },
    }),
    /could not load the document-runtime provider/,
  );
});

test("compiled document-runtime probe requires a repairable missing status and nonblocking install start", () => {
  assert.deepEqual(
    assertMissingDocumentRuntime({
      status: "missing",
      ready: false,
      repair: {
        available: true,
        inProgress: false,
        blockedReason: null,
        lastError: "Document runtime active pointer missing",
      },
    }),
    {
      status: "missing",
      ready: false,
      repair: {
        available: true,
        inProgress: false,
        blockedReason: null,
        lastError: "Document runtime active pointer missing",
      },
    },
  );
  assert.equal(
    assertPackageInstallStarted({
      status: "package_installing",
      ready: false,
      repair: {
        available: false,
        inProgress: true,
        blockedReason: null,
        lastError: null,
      },
    }).repair.inProgress,
    true,
  );
});
