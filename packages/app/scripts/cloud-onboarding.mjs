import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/app/pages/onboarding.tsx", import.meta.url), "utf8");
const workspaceSource = readFileSync(new URL("../src/app/context/workspace.ts", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/app/app.tsx", import.meta.url), "utf8");

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
assert.equal(
  source.includes('props.onboardingStep === "language"'),
  true,
  "onboarding must include first-run language step",
);
assert.equal(
  source.includes("onboarding.language_title"),
  true,
  "onboarding language step must render localized language title",
);
assert.equal(
  workspaceSource.includes('options.setOnboardingStep("language")'),
  true,
  "workspace bootstrap must route first-run users into language onboarding",
);
assert.equal(
  workspaceSource.includes("LANGUAGE_PREF_KEY"),
  true,
  "language onboarding gate must check persisted language preference key",
);
assert.equal(
  appSource.includes('if (onboardingStep() === "language" && !path.startsWith("/onboarding"))'),
  true,
  "router must enter onboarding route when language step is active",
);
assert.equal(
  appSource.includes('if (path.startsWith("/onboarding")) {\n      if (onboardingStep() === "language") {\n        return;\n      }'),
  true,
  "router must not redirect away from onboarding while language step is active",
);
assert.equal(
  /async function onConnectClient\(\)\s*{[\s\S]*options\.setOnboardingStep\("connecting"\)[\s\S]*const ok = await createRemoteWorkspaceFlow\([\s\S]*if \(!ok\)\s*{[\s\S]*options\.setOnboardingStep\("server"\);[\s\S]*return;[\s\S]*}[\s\S]*options\.setOnboardingStep\("server"\);[\s\S]*}/.test(workspaceSource),
  true,
  "server connect flow must clear the transient connecting onboarding step after success or failure",
);

console.log(JSON.stringify({ ok: true, checks: 9 }));
