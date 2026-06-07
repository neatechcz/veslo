import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { reconcileOpencodeVersion } from "./opencode-version.js";

type PackageJson = {
  opencodeVersion?: string;
  dependencies?: Record<string, string>;
};

function readPackageJson(url: URL): PackageJson {
  return JSON.parse(readFileSync(url, "utf8")) as PackageJson;
}

describe("reconcileOpencodeVersion", () => {
  test("does not fail startup when opencode version probing returns no version", () => {
    expect(
      reconcileOpencodeVersion(
        {
          bin: "/tmp/veslo-code",
          source: "bundled",
          expectedVersion: "1.3.13",
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
          expectedVersion: "1.3.13",
        },
        "1.3.12",
      ),
    ).toBe("1.3.12");
  });

  test("rejects bundled version mismatches", () => {
    expect(() =>
      reconcileOpencodeVersion(
        {
          bin: "/tmp/veslo-code",
          source: "bundled",
          expectedVersion: "1.3.13",
        },
        "1.3.12",
      ),
    ).toThrow("veslo-code version mismatch");
  });

  test("pins managed OpenCode runtime and SDK packages to the verified runtime version", () => {
    const desktop = readPackageJson(new URL("../../desktop/package.json", import.meta.url));
    const orchestrator = readPackageJson(new URL("../package.json", import.meta.url));
    const app = readPackageJson(new URL("../../app/package.json", import.meta.url));
    const opencodeRouter = readPackageJson(new URL("../../opencode-router/package.json", import.meta.url));

    expect(desktop.opencodeVersion).toBe("1.16.2");
    expect(orchestrator.opencodeVersion).toBe("1.16.2");
    expect(orchestrator.dependencies?.["@opencode-ai/sdk"]).toBe("1.16.2");
    expect(app.dependencies?.["@opencode-ai/sdk"]).toBe("1.16.2");
    expect(opencodeRouter.dependencies?.["@opencode-ai/sdk"]).toBe("1.16.2");
  });
});
