import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

describe("owned server defaults", () => {
  test("orchestrator managed AI defaults to the owned gateway", () => {
    const cliSource = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

    expect(cliSource).toContain('const DEFAULT_MANAGED_AI_BASE_URL = "https://ai.veslo.work";');
  });
});
