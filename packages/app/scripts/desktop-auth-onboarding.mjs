import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

// ── a. den-auth.ts module ───────────────────────────────────────────────

const denAuthPath = new URL("../src/app/lib/den-auth.ts", import.meta.url);
assert.equal(existsSync(denAuthPath), true, "den-auth.ts module must exist");

const denAuth = readFileSync(denAuthPath, "utf8");

assert.equal(
  denAuth.includes("readDenAuth"),
  true,
  "den-auth must export readDenAuth function",
);
assert.equal(
  denAuth.includes("writeDenAuth"),
  true,
  "den-auth must export writeDenAuth function",
);
assert.equal(
  denAuth.includes("clearDenAuth"),
  true,
  "den-auth must export clearDenAuth function",
);
assert.equal(
  denAuth.includes("parseAuthCompleteDeepLink"),
  true,
  "den-auth must export parseAuthCompleteDeepLink function",
);
assert.equal(
  denAuth.includes("exchangeHandoffCode"),
  true,
  "den-auth must export exchangeHandoffCode function",
);
assert.equal(
  denAuth.includes("veslo.den.auth"),
  true,
  "den-auth must use veslo.den.auth storage key (separate from veslo.server.*)",
);
assert.equal(
  denAuth.includes("veslo.server"),
  false,
  "den-auth must NOT reference veslo.server storage namespace",
);

// ── b. types.ts – "auth" onboarding step ────────────────────────────────

const types = readFileSync(new URL("../src/app/types.ts", import.meta.url), "utf8");

assert.equal(
  /OnboardingStep\b[^;]*"auth"/.test(types),
  true,
  'types.ts OnboardingStep must include the "auth" step',
);

// ── c. app.tsx – auth-complete deep link handling ───────────────────────

const app = readFileSync(new URL("../src/app/app.tsx", import.meta.url), "utf8");

assert.equal(
  app.includes("parseAuthCompleteDeepLink"),
  true,
  "app.tsx must import parseAuthCompleteDeepLink",
);
assert.equal(
  app.includes("queueAuthCompleteDeepLink"),
  true,
  "app.tsx must contain auth-complete deep link handling",
);

// Isolate the handler function to verify it is free of veslo.server refs
const handlerStart = app.indexOf("const queueAuthCompleteDeepLink");
const handlerEnd = app.indexOf("};", handlerStart);
assert.ok(handlerStart > -1, "queueAuthCompleteDeepLink handler must exist in app.tsx");
const handlerSection = app.slice(handlerStart, handlerEnd + 2);
assert.equal(
  handlerSection.includes("veslo.server"),
  false,
  "auth-complete handler must NOT contain veslo.server references",
);

// ── d. workspace.ts – den auth integration ──────────────────────────────

const workspace = readFileSync(new URL("../src/app/context/workspace.ts", import.meta.url), "utf8");

assert.equal(
  workspace.includes("readDenAuth"),
  true,
  "workspace.ts must reference readDenAuth for identity bootstrap",
);
assert.equal(
  workspace.includes("clearDenAuth"),
  true,
  "workspace.ts must reference clearDenAuth for invalid auth fallback",
);

// ── done ────────────────────────────────────────────────────────────────
console.log(JSON.stringify({ ok: true, checks: 13 }));
