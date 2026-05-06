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
assert.equal(
  source.includes("transaction_not_ready") && source.includes("recoverDesktopAuthTransaction"),
  true,
  "hosted desktop onboarding must recover already-used desktop auth transactions instead of showing transaction_not_ready",
);
assert.equal(
  source.includes("/v2/desktop-auth/status?transactionId="),
  true,
  "hosted desktop onboarding must check desktop auth transaction status during recovery",
);
assert.equal(
  source.includes('status === "authorized"') && source.includes('status === "exchanged"'),
  true,
  "hosted desktop onboarding must treat already-authorized/exchanged transactions as successful states",
);

console.log(JSON.stringify({ ok: true, checks: 9 }));
