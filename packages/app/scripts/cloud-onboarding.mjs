import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/app/pages/onboarding.tsx", import.meta.url), "utf8");

assert.equal(
  source.includes("if (CLOUD_ONLY_MODE)"),
  true,
  "onboarding must include an explicit cloud-only render gate",
);
assert.equal(
  source.includes('props.onboardingStep === "server"'),
  true,
  "onboarding must retain remote server flow",
);

console.log(JSON.stringify({ ok: true, checks: 2 }));
