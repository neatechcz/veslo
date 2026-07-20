import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  maybeStartWindowsSandboxAutoPrepare,
  resolveWindowsSandboxRepairPolicy,
  WINDOWS_WSL_SANDBOX_RUNTIME_ENABLED,
} from "../../lib/windows-sandbox-repair-policy.js";

const settingsSource = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");
const onboardingSource = readFileSync(new URL("../../pages/onboarding.tsx", import.meta.url), "utf8");

test("Windows installer policy never starts WSL sandbox repair", () => {
  let wslInvokes = 0;
  const policies = [
    { isWindowsDesktop: true, preferences: { sharedUnsandboxedEngine: true } },
    { isWindowsDesktop: true, preferences: { sharedUnsandboxedEngine: false } },
    { isWindowsDesktop: true, preferences: { sharedUnsandboxedEngine: true }, supportFlow: true },
    { isWindowsDesktop: false, preferences: { sharedUnsandboxedEngine: false } },
  ];

  assert.equal(WINDOWS_WSL_SANDBOX_RUNTIME_ENABLED, false);
  for (const input of policies) {
    const policy = resolveWindowsSandboxRepairPolicy(input);
    maybeStartWindowsSandboxAutoPrepare(policy, () => {
      wslInvokes += 1;
    });
    assert.equal(policy, "hidden");
  }
  assert.equal(wslInvokes, 0);
});

test("onboarding and settings do not mount the dormant WSL repair component", () => {
  assert.doesNotMatch(settingsSource, /WindowsSandboxRepair/);
  assert.doesNotMatch(onboardingSource, /WindowsSandboxRepair/);
});
