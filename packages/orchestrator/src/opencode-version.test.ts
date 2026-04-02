import { describe, expect, test } from "bun:test";

import { reconcileOpencodeVersion } from "./opencode-version.js";

describe("reconcileOpencodeVersion", () => {
  test("does not fail startup when opencode version probing returns no version", () => {
    expect(
      reconcileOpencodeVersion(
        {
          bin: "/tmp/veslo-code",
          source: "bundled",
          expectedVersion: "1.2.25",
        },
        undefined,
      ),
    ).toBeUndefined();
  });

  test("accepts external version mismatches", () => {
    expect(
      reconcileOpencodeVersion(
        {
          bin: "/tmp/opencode",
          source: "external",
          expectedVersion: "1.2.25",
        },
        "1.2.24",
      ),
    ).toBe("1.2.24");
  });

  test("rejects bundled version mismatches", () => {
    expect(() =>
      reconcileOpencodeVersion(
        {
          bin: "/tmp/veslo-code",
          source: "bundled",
          expectedVersion: "1.2.25",
        },
        "1.2.24",
      ),
    ).toThrow("veslo-code version mismatch");
  });
});
