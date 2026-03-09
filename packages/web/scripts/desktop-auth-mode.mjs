import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../components/cloud-control.tsx"), "utf-8");

// Desktop onboarding mode is detected from the desktopOnboarding query param
assert.ok(
  source.includes("desktopOnboarding"),
  "cloud-control.tsx must reference the desktopOnboarding query parameter"
);

// Desktop onboarding mode calls the handoff endpoint
assert.ok(
  source.includes("/v1/desktop-auth/handoff"),
  "cloud-control.tsx must call /v1/desktop-auth/handoff in desktop onboarding mode"
);

// Desktop onboarding mode builds the veslo://auth-complete deep link
assert.ok(
  source.includes("veslo://auth-complete"),
  "cloud-control.tsx must build a veslo://auth-complete deep link"
);

// Desktop onboarding mode should NOT call worker token generation in the handoff path
const handoffSection = source.slice(
  source.indexOf("desktopOnboarding"),
  source.indexOf("desktopOnboarding") + 2000
);
assert.ok(
  !handoffSection.includes("handleGenerateKey"),
  "desktop onboarding handoff path must not call worker token generation"
);

console.log("desktop-auth-mode: all assertions passed");
