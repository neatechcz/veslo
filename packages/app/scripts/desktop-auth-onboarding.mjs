import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../src/app/app.tsx", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../src/app/types.ts", import.meta.url), "utf8");
const denAuthSource = readFileSync(new URL("../src/app/lib/den-auth.ts", import.meta.url), "utf8");
const onboardingSource = readFileSync(new URL("../src/app/pages/onboarding.tsx", import.meta.url), "utf8");

assert.equal(
  typesSource.includes('export type OnboardingStep = "language" | "auth" | "welcome" | "local" | "server" | "connecting";'),
  true,
  "onboarding types must include a dedicated auth step",
);

assert.equal(
  appSource.includes("function parseDesktopAuthCompleteDeepLink(rawUrl: string)"),
  true,
  "desktop app must recognize auth-complete deep links",
);

assert.equal(
  appSource.includes("queueDesktopAuthCompleteDeepLink") && appSource.includes("queueRemoteConnectDeepLink"),
  true,
  "desktop app must keep remote connect handling alongside desktop auth deep links",
);

assert.equal(
  denAuthSource.includes('const DEN_AUTH_STORAGE_KEY = "veslo.den.auth";'),
  true,
  "desktop auth state must be stored under a dedicated den auth key",
);

assert.equal(
  denAuthSource.includes("veslo.server."),
  false,
  "desktop auth state must not reuse veslo.server.* storage",
);

assert.equal(
  appSource.includes("readDenAuthState") && appSource.includes('onboardingStep() === "auth"'),
  true,
  "desktop boot must reference stored den auth state before local onboarding",
);

assert.equal(
  appSource.includes('return readDenAuthState() ? "welcome" : "auth";'),
  true,
  "fresh boot without stored auth must land on the auth onboarding step",
);

assert.equal(
  appSource.includes("validateDenAuthState(storedAuth)") &&
    appSource.includes('setDenAuthError("Your Veslo session expired. Sign in again.");'),
  true,
  "invalid stored auth must be validated and cleared back to sign-in",
);

assert.equal(
  appSource.includes("await bootstrapAfterCloudIdentity();"),
  true,
  "valid desktop auth must continue into the normal local bootstrap",
);

assert.equal(
  onboardingSource.includes('props.onboardingStep === "auth"') &&
    onboardingSource.includes("Sign in to Veslo"),
  true,
  "onboarding UI must render a dedicated Sign in to Veslo step",
);

console.log(JSON.stringify({ ok: true, checks: 10 }));
