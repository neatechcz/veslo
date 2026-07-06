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
const denDesktopAuthWorkflow = readFileSync(
  new URL("../src/app/context/den-desktop-auth-workflow.ts", import.meta.url),
  "utf8",
);
const appStartupHydration = readFileSync(
  new URL("../src/app/context/app-startup-hydration.ts", import.meta.url),
  "utf8",
);

assert.match(
  denDesktopAuthWorkflow,
  /import\s+\{[\s\S]*\bparseAuthCompleteDeepLink\b[\s\S]*\}\s+from\s+["']\.\.\/lib\/den-auth["'];/,
  "desktop auth deep-link parsing must stay wired through the den desktop auth workflow",
);
assert.match(
  denDesktopAuthWorkflow,
  /\bparseAuthCompleteDeepLink\(rawUrl\)|\bparseAuthCompleteDeepLink\s*:/,
  "desktop auth deep-link parsing must stay wired through the den desktop auth workflow",
);
assert.equal(
  app.includes("queueAuthCompleteDeepLink"),
  true,
  "app.tsx must contain auth-complete deep link handling",
);
assert.equal(
  denDesktopAuthWorkflow.includes("readPendingDesktopAuthSession"),
  true,
  "desktop auth workflow must reuse pending desktop auth session data for retry/resume flows",
);
assert.equal(
  appStartupHydration.includes("startDesktopAuthStatusPolling"),
  false,
  "desktop startup hydration must not auto-resume desktop browser auth polling on startup",
);
assert.equal(
  appStartupHydration.includes("const hydrationPromise = hydrateDenAuthFromDesktopSnapshot().catch(() => false)"),
  true,
  "startup hydration must preserve the desktop auth hydration promise for slow-start recovery",
);
assert.equal(
  appStartupHydration.includes("if (!imported || deps.onboardingStep() !== \"auth\")"),
  true,
  "startup hydration must retry onboarding only when delayed desktop auth hydration arrives after the auth gate",
);
assert.equal(
  denDesktopAuthWorkflow.includes("options.ui.setOnboardingStep(\"connecting\");\n          options.ui.setView(\"onboarding\");"),
  true,
  "desktop auth workflow must leave the auth gate immediately after a successful desktop browser sign-in",
);
assert.equal(
  appStartupHydration.includes("deps.setOnboardingStep(\"connecting\");\n        deps.setBooting(true);"),
  true,
  "startup hydration must switch delayed desktop auth recovery from auth to connecting before retrying bootstrap",
);

// Isolate the handler function to verify it is free of veslo.server refs
const handlerStart = denDesktopAuthWorkflow.indexOf("const queueAuthCompleteDeepLink");
const handlerEnd = denDesktopAuthWorkflow.indexOf("};", handlerStart);
assert.ok(handlerStart > -1, "queueAuthCompleteDeepLink handler must exist in the desktop auth workflow");
const handlerSection = denDesktopAuthWorkflow.slice(handlerStart, handlerEnd + 2);
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

// ── e. onboarding.tsx – Veslo browser auth copy ────────────────────────

const onboarding = readFileSync(new URL("../src/app/pages/onboarding.tsx", import.meta.url), "utf8");
const enLocale = readFileSync(new URL("../src/i18n/locales/en.ts", import.meta.url), "utf8");

assert.equal(
  onboarding.includes('__vesloT("ui.literal.sign_in_to_veslo_jyklev"') &&
    enLocale.includes('"ui.literal.sign_in_to_veslo_jyklev": "Sign in to Veslo"'),
  true,
  "desktop onboarding must brand browser auth entry as Veslo",
);
assert.equal(
  onboarding.includes('__vesloT("ui.literal.sign_in_with_your_account_to_continue_setup__e22ry2"') &&
    enLocale.includes("Email verification and password recovery happen in the browser."),
  true,
  "desktop onboarding must explain that verification and password recovery happen in the browser flow",
);
assert.equal(
  onboarding.includes("Sign in to Openwork"),
  false,
  "desktop onboarding must not keep the old Openwork auth heading",
);

// ── done ────────────────────────────────────────────────────────────────
console.log(JSON.stringify({ ok: true, checks: 22 }));
