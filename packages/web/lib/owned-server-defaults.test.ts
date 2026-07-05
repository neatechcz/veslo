import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("web Den proxy defaults to the owned server API", () => {
  const routeSource = readFileSync(new URL("../app/api/den/[...path]/route.ts", import.meta.url), "utf8");

  assert.match(routeSource, /deploymentServiceUrl\("api"/);
  assert.match(routeSource, /NEXT_PUBLIC_VESLO_DEPLOYMENT_DOMAIN/);
});

test("web auth callbacks default to the owned web app", () => {
  const authUrlSource = readFileSync(new URL("auth-urls.ts", import.meta.url), "utf8");

  assert.match(authUrlSource, /deploymentServiceUrl\("app"/);
  assert.match(authUrlSource, /NEXT_PUBLIC_VESLO_DEPLOYMENT_DOMAIN/);
  assert.doesNotMatch(authUrlSource, /app\.veslo\.neatech\.com/);
});

test("web metadata references the owned web app", () => {
  const layoutSource = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");

  assert.match(layoutSource, /app\.veslo\.work/);
  assert.doesNotMatch(layoutSource, /app\.veslo\.neatech\.com/);
});
