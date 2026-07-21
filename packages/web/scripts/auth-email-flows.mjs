import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../components/cloud-control.tsx"), "utf8");
const authErrorMessageSource = readFileSync(resolve(here, "../lib/auth-error-message.ts"), "utf8");
const signupInvitationSource = readFileSync(resolve(here, "../lib/signup-invitation.ts"), "utf8");
const layoutSource = readFileSync(resolve(here, "../app/layout.tsx"), "utf8");
const verifyEmailPageSource = readFileSync(resolve(here, "../app/verify-email/page.tsx"), "utf8");

assert.ok(existsSync(resolve(here, "../app/forgot-password/page.tsx")), "forgot-password page must exist");
assert.ok(existsSync(resolve(here, "../app/reset-password/page.tsx")), "reset-password page must exist");
assert.ok(existsSync(resolve(here, "../app/verify-email/page.tsx")), "verify-email page must exist");

assert.ok(
  source.includes("emailVerified"),
  "cloud-control.tsx must track email verification state on the signed-in user",
);
assert.ok(
  source.includes("/api/auth/send-verification-email"),
  "cloud-control.tsx must support resend verification",
);
assert.ok(
  source.includes("/forgot-password"),
  "cloud-control.tsx must expose a forgot-password entry point",
);
assert.ok(
  source.includes("email_verification_required"),
  "cloud-control.tsx must handle verified-email gating responses",
);
assert.ok(
  verifyEmailPageSource.includes("desktopOnboarding") &&
    verifyEmailPageSource.includes("URLSearchParams"),
  "verify-email page must detect desktop onboarding handoff state",
);
assert.ok(
  verifyEmailPageSource.includes('buildAuthCallbackUrl("/")'),
  "verify-email page must route desktop verification back into the canonical onboarding page",
);
assert.ok(
  !verifyEmailPageSource.includes("/v1/desktop-auth/handoff"),
  "verify-email page must not fork its own desktop handoff request",
);
assert.ok(
  !verifyEmailPageSource.includes("veslo://auth-complete"),
  "verify-email page must not build the desktop deep link directly",
);
assert.ok(
  source.includes("&transactionId="),
  "cloud-control desktop auth deep link must include transactionId",
);
assert.ok(
  source.includes('import { getAuthErrorMessage } from "../lib/auth-error-message";') &&
    source.includes("getAuthErrorMessage(payload,"),
  "cloud-control.tsx must use the shared auth error message helper",
);
assert.ok(
  !source.includes("function getErrorMessage("),
  "cloud-control.tsx must not retain a local auth error message helper",
);
assert.ok(
  authErrorMessageSource.includes('payload.code === "domain_not_allowed"') &&
    authErrorMessageSource.includes('payload.error === "domain_not_allowed"') &&
    authErrorMessageSource.includes('payload.message === "domain_not_allowed"'),
  "auth error helper must recognize domain_not_allowed across stable response fields",
);
assert.ok(
  authErrorMessageSource.includes(
    "Use your company email to register. Personal email addresses are not supported. If your organization invited you, open the registration link from that invitation.",
  ),
  "auth error helper must explain the company-email requirement and invitation exception",
);
assert.ok(
  layoutSource.indexOf('id="signup-invitation"') !== -1 &&
    layoutSource.indexOf('id="signup-invitation"') < layoutSource.indexOf('id="posthog"'),
  "invitation capture must execute before PostHog initialization",
);
assert.ok(
  signupInvitationSource.includes('window.sessionStorage') &&
    !signupInvitationSource.includes('window.localStorage'),
  "invitation bootstrap must use session storage only",
);
assert.ok(
  source.includes("const submittedMode = authMode;") &&
    source.includes("submittedMode === \"sign-up\"") &&
    !/(?:const endpoint =|mode:|getAuthInfoForMode\()authMode/.test(
      source.slice(source.indexOf("async function handleAuthSubmit"), source.indexOf("async function handleResendVerificationEmail")),
    ),
  "email auth submission must stay bound to the immutable submitted mode",
);
assert.ok(
  source.includes("readStoredSignupInvitation(window.sessionStorage)") &&
    source.includes("inviteToken: signupInviteToken"),
  "email signup must read and submit the session invitation token",
);
assert.ok(
  source.includes("additionalData: { vesloSignupInviteToken: signupInviteToken }") &&
    source.includes("errorCallbackURL: getGithubErrorCallbackUrl()"),
  "GitHub signup must send the invitation through OAuth state and use a marked error callback",
);
assert.ok(
  source.includes("parseGitHubAuthCallbackUrl(window.location.href)") &&
    source.includes('reason: "callback_error"'),
  "marked GitHub callback errors must be rendered and tracked without token data",
);
assert.ok(
  source.includes("clearStoredSignupInvitation(window.sessionStorage)") &&
    source.includes("window.history.replaceState({}, \"\", callbackError.scrubbedUrl)"),
  "successful signup must clear invitation state and callback errors must be scrubbed",
);
assert.ok(
  source.includes('className="ow-link"') && source.includes("disabled={authBusy}"),
  "auth mode toggle must be disabled while authentication is busy",
);

console.log("auth-email-flows: all assertions passed");
