import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../src/app/app.tsx", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../src/app/types.ts", import.meta.url), "utf8");
const denAuthSource = readFileSync(new URL("../src/app/lib/den-auth.ts", import.meta.url), "utf8");

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

console.log(JSON.stringify({ ok: true, checks: 6 }));
