import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../components/cloud-control.tsx", import.meta.url), "utf8");

assert.equal(
  source.includes('const DESKTOP_ONBOARDING_QUERY_KEY = "desktopOnboarding";'),
  true,
  "cloud control must recognize a desktop onboarding query flag",
);

assert.equal(
  source.includes('"/v1/desktop-auth/handoff"'),
  true,
  "desktop onboarding must request a handoff code from Den",
);

assert.equal(
  source.includes("veslo://auth-complete?"),
  true,
  "desktop onboarding must build an auth-complete deep link",
);

assert.equal(
  source.includes('if (desktopOnboarding) {\n      return;\n    }\n\n    if (orgsBusy) {'),
  true,
  "desktop onboarding must bypass cloud worker loading",
);

console.log(JSON.stringify({ ok: true, checks: 4 }));
