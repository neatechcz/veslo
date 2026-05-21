import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("web Den proxy defaults to the owned server API", () => {
  const routeSource = readFileSync(new URL("../app/api/den/[...path]/route.ts", import.meta.url), "utf8");

  assert.match(routeSource, /const DEFAULT_API_BASE = "https:\/\/api\.veslo\.work";/);
  assert.match(routeSource, /const DEFAULT_AUTH_ORIGIN = "https:\/\/api\.veslo\.work";/);
});
