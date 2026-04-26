import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const sourcePath = resolve(process.cwd(), "services/den/public/index.html");
assert.equal(existsSync(sourcePath), true, "hosted desktop onboarding page must exist");

const source = readFileSync(sourcePath, "utf8");

assert.equal(
  source.includes("veslo.desktopAuthContext"),
  true,
  "hosted desktop onboarding must persist desktop auth context in browser storage",
);
assert.equal(
  source.includes("localStorage.getItem"),
  true,
  "hosted desktop onboarding must read local storage for cross-tab desktop auth context restoration",
);
assert.equal(
  source.includes("localStorage.setItem") && source.includes("localStorage.removeItem"),
  true,
  "hosted desktop onboarding must write and clear local storage desktop auth context",
);
assert.equal(
  source.includes("expiresAt"),
  true,
  "hosted desktop onboarding must persist a desktop auth context expiry",
);
assert.equal(
  source.includes("onboardingTransactionId") && source.includes("onboardingState"),
  true,
  "hosted desktop onboarding must track transaction id and state",
);
assert.equal(
  source.includes("clearDesktopAuthContext"),
  true,
  "hosted desktop onboarding must clear restored desktop auth context after completion",
);

console.log(JSON.stringify({ ok: true, checks: 6 }));
